'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 7 (FUSION_REMEDIATION_PLAN.md), audit C3 / Q4 / Q24: a dealer that
// cannot report progress back cannot be blamed for not progressing. A Fusion
// SD dealer is left out of the dealer-action SLA (Unhappy 10) until its
// return channel is proven: inbound on, FUSION_INBOUND_V2 on, a signing
// secret stored, and at least one signed Fusion webhook processed
// successfully. Other CRM types are judged exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const oemCrmService = require('../services/zohoCrmService');
const slaMonitorService = require('../services/integrations/slaMonitorService');

const NOW = Date.parse('2026-10-13T06:00:00Z');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const OVERDUE = utc(NOW - 3 * 24 * 3600 * 1000);

// Integration ROWIDs are positional: 1000 = AU008 (Zoho), 1001 = Buckby (Fusion).
function setup(t, { v2 = 'true', inbound = true, signingSecret = true, webhookEvents } = {}) {
  _resetForTests();
  const before = process.env.FUSION_INBOUND_V2;
  if (v2 === null) delete process.env.FUSION_INBOUND_V2; else process.env.FUSION_INBOUND_V2 = v2;
  t.after(() => { if (before === undefined) delete process.env.FUSION_INBOUND_V2; else process.env.FUSION_INBOUND_V2 = before; });

  const db = createInMemoryZcql({
    dealer_integrations: [
      { dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED', inbound_enabled: true },
      { dealer_code: '725001', crm_type: 'FUSION_SD', status: 'ACTIVE', inbound_enabled: inbound },
    ],
    lead_integrations: [
      { zoho_lead_id: 'Z-AU008', dealer_code: 'AU008', integration_id: '1000', sync_status: 'SYNCED', last_synced_at: OVERDUE },
      { zoho_lead_id: 'Z-BUCKBY', dealer_code: '725001', integration_id: '1001', sync_status: 'SYNCED', last_synced_at: OVERDUE },
    ],
    leads: [
      { crm_record_id: 'Z-AU008', lead_status: 'Not Contacted', sync_status: 'SYNCED' },
      { crm_record_id: 'Z-BUCKBY', lead_status: 'Not Contacted', sync_status: 'SYNCED' },
    ],
    webhook_events: webhookEvents ?? [
      { integration_id: '1001', event_id: 'msg_1', processing_status: 'SUCCESS' },
    ],
    outbound_sync_claims: [],
  });
  t.mock.method(integrationAuthService, 'hasCredential', async (app, id, type) =>
    signingSecret && String(id) === '1001' && type === 'WEBHOOK_SIGNING_SECRET');
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({ status: 'success' }));
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  return db;
}

const sweep = (db) => slaMonitorService.runSlaSweep(db.app, new Date(NOW), { clock: () => 0 });
const statusOf = (db, lead) => db.tables.lead_integrations.find((m) => m.zoho_lead_id === lead).sync_status;

test('a Fusion dealer with a proven return channel is judged like any other dealer', async (t) => {
  const db = setup(t);
  const results = await sweep(db);
  assert.equal(statusOf(db, 'Z-BUCKBY'), 'SLA_BREACH');
  assert.equal(statusOf(db, 'Z-AU008'), 'SLA_BREACH');
  assert.equal(results.breached, 2);
  assert.deepEqual(results.exemptNoReturnChannel, []);
});

for (const [label, options, reason] of [
  ['inbound is off', { inbound: false }, 'INBOUND_OFF'],
  ['FUSION_INBOUND_V2 is off', { v2: null }, 'FUSION_INBOUND_V2_OFF'],
  ['no signing secret is stored', { signingSecret: false }, 'NO_SIGNING_SECRET'],
  ['no signed webhook has been processed yet', { webhookEvents: [] }, 'NO_VERIFIED_WEBHOOK'],
  ['only failed or unsigned webhooks so far', {
    webhookEvents: [
      { integration_id: '1001', event_id: 'msg_1', processing_status: 'FAILED' },
      { integration_id: '1001', event_id: null, processing_status: 'SUCCESS' },
    ],
  }, 'NO_VERIFIED_WEBHOOK'],
]) {
  test(`a Fusion dealer is left out of the SLA when ${label}; AU008 is still judged`, async (t) => {
    const db = setup(t, options);
    const before = { ...db.tables.lead_integrations[1] };
    const results = await sweep(db);
    assert.deepEqual(db.tables.lead_integrations[1], before, 'Fusion mapping untouched (not breached, not rotated)');
    assert.equal(statusOf(db, 'Z-AU008'), 'SLA_BREACH');
    assert.deepEqual(results.exemptNoReturnChannel, [{ dealerCode: '725001', reason }]);
    assert.equal(results.candidates, 1, 'the exempt dealer\'s rows are not even read');
  });
}

