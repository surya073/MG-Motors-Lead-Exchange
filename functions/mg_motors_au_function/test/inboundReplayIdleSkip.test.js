'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

// Inbound replay idle skip: after a sweep that did nothing, the next sweeps read
// only two one-row checks while nothing they watch has changed and no backoff has
// arrived. Anything else runs the full sweep exactly as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crm = require('../services/integrations/crmIntegrationService');
const replay = require('../services/integrations/inboundReplayScheduler');
const usageContext = require('../services/usageContext');

const systemTime = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ') + ':000';
const MAP_VERSION = '2026-01-01 00:00:00:000';
const SEEN = ` | replay-map:${Buffer.from(JSON.stringify({ map: MAP_VERSION, resolved: '', retry: false })).toString('base64url')}`;

const counted = (fn) => usageContext.runWithContext({}, async (ctx) => ({ result: await fn(), ds: ctx.ds }));
const sweep = (db) => counted(() => replay.runInboundReplaySweep(usageContext.instrument(db.app)));

// 30 holds waiting for a status mapping (seen against the current map) and 20
// ordinary holds tried a minute ago. `createdAgoMs` sets how long the ordinary ones have waited.
function queue({ createdAgoMs = 30 * 24 * 3600 * 1000 } = {}) {
  const logs = [];
  const mappings = [];
  for (let i = 0; i < 30; i += 1) {
    logs.push({
      integration_id: '1000', external_lead_id: `M${i}`, happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
      error_message: `STATUS_MAPPING_NOT_FOUND:Dealer status${SEEN}`,
      CREATEDTIME: '2026-09-23 14:52:34:424', MODIFIEDTIME: systemTime(Date.now() - 60000),
    });
    mappings.push({ integration_id: '1000', external_crm_lead_id: `M${i}`, last_error: 'UNMAPPED_STATUS: Dealer status', MODIFIEDTIME: '2026-09-23 14:52:34:424' });
  }
  for (let i = 0; i < 20; i += 1) {
    logs.push({
      integration_id: '1000', external_lead_id: `B${i}`, happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
      error_message: 'ZOHO_ACK_UPDATE_FAILED', CREATEDTIME: systemTime(Date.now() - createdAgoMs), MODIFIEDTIME: systemTime(Date.now() - 60000),
    });
    mappings.push({ integration_id: '1000', external_crm_lead_id: `B${i}`, last_error: null, MODIFIEDTIME: '2026-09-23 14:52:34:424' });
  }
  return createInMemoryZcql({
    integration_logs: logs,
    lead_integrations: mappings,
    dealer_integrations: [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED' }],
    integration_status_mappings: [{ integration_id: '1000', MODIFIEDTIME: MAP_VERSION }],
  });
}

test.beforeEach(() => {
  _resetForTests();
  replay._test.resetIdleMemo();
  delete process.env.INBOUND_REPLAY_IDLE_SKIP_MINUTES;
});

test('an idle sweep is followed by a skipped one that reads only two rows', async () => {
  const db = queue();
  const first = await sweep(db);
  assert.equal(first.result.attempted, 0);
  assert.ok(first.ds.fetchRows > 40);
  const second = await sweep(db);
  assert.equal(second.result.skipped, true);
  assert.equal(second.result.reason, 'REPLAY_IDLE_UNCHANGED');
  assert.ok(second.ds.fetchRows <= 3, `rows: ${second.ds.fetchRows}`);
});

test('a new held row makes the next sweep run in full', async () => {
  const db = queue();
  await sweep(db);
  db.tables.integration_logs.push({
    integration_id: '1000', external_lead_id: 'NEW', happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
    error_message: 'ZOHO_ACK_UPDATE_FAILED', CREATEDTIME: systemTime(Date.now()), MODIFIEDTIME: systemTime(Date.now()),
  });
  const next = await sweep(db);
  assert.notEqual(next.result.skipped, true);
  assert.equal(next.result.leads, 51);
});

test('an edited status mapping makes the next sweep run in full', async () => {
  const db = queue();
  await sweep(db);
  db.tables.integration_status_mappings[0].MODIFIEDTIME = '2026-11-11 09:00:00:000';
  const next = await sweep(db);
  assert.notEqual(next.result.skipped, true);
});

test('the skip ends when the memo is older than the limit', async (t) => {
  const db = queue();
  await sweep(db);
  const real = Date.now();
  t.mock.method(Date, 'now', () => real + 31 * 60000);
  const next = await sweep(db);
  assert.notEqual(next.result.skipped, true);
});

test('a backoff that falls due ends the skip early, and the replay then runs', async (t) => {
  // Held 10 minutes: retried every 5 (the wait grows as it is held longer);
  // last tried 1 minute ago, so the skip may last at most 4 minutes.
  const db = queue({ createdAgoMs: 10 * 60000 });
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const real = Date.now();
  let offsetMs = 0;
  t.mock.method(Date, 'now', () => real + offsetMs);
  assert.equal((await sweep(db)).result.attempted, 0);
  assert.equal((await sweep(db)).result.skipped, true);
  offsetMs = 5 * 60000; // past the earliest estimate: a full sweep runs (still backed off)
  const early = await sweep(db);
  assert.notEqual(early.result.skipped, true);
  assert.equal(early.result.attempted, 0);
  offsetMs = 12 * 60000; // really due now
  const later = await sweep(db);
  assert.notEqual(later.result.skipped, true);
  assert.ok(later.result.attempted > 0);
  assert.ok(send.mock.callCount() > 0);
});

test('a sweep that did work is never followed by a skip', async (t) => {
  const db = queue({ createdAgoMs: 10 * 60000 });
  db.tables.integration_logs.forEach((row) => { row.MODIFIEDTIME = systemTime(Date.now() - 20 * 60000); });
  t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const first = await sweep(db);
  assert.ok(first.result.attempted > 0);
  const second = await sweep(db);
  assert.notEqual(second.result.skipped, true);
});

test('INBOUND_REPLAY_IDLE_SKIP_MINUTES=0 turns the skip off', async () => {
  process.env.INBOUND_REPLAY_IDLE_SKIP_MINUTES = '0';
  const db = queue();
  await sweep(db);
  const second = await sweep(db);
  assert.notEqual(second.result.skipped, true);
  assert.ok(second.ds.fetchRows > 40);
});
