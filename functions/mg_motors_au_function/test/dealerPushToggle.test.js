'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const dealerPushQueueService = require('../services/integrations/dealerPushQueueService');
const dashboardStats = require('../services/dashboardStatsService');

// The per-dealer push switch: off = no new leads reach the dealer (quietly); turning it
// on either sends the queued leads or skips them and carries on from that moment.

const CONNECTED = '2026-11-05 07:55:00:000'; // IST, = 5 Nov 02:25 UTC
const AFTER = '2026-11-05 10:00:00'; // UTC lead creation, after connecting
const skipReason = (integration, lead) => crmIntegrationService.newLeadSkipReason(integration, lead);

test('push_enabled: no value and true are on; false (also as a string) is off', () => {
  assert.equal(crmIntegrationService.isDealerPushPaused({}), false);
  assert.equal(crmIntegrationService.isDealerPushPaused({ push_enabled: true }), false);
  assert.equal(crmIntegrationService.isDealerPushPaused({ push_enabled: 'true' }), false);
  assert.equal(crmIntegrationService.isDealerPushPaused({ push_enabled: false }), true);
  assert.equal(crmIntegrationService.isDealerPushPaused({ push_enabled: 'false' }), true);
});

test('a paused dealer skips every new lead, whatever its CRM type', () => {
  for (const crm_type of ['FUSION_SD', 'DEALER_STUDIO', 'ZOHO_CRM', 'GENERIC_REST']) {
    assert.equal(skipReason({ crm_type, CREATEDTIME: CONNECTED, push_enabled: false }, { assigned_date: AFTER }), 'DEALER_PUSH_PAUSED', crm_type);
    assert.equal(skipReason({ crm_type, CREATEDTIME: CONNECTED }, { assigned_date: AFTER }), null, crm_type);
  }
});

test('push_from_at (skip the queue) blocks leads created before it, for any CRM type', () => {
  const dealer = { crm_type: 'ZOHO_CRM', CREATEDTIME: CONNECTED, push_from_at: '2026-11-05 12:00:00' };
  assert.equal(skipReason(dealer, { assigned_date: '2026-11-05 11:59:59' }), 'BEFORE_PUSH_RESUME');
  assert.equal(skipReason(dealer, { assigned_date: '2026-11-05 12:00:00' }), null);
  assert.equal(skipReason(dealer, {}), null, 'a lead with no readable date is not blocked');
});

test('the push floor is the later of the connect time and the last resume', () => {
  const connected = crmIntegrationService.dealerPushFloor({ CREATEDTIME: CONNECTED });
  assert.equal(connected.toISOString(), '2026-11-05T02:25:00.000Z');
  const resumed = crmIntegrationService.dealerPushFloor({ CREATEDTIME: CONNECTED, push_from_at: '2026-11-06 01:00:00' });
  assert.equal(resumed.toISOString(), '2026-11-06T01:00:00.000Z');
  assert.equal(crmIntegrationService.dealerPushFloor({}), null);
});

