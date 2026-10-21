'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 8 (FUSION_REMEDIATION_PLAN.md), audit S3: an Advanced I/O request
// is limited to 30 s, but only fast-recover's SLA stage had a deadline. With
// CRON_WORK_BUDGET_MS set (unset = no budget, as before) the outbound retry,
// inbound replay and reconciliation sweeps stop STARTING work once the
// budget from the start of the cron request is spent; what they did not
// reach stays queued for the next run, untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const dealerReconciliationService = require('../services/integrations/dealerReconciliationService');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const integrationAlertBatchService = require('../services/integrations/integrationAlertBatchService');
const cronRoutes = require('../routes/cronRoutes');
const { getCronWorkBudgetMs } = require('../config/env');

function withBudget(t, value) {
  const before = process.env.CRON_WORK_BUDGET_MS;
  if (value === null) delete process.env.CRON_WORK_BUDGET_MS; else process.env.CRON_WORK_BUDGET_MS = value;
  t.after(() => { if (before === undefined) delete process.env.CRON_WORK_BUDGET_MS; else process.env.CRON_WORK_BUDGET_MS = before; });
}

const PAST = () => Date.now() - 1;
const FUTURE = () => Date.now() + 60000;

test('CRON_WORK_BUDGET_MS: unset or not a positive whole number means no budget', (t) => {
  for (const value of [null, '', '0', '-1', 'soon', '2.5']) {
    withBudget(t, value);
    assert.equal(getCronWorkBudgetMs(), null, String(value));
  }
  process.env.CRON_WORK_BUDGET_MS = '25000';
  assert.equal(getCronWorkBudgetMs(), 25000);
});

// ---- the sweeps --------------------------------------------------------------