test('a GENERIC_REST dealer is judged as before, whatever its webhooks', async (t) => {
  const db = setup(t, { webhookEvents: [] });
  db.tables.dealer_integrations[1].crm_type = 'GENERIC_REST';
  await sweep(db);
  assert.equal(statusOf(db, 'Z-BUCKBY'), 'SLA_BREACH');
});

test('no Fusion dealers: the sweep reads exactly what it did before', async (t) => {
  const db = setup(t);
  db.tables.dealer_integrations[1].crm_type = 'ZOHO_CRM';
  const results = await sweep(db);
  assert.deepEqual(results.exemptNoReturnChannel, []);
  assert.equal(db.queries.some((q) => q.includes('webhook_events')), false);
  assert.equal(db.queries.some((q) => q.includes('NOT IN')), false);
});

// Review of Batch 7: the return-channel check must never stop the SLA sweep
// for every dealer. A lookup that fails leaves that Fusion dealer exempt for
// this sweep (never breached on a guess), and dealers outside
// DEALER_ACTION_SLA_DEALERS are not checked at all.
test('a failing credential lookup leaves that Fusion dealer exempt; AU008 is still judged', async (t) => {
  const db = setup(t);
  integrationAuthService.hasCredential.mock.mockImplementation(async () => { throw new Error('datastore busy'); });
  const results = await sweep(db);
  assert.equal(statusOf(db, 'Z-AU008'), 'SLA_BREACH');
  assert.equal(statusOf(db, 'Z-BUCKBY'), 'SYNCED');
  assert.deepEqual(results.exemptNoReturnChannel, [{ dealerCode: '725001', reason: 'CHECK_FAILED' }]);
});

test('a failing webhook-event lookup leaves that Fusion dealer exempt; AU008 is still judged', async (t) => {
  const db = setup(t);
  const zcql = db.app.zcql;
  db.app.zcql = () => ({
    executeZCQLQuery: async (sql) => {
      if (sql.includes('FROM webhook_events')) throw new Error('INVALID_TABLE webhook_events');
      return zcql().executeZCQLQuery(sql);
    },
  });
  const results = await sweep(db);
  assert.equal(statusOf(db, 'Z-AU008'), 'SLA_BREACH');
  assert.equal(statusOf(db, 'Z-BUCKBY'), 'SYNCED');
  assert.deepEqual(results.exemptNoReturnChannel, [{ dealerCode: '725001', reason: 'CHECK_FAILED' }]);
});

test('a Fusion dealer outside DEALER_ACTION_SLA_DEALERS is not checked at all', async (t) => {
  const before = process.env.DEALER_ACTION_SLA_DEALERS;
  process.env.DEALER_ACTION_SLA_DEALERS = 'AU008';
  t.after(() => { if (before === undefined) delete process.env.DEALER_ACTION_SLA_DEALERS; else process.env.DEALER_ACTION_SLA_DEALERS = before; });
  const db = setup(t, { webhookEvents: [] });
  const results = await sweep(db);
  assert.equal(integrationAuthService.hasCredential.mock.callCount(), 0);
  assert.equal(db.queries.some((q) => q.includes('FROM webhook_events')), false);
  assert.deepEqual(results.exemptNoReturnChannel, []);
  assert.equal(statusOf(db, 'Z-AU008'), 'SLA_BREACH');
  assert.equal(statusOf(db, 'Z-BUCKBY'), 'SYNCED', 'out of scope, as before');
});

test('if the Fusion integrations cannot even be listed, no Fusion lead is breached; AU008 is still judged', async (t) => {
  const db = setup(t);
  const zcql = db.app.zcql;
  db.app.zcql = () => ({
    executeZCQLQuery: async (sql) => {
      if (sql.includes("crm_type = 'FUSION_SD'")) throw new Error('datastore busy');
      return zcql().executeZCQLQuery(sql);
    },
  });
  const before = { ...db.tables.lead_integrations[1] };
  const results = await sweep(db);
  assert.equal(statusOf(db, 'Z-AU008'), 'SLA_BREACH');
  assert.deepEqual(db.tables.lead_integrations[1], before, 'Fusion mapping untouched');
  assert.equal(results.skippedNoReturnChannel, 1);
});
