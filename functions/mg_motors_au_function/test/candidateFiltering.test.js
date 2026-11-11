'use strict';

process.env.INBOUND_REPLAY_IDLE_SKIP_MINUTES = '0'; // these tests are about the candidate filters, not the idle skip
for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

// Fast-recover cost: held inbound rows of a REMOVED dealer, and never-delivered leads of a dealer
// whose Push leads switch is OFF, cannot be recovered, so they are not re-read or re-tried on every
// run. Both checks are read afresh each run: bringing the dealer back (or switching Push ON) makes
// its rows count again on the next run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crm = require('../services/integrations/crmIntegrationService');
const replay = require('../services/integrations/inboundReplayScheduler');
const retry = require('../services/integrations/outboundRetryScheduler');
const usageContext = require('../services/usageContext');

const systemTime = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ') + ':000';
const counted = (fn) => usageContext.runWithContext({}, async (ctx) => ({ result: await fn(), ds: ctx.ds }));

test.beforeEach(() => { _resetForTests(); replay._test.resetIdleMemo(); });

// ---------------------------------------------------------------- inbound replay: removed dealer

// Dealer AU008 (integration 1000) holds `held` replay rows that are due (held 20 minutes, tried 20
// minutes ago); dealer AU100 (integration 1001) holds `live` due rows.
function replayDb({ removed = true, held = 12, live = 3 } = {}) {
  const logs = [];
  const mappings = [];
  const add = (integrationId, prefix, n) => {
    for (let i = 0; i < n; i += 1) {
      logs.push({
        integration_id: integrationId, external_lead_id: `${prefix}${i}`, happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
        error_message: 'ZOHO_ACK_UPDATE_FAILED', CREATEDTIME: systemTime(Date.now() - 20 * 60000), MODIFIEDTIME: systemTime(Date.now() - 20 * 60000),
      });
      mappings.push({ integration_id: integrationId, external_crm_lead_id: `${prefix}${i}`, last_error: null, MODIFIEDTIME: '2026-09-23 14:52:34:424' });
    }
  };
  add('1000', 'R', held);
  add('1001', 'L', live);
  return createInMemoryZcql({
    integration_logs: logs,
    lead_integrations: mappings,
    dealer_integrations: [
      { dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED' },
      { dealer_code: 'AU100', crm_type: 'ZOHO_CRM', status: 'CONNECTED' },
    ],
    dealers: [
      { dealer_code: 'AU008', sync_status: removed ? 'Removed' : 'Active' },
      { dealer_code: 'AU100', sync_status: 'Active' },
    ],
    integration_status_mappings: [],
  });
}
const sweep = (db) => counted(() => replay.runInboundReplaySweep(usageContext.instrument(db.app)));

test('replay: held rows of a removed dealer are left out; the live dealer is still replayed', async (t) => {
  const db = replayDb();
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const { result } = await sweep(db);
  assert.equal(result.queued, 3, 'only the live dealer rows are read');
  assert.equal(result.attempted, 3);
  assert.ok(send.mock.calls.every((call) => String(call.arguments[2]).startsWith('L')));
});

test('replay: bringing the dealer back (no longer Removed) picks its held rows up on the next run', async (t) => {
  const db = replayDb();
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  assert.equal((await sweep(db)).result.queued, 3);
  db.tables.dealers.find((row) => row.dealer_code === 'AU008').sync_status = 'Active';
  const next = await sweep(db);
  assert.ok(next.result.queued >= 12, `queued: ${next.result.queued}`);
  assert.ok(send.mock.calls.some((call) => String(call.arguments[2]).startsWith('R')));
});

test('replay: nothing is closed, rewritten or deleted for the removed dealer', async (t) => {
  const db = replayDb();
  t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const before = JSON.stringify(db.tables.integration_logs.filter((row) => row.integration_id === '1000'));
  await sweep(db);
  assert.equal(JSON.stringify(db.tables.integration_logs.filter((row) => row.integration_id === '1000')), before);
});

test('replay: with no removed dealer every dealer is read as before', async (t) => {
  const db = replayDb({ removed: false });
  t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  assert.equal((await sweep(db)).result.queued, 15);
});

test('replay: if the removed-dealer lookup fails the sweep reads everything as before', async (t) => {
  const db = replayDb();
  t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  db.tables.dealers = undefined; // the lookup throws
  assert.equal((await sweep(db)).result.queued, 15);
});

test('replay: a dealer with one Removed row and one Active row is not left out', async (t) => {
  const db = replayDb();
  db.tables.dealers.push({ dealer_code: 'AU008', sync_status: 'Active' });
  t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  assert.equal((await sweep(db)).result.queued, 15);
});

// ---------------------------------------------------------------- outbound: Push leads OFF

function outboundDb({ pushEnabled, externalId = '' }) {
  return createInMemoryZcql({
    dealer_integrations: [{ dealer_code: 'AU100', crm_type: 'DEALER_STUDIO', status: 'CONNECTED', outbound_enabled: true, push_enabled: pushEnabled }],
    lead_integrations: [
      { integration_id: '1000', zoho_lead_id: 'ZL1', dealer_code: 'AU100', external_crm_lead_id: externalId, sync_status: 'FAILED', retry_count: 1 },
    ],
    leads: [{ crm_record_id: 'ZL1', dealer_code: 'AU100', sync_status: 'SYNCED', lead_status: 'Not Contacted' }],
    integration_logs: [],
  });
}
const outboundSweep = (db) => counted(() => retry.runOutboundRetrySweep(usageContext.instrument(db.app), { ignoreSchedule: true }));

test('outbound: a never-delivered lead of a Push OFF dealer is passed over before the send path', async (t) => {
  const db = outboundDb({ pushEnabled: false });
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ skipped: true, reason: 'DEALER_PUSH_PAUSED' }));
  const { result, ds } = await outboundSweep(db);
  assert.equal(result.skippedPushPaused, 1);
  assert.equal(result.attempted, 0);
  assert.equal(send.mock.callCount(), 0);
  assert.ok(ds.fetchRows <= 3, `rows read: ${ds.fetchRows}`);
});

test('outbound: switching Push back ON sends the same lead on the next run', async (t) => {
  const db = outboundDb({ pushEnabled: false });
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  await outboundSweep(db);
  assert.equal(send.mock.callCount(), 0);
  db.tables.dealer_integrations[0].push_enabled = true;
  const { result } = await outboundSweep(db);
  assert.equal(result.attempted, 1);
  assert.equal(result.recovered, 1);
  assert.equal(send.mock.callCount(), 1);
});

test('outbound: a dealer whose switch was never touched (no value) behaves as before', async (t) => {
  const db = outboundDb({ pushEnabled: undefined });
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const { result } = await outboundSweep(db);
  assert.equal(result.skippedPushPaused, 0);
  assert.equal(send.mock.callCount(), 1);
});

test('outbound: a lead already in the dealer CRM keeps being retried while Push is OFF', async (t) => {
  const db = outboundDb({ pushEnabled: false, externalId: 'DS-99' });
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const { result } = await outboundSweep(db);
  assert.equal(result.skippedPushPaused, 0);
  assert.equal(result.attempted, 1);
  assert.equal(send.mock.callCount(), 1);
});
