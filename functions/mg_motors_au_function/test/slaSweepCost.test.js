'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// COST_OPTIMIZATION_PLAN.md, Batch 2 (F2): on 21 Oct every fast-recover run
// found 16 overdue AU008 mappings and skipped all 16 as unhealthy (AU008's
// dealers row is Removed), each after a claim insert, a claim delete and four
// reads, and without writing anything, so the same 16 came back every sweep.
// An integration-level reason that skips without writing is now found once
// per sweep, before any claim. Every outcome stays as it was.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSlaFixture } = require('./helpers/slaFixture');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const usageContext = require('../services/usageContext');

const NOW = Date.parse('2026-10-21T06:00:00Z');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const OVERDUE = utc(NOW - 3 * 24 * 3600 * 1000);
const OLDER = utc(NOW - 5 * 24 * 3600 * 1000);

// Integration ROWIDs are positional: 1000 = AU008 (Zoho), 1001 = Z2 (Zoho).
function setup(t, { au008 = 16, z2 = 0, au008Ack = OVERDUE, integration = {}, dealers, leadStatus = 'Not Contacted' } = {}) {
  _resetForTests();
  const mappings = [];
  const leads = [];
  const add = (dealer, integrationId, count, ack) => {
    for (let i = 0; i < count; i += 1) {
      const id = `${dealer}-${i}`;
      mappings.push({ zoho_lead_id: id, dealer_code: dealer, integration_id: integrationId, sync_status: 'SYNCED', last_synced_at: ack });
      leads.push({ crm_record_id: id, lead_status: leadStatus, sync_status: 'SYNCED' });
    }
  };
  add('AU008', '1000', au008, au008Ack);
  add('Z2', '1001', z2, OVERDUE);
  const db = createSlaFixture({
    dealer_integrations: [
      { dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED', inbound_enabled: true, outbound_enabled: true, ...integration },
      { dealer_code: 'Z2', crm_type: 'ZOHO_CRM', status: 'CONNECTED', inbound_enabled: true, outbound_enabled: true },
    ],
    dealers: dealers || [{ dealer_code: 'AU008', sync_status: 'Removed' }, { dealer_code: 'Z2', sync_status: 'Synced' }],
    lead_integrations: mappings,
    leads,
    outbound_sync_claims: [],
  });
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({ status: 'success' }));
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  return db;
}

// Runs one sweep with every Data Store operation counted (Batch 1 counter).
async function countedSweep(db) {
  return usageContext.runWithContext({}, async (ctx) => {
    const results = await slaMonitorService.runSlaSweep(usageContext.instrument(db.app), new Date(NOW), { clock: () => 0 });
    return { results, ds: ctx.ds };
  });
}

const writes = (ds) => ({ insert: ds.insert, update: ds.update, delete: ds.delete });
const NO_WRITES = { insert: 0, update: 0, delete: 0 };

test('16 overdue leads of a removed dealer: 3 reads, no claim, nothing written (was 16 claims)', async (t) => {
  const db = setup(t);
  const before = db.tables.lead_integrations.map((m) => ({ ...m }));
  const { results, ds } = await countedSweep(db);
  assert.deepEqual(writes(ds), NO_WRITES);
  assert.ok(ds.fetch <= 3, `fetches: ${ds.fetch}`);
  assert.deepEqual(db.tables.lead_integrations, before, 'not breached, not rotated');
  assert.equal(results.excludedUnhealthy, 16);
  assert.deepEqual(results.excludedIntegrations, [{ dealerCode: 'AU008', reason: 'DEALER_REMOVED' }]);
  assert.equal(results.candidates, 0);
  assert.equal(results.skippedUnhealthy, 0);
});

for (const [label, options, reason] of [
  ['its dealer row is missing', { dealers: [{ dealer_code: 'Z2', sync_status: 'Synced' }] }, 'DEALER_MISSING'],
  ['outbound is disabled', { integration: { outbound_enabled: false }, dealers: [{ dealer_code: 'AU008', sync_status: 'Synced' }] }, 'OUTBOUND_DISABLED'],
  ['inbound is disabled (Zoho)', { integration: { inbound_enabled: false }, dealers: [{ dealer_code: 'AU008', sync_status: 'Synced' }] }, 'INBOUND_DISABLED'],
]) {
  test(`an integration is screened out before any claim when ${label}`, async (t) => {
    const db = setup(t, options);
    const { results, ds } = await countedSweep(db);
    assert.deepEqual(writes(ds), NO_WRITES);
    assert.ok(ds.fetch <= 3, `fetches: ${ds.fetch}`);
    assert.deepEqual(results.excludedIntegrations, [{ dealerCode: 'AU008', reason }]);
    assert.ok(db.tables.lead_integrations.every((m) => m.sync_status === 'SYNCED' && m.last_synced_at === OVERDUE));
  });
}