test('a paused dealer: a new lead is not created, no alert, hold, claim or mapping row', async (t) => {
  withEnv(t, { FUSION_SD_NEW_LEADS_ONLY: undefined });
  const harness = setupOutbound(t, { integration: { CREATEDTIME: CONNECTED, push_enabled: false }, mapping: null, lead: { assigned_date: AFTER, sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, {});

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.deepEqual(result, { skipped: true, reason: 'DEALER_PUSH_PAUSED' });
  assert.equal(calls.create.length, 0);
  assert.equal(harness.alerts.mock.callCount(), 0);
  assert.equal(harness.db.tables.lead_integrations.length, 0);
  assert.equal(harness.db.tables.outbound_sync_claims.length, 0);
  assert.equal(harness.db.tables.leads[0].sync_status, 'PENDING', 'the lead is left alone, so it counts as queued');
});

test('a paused dealer: a lead already in the dealer CRM keeps syncing its updates', async (t) => {
  const harness = setupOutbound(t, {
    integration: { CREATEDTIME: CONNECTED, push_enabled: false },
    mapping: { external_crm_lead_id: '555', sync_status: 'SYNCED' },
    lead: { assigned_date: AFTER, lead_department: 'Sales' },
  });
  const calls = fakeAdapter(t, { updateLead: async () => ({ httpStatus: 200, raw: {} }) });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.notEqual(result?.reason, 'DEALER_PUSH_PAUSED');
  assert.equal(calls.create.length, 0);
});

// --- turning the switch on ------------------------------------------------

function fakeApp() {
  const writes = [];
  return {
    writes,
    datastore: () => ({ table: () => ({ updateRow: async (row) => { writes.push(row); } }) }),
  };
}
const queued = (ids) => ids.map((id) => ({ crm_record_id: id, customer_name: `Lead ${id}`, assigned_date: AFTER }));
function stubQueue(t, leadIds, mappedIds = []) {
  t.mock.method(dashboardStats, 'selectEveryRow', async (app, table) => (
    table === 'leads' ? queued(leadIds) : mappedIds.map((id) => ({ zoho_lead_id: id }))
  ));
}
const DEALER = { ROWID: '9', dealer_code: 'D1', crm_type: 'FUSION_SD', CREATEDTIME: CONNECTED, push_enabled: false };

test('queued leads exclude any lead that already has a mapping row', async (t) => {
  stubQueue(t, ['A', 'B', 'C'], ['B']);
  const leads = await dealerPushQueueService.listQueuedLeads(fakeApp(), { ...DEALER });
  assert.deepEqual(leads.map((l) => l.crm_record_id), ['A', 'C']);
  const summary = dealerPushQueueService.queuedSummary(leads);
  assert.equal(summary.count, 2);
  assert.equal(summary.sample[0].customer_name, 'Lead A');
});

test('turning on with queued leads asks for a decision first and changes nothing', async (t) => {
  stubQueue(t, ['A', 'B']);
  const app = fakeApp();
  const dealer = { ...DEALER };
  await assert.rejects(dealerPushQueueService.resumePush(app, dealer, {}), (err) => {
    assert.equal(err.code, 'QUEUE_DECISION_REQUIRED');
    assert.equal(err.queued.count, 2);
    return true;
  });
  assert.equal(app.writes.length, 0);
  assert.equal(dealer.push_enabled, false);
});

test('turning on and skipping the queue sets push_from_at to now; nothing is sent', async (t) => {
  stubQueue(t, ['A', 'B']);
  const sync = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const app = fakeApp();
  const dealer = { ...DEALER };
  const result = await dealerPushQueueService.resumePush(app, dealer, { queued: 'skip' });
  assert.deepEqual(result, { push_enabled: true, queued: 2, skipped: 2, pushed: 0, failed: 0, remaining: 0 });
  assert.equal(app.writes.length, 1);
  assert.equal(app.writes[0].push_enabled, true);
  assert.match(app.writes[0].push_from_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(sync.mock.callCount(), 0);
});

test('turning on and pushing the queue switches on first, then sends each queued lead', async (t) => {
  stubQueue(t, ['A', 'B', 'C']);
  const seen = [];
  const app = fakeApp();
  const dealer = { ...DEALER };
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async (a, integration, lead) => {
    assert.equal(integration.push_enabled, true, 'switched on before the leads go out');
    seen.push(lead.crm_record_id);
    return lead.crm_record_id === 'C' ? { skipped: true } : { ok: true };
  });
  const result = await dealerPushQueueService.resumePush(app, dealer, { queued: 'push' });
  assert.deepEqual(seen, ['A', 'B', 'C']);
  assert.deepEqual(result, { push_enabled: true, queued: 3, skipped: 0, pushed: 2, failed: 1, remaining: 0 });
  assert.deepEqual(app.writes, [{ ROWID: '9', push_enabled: true }], 'push_from_at is not set when the queue is pushed');
});

test('turning on with nothing queued needs no decision', async (t) => {
  stubQueue(t, []);
  const app = fakeApp();
  const result = await dealerPushQueueService.resumePush(app, { ...DEALER }, {});
  assert.deepEqual(result, { push_enabled: true, queued: 0, skipped: 0, pushed: 0, failed: 0, remaining: 0 });
});

test('turning off only sets push_enabled to false', async () => {
  const app = fakeApp();
  const dealer = { ...DEALER, push_enabled: true };
  assert.deepEqual(await dealerPushQueueService.pausePush(app, dealer), { push_enabled: false });
  assert.deepEqual(app.writes, [{ ROWID: '9', push_enabled: false }]);
});