function outboundDb(count) {
  return createInMemoryZcql({
    dealer_integrations: [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED', integration_type: 'EXTERNAL_CRM' }],
    lead_integrations: Array.from({ length: count }, (_, i) => ({
      zoho_lead_id: `Z${i}`, dealer_code: 'AU008', integration_id: '1000', sync_status: 'FAILED', retry_count: '1',
    })),
    leads: Array.from({ length: count }, (_, i) => ({ crm_record_id: `Z${i}`, dealer_code: 'AU008', lead_status: 'Not Contacted' })),
    integration_logs: [],
  });
}

test('outbound retry: a spent budget starts no delivery and reports what was deferred', async (t) => {
  _resetForTests();
  const sync = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const db = outboundDb(3);
  const results = await outboundRetryScheduler.runOutboundRetrySweep(db.app, { ignoreSchedule: true, deadline: PAST() });
  assert.equal(sync.mock.callCount(), 0);
  assert.equal(results.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(results.deferredUnknown, true);
  assert.equal(db.queries.length, 0);
});

test('outbound retry: with time left, or no deadline, every due lead is delivered as before', async (t) => {
  for (const deadline of [FUTURE(), undefined]) {
    _resetForTests();
    const sync = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({ ok: true }));
    const results = await outboundRetryScheduler.runOutboundRetrySweep(outboundDb(3).app, { ignoreSchedule: true, deadline });
    assert.equal(sync.mock.callCount(), 3, String(deadline));
    assert.equal(results.deferred ?? 0, 0);
    sync.mock.restore();
  }
});

function inboundDb() {
  return createInMemoryZcql({
    dealer_integrations: [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', integration_type: 'EXTERNAL_CRM', inbound_enabled: true }],
    lead_integrations: [{ integration_id: '1000', external_crm_lead_id: 'D1', zoho_lead_id: 'Z1', sync_status: 'SYNCED' }],
    integration_status_mappings: [],
    integration_logs: [{
      integration_id: '1000', external_lead_id: 'D1', happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
      error_message: 'MG_WRITE_BACK_FAILED:TRANSPORT', CREATEDTIME: '2026-10-01 09:00:00:000', MODIFIEDTIME: '2026-10-01 09:00:00:000',
    }],
  });
}

test('inbound replay: a spent budget replays nothing; the held row stays as it was', async (t) => {
  _resetForTests();
  const replay = t.mock.method(crmIntegrationService, 'replayInboundLead', async () => ({ ok: true }));
  const db = inboundDb();
  const results = await inboundReplayScheduler.runInboundReplaySweep(db.app, { deadline: PAST() });
  assert.equal(replay.mock.callCount(), 0);
  assert.equal(results.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(results.deferredUnknown, true);
  assert.equal(db.queries.length, 0);
  assert.equal(db.tables.integration_logs[0].status, 'FAILED');
});

test('inbound replay: no deadline replays as before', async (t) => {
  _resetForTests();
  const replay = t.mock.method(crmIntegrationService, 'replayInboundLead', async () => ({ ok: true }));
  await inboundReplayScheduler.runInboundReplaySweep(inboundDb().app);
  assert.equal(replay.mock.callCount(), 1);
});

test('reconciliation: a spent budget reads nothing from dealers', async (t) => {
  _resetForTests();
  let reads = 0;
  t.mock.method(crmAdapterFactory, 'getAdapter', () => ({ getLead: async () => { reads += 1; return { raw: { data: [{}] } }; } }));
  const db = createInMemoryZcql({
    lead_integrations: [
      { integration_id: '1000', dealer_code: 'AU008', external_crm_lead_id: 'D1', zoho_lead_id: 'Z1', sync_status: 'SYNCED' },
      { integration_id: '1000', dealer_code: 'AU008', external_crm_lead_id: 'D2', zoho_lead_id: 'Z2', sync_status: 'SYNCED' },
    ],
    dealer_integrations: [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', integration_type: 'EXTERNAL_CRM', status: 'CONNECTED' }],
    leads: [],
    integration_logs: [],
  });
  const results = await dealerReconciliationService.runDealerReconciliation(db.app, { deadline: PAST() });
  assert.equal(reads, 0);
  assert.equal(results.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(results.deferredUnknown, true);
  assert.equal(db.queries.length, 0);
});

// ---- cron wiring ------------------------------------------------------------

async function callCron(t, path) {
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret';
  const seen = {};
  t.mock.method(outboundRetryScheduler, 'runOutboundRetrySweep', async (app, options) => { seen.outbound = options; return { recovered: 0 }; });
  t.mock.method(inboundReplayScheduler, 'runInboundReplaySweep', async (app, options) => { seen.inbound = options; return {}; });
  t.mock.method(dealerReconciliationService, 'runDealerReconciliation', async (app, options) => { seen.reconcile = options; return {}; });
  t.mock.method(slaMonitorService, 'runSlaSweep', async (_app, _now, options) => { seen.sla = options; return {}; });
  t.mock.method(integrationAlertBatchService, 'flushIfWindowElapsed', async (_app, options) => { seen.alert = options; return {}; });
  t.mock.method(catalyst, 'initialize', () => ({}));
  const server = express();
  server.use(express.json());
  server.use(cronRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const startedAt = Date.now();
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': process.env.CRON_SECRET },
    body: '{}',
  });
  assert.equal(response.status, 200);
  return { seen, startedAt };
}

test('budget set: fast-recover gives every stage the same deadline, from the start of the request', async (t) => {
  withBudget(t, '25000');
  const { seen, startedAt } = await callCron(t, '/cron/fast-recover');
  assert.ok(seen.outbound.deadline >= startedAt + 24000 && seen.outbound.deadline <= Date.now() + 25000);
  assert.equal(seen.inbound.deadline, seen.outbound.deadline);
  assert.equal(seen.sla.deadline, seen.outbound.deadline);
  assert.equal(seen.alert.deadline, seen.outbound.deadline);
});

test('budget set: the dedicated retry, replay and reconcile crons get a deadline too', async (t) => {
  withBudget(t, '25000');
  const outbound = await callCron(t, '/cron/retry-outbound-syncs');
  assert.ok(outbound.seen.outbound.deadline > outbound.startedAt);
  t.mock.restoreAll();
  const inbound = await callCron(t, '/cron/replay-inbound-events');
  assert.ok(inbound.seen.inbound.deadline > inbound.startedAt);
  t.mock.restoreAll();
  const reconcile = await callCron(t, '/cron/reconcile-dealer-leads');
  assert.ok(reconcile.seen.reconcile.deadline > reconcile.startedAt);
});

test('budget unset: fast-recover still shares a bounded deadline across every stage', async (t) => {
  withBudget(t, null);
  const { seen } = await callCron(t, '/cron/fast-recover');
  assert.ok(Number.isFinite(seen.outbound.deadline));
  assert.equal(seen.inbound.deadline, seen.outbound.deadline);
  assert.equal(seen.sla.deadline, seen.outbound.deadline);
  assert.equal(seen.alert.deadline, seen.outbound.deadline);
});