test('a mapping whose integration row no longer exists is screened out', async (t) => {
  const db = setup(t, { dealers: [{ dealer_code: 'AU008', sync_status: 'Synced' }] });
  db.tables.lead_integrations.forEach((m) => { m.integration_id = '1999'; });
  const { results, ds } = await countedSweep(db);
  assert.deepEqual(writes(ds), NO_WRITES);
  assert.deepEqual(results.excludedIntegrations, [{ dealerCode: null, reason: 'INTEGRATION_MISSING' }]);
});

test('a Fusion dealer with no return channel is skipped before the claim, as before without writes', async (t) => {
  const db = setup(t, { au008: 3, integration: { crm_type: 'FUSION_SD', inbound_enabled: false }, dealers: [{ dealer_code: 'AU008', sync_status: 'Synced' }] });
  const { results, ds } = await countedSweep(db);
  assert.deepEqual(writes(ds), NO_WRITES);
  assert.equal(results.skippedNoReturnChannel, 3);
  assert.deepEqual(results.exemptNoReturnChannel, [{ dealerCode: 'AU008', reason: 'INBOUND_OFF' }]);
  assert.ok(db.tables.lead_integrations.every((m) => m.sync_status === 'SYNCED' && m.last_synced_at === OVERDUE));
});

test('nothing overdue: one read, no screening cost', async (t) => {
  const db = setup(t, { au008: 0 });
  const { results, ds } = await countedSweep(db);
  assert.equal(ds.fetch, 1);
  assert.equal(results.candidates, 0);
});

test('a healthy overdue unactioned lead is breached exactly as before', async (t) => {
  const db = setup(t, { au008: 0, z2: 1 });
  const { results } = await countedSweep(db);
  assert.equal(results.breached, 1);
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SLA_BREACH');
  assert.equal(db.tables.leads[0].lead_status, 'Unattended Alert');
  assert.deepEqual(results.excludedIntegrations, []);
});

test('excluded rows ahead of the window no longer hide healthy overdue leads behind them', async (t) => {
  // 250 older removed-dealer rows fill the 100-row head and most of the tail.
  const db = setup(t, { au008: 250, au008Ack: OLDER, z2: 2 });
  const { results, ds } = await countedSweep(db);
  assert.equal(results.breached, 2);
  assert.equal(results.candidates, 2);
  assert.equal(ds.insert, 2, 'claims only for the two workable leads');
  assert.ok(db.tables.lead_integrations.filter((m) => m.dealer_code === 'AU008').every((m) => m.sync_status === 'SYNCED'));
});

test('behaviour kept: an integration in error status is still rotated (its SLA restarts on recovery)', async (t) => {
  const db = setup(t, { au008: 1, integration: { status: 'NOT_CONFIGURED' }, dealers: [{ dealer_code: 'AU008', sync_status: 'Synced' }] });
  const { results } = await countedSweep(db);
  assert.equal(results.skippedUnhealthy, 1);
  assert.notEqual(db.tables.lead_integrations[0].last_synced_at, OVERDUE, 'rotated as before');
});

test('behaviour kept (C3): a lead the dealer has actioned is still rotated under the claim', async (t) => {
  const db = setup(t, { au008: 0, z2: 1, leadStatus: 'Contacted' });
  const { results, ds } = await countedSweep(db);
  assert.equal(results.skippedActioned, 1);
  assert.equal(ds.insert, 1, 'claim taken as before');
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SYNCED');
});

test('a failed screen falls back to the in-claim checks (same outcomes as before)', async (t) => {
  const db = setup(t, { au008: 2, z2: 1 });
  const execute = db.app.zcql;
  db.app.zcql = () => ({
    executeZCQLQuery: async (sql) => {
      if (/FROM dealer_integrations WHERE ROWID IN/.test(sql)) throw new Error('ZCQL unavailable');
      return execute().executeZCQLQuery(sql);
    },
  });
  const { results } = await countedSweep(db);
  assert.equal(results.breached, 1);
  assert.equal(results.skippedUnhealthy, 2);
  assert.ok(db.tables.lead_integrations.filter((m) => m.dealer_code === 'AU008').every((m) => m.sync_status === 'SYNCED'));
});
