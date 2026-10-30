'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

// COST_OPTIMIZATION_PLAN.md, Batch 3 (F4): on 21 Oct the inbound replay
// sweep held 200 queued rows (319 live, all AU008) and attempted none. The
// rows waiting for a status mapping cost one lead_integrations read EACH on
// every sweep just to learn that nothing had changed. Those reads are now one
// query per integration. The outbound retry sweep reads only rows that are
// due, instead of reading every failing row and filtering in JavaScript.
// Every outcome stays as it was.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crm = require('../services/integrations/crmIntegrationService');
const replay = require('../services/integrations/inboundReplayScheduler');
const retry = require('../services/integrations/outboundRetryScheduler');
const usageContext = require('../services/usageContext');

const systemTime = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ') + ':000';
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const MAP_VERSION = '2026-01-01 00:00:00:000';
// The marker a previous sweep left: status map and lead mapping as seen then.
const SEEN_UNCHANGED = ` | replay-map:${Buffer.from(JSON.stringify({ map: MAP_VERSION, resolved: '', retry: false })).toString('base64url')}`;

async function counted(fn) {
  return usageContext.runWithContext({}, async (ctx) => ({ result: await fn(), ds: ctx.ds }));
}
const writes = (ds) => ({ insert: ds.insert, update: ds.update, delete: ds.delete });
const NO_WRITES = { insert: 0, update: 0, delete: 0 };

// The live shape: mapping-only holds already seen against the current map,
// plus ordinary holds tried a minute ago (backed off). Integration 1000.
function liveQueue({ mappingOnly = 30, backedOff = 20, integrations } = {}) {
  const logs = [];
  const mappings = [];
  for (let i = 0; i < mappingOnly; i += 1) {
    logs.push({
      integration_id: '1000', external_lead_id: `M${i}`, happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
      error_message: `STATUS_MAPPING_NOT_FOUND:Dealer status${SEEN_UNCHANGED}`,
      CREATEDTIME: '2026-09-23 14:52:34:424', MODIFIEDTIME: systemTime(Date.now() - 60000),
    });
    mappings.push({ integration_id: '1000', external_crm_lead_id: `M${i}`, last_error: 'UNMAPPED_STATUS: Dealer status', MODIFIEDTIME: '2026-09-23 14:52:34:424' });
  }
  for (let i = 0; i < backedOff; i += 1) {
    logs.push({
      integration_id: '1000', external_lead_id: `B${i}`, happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
      error_message: 'ZOHO_ACK_UPDATE_FAILED', CREATEDTIME: '2026-09-24 11:15:49:168', MODIFIEDTIME: systemTime(Date.now() - 60000),
    });
  }
  return createInMemoryZcql({
    integration_logs: logs,
    lead_integrations: mappings,
    dealer_integrations: integrations || [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED' }],
    integration_status_mappings: [{ integration_id: '1000', MODIFIEDTIME: MAP_VERSION }],
  });
}

test('replay, live shape (30 awaiting a mapping, 20 backed off): 4 reads instead of 33, nothing written', async (t) => {
  _resetForTests();
  const db = liveQueue();
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const before = JSON.parse(JSON.stringify(db.tables));
  const { result, ds } = await counted(() => replay.runInboundReplaySweep(usageContext.instrument(db.app)));
  assert.equal(result.awaitingMapping, 30);
  assert.equal(result.backedOff, 20);
  assert.equal(result.attempted, 0);
  assert.equal(send.mock.callCount(), 0);
  assert.deepEqual(writes(ds), NO_WRITES);
  assert.deepEqual(db.tables, before);
  assert.ok(ds.fetch <= 4, `fetches: ${ds.fetch}`);
});

test('replay: more than one IN-list chunk of mapping-only holds still decides each one correctly', async (t) => {
  _resetForTests();
  const db = liveQueue({ mappingOnly: 95, backedOff: 0 });
  // Lead M94's dealer status got mapped since the last sweep: it must be replayed.
  Object.assign(db.tables.lead_integrations[94], { last_error: null, MODIFIEDTIME: '2026-10-20 10:00:00:000' });
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const { result, ds } = await counted(() => replay.runInboundReplaySweep(usageContext.instrument(db.app)));
  assert.equal(result.awaitingMapping, 94);
  assert.equal(result.recovered, 1);
  assert.deepEqual(send.mock.calls.map((call) => call.arguments[2]), ['M94']);
  assert.ok(ds.fetch <= 6, `fetches: ${ds.fetch}`);
});

test('replay: holds of a missing integration wait without a mapping read each', async (t) => {
  _resetForTests();
  const db = liveQueue({ mappingOnly: 0, backedOff: 10, integrations: [] });
  db.tables.integration_logs.forEach((row) => { row.MODIFIEDTIME = systemTime(Date.now() - 120 * 60000); });
  const { result, ds } = await counted(() => replay.runInboundReplaySweep(usageContext.instrument(db.app)));
  assert.equal(result.stillWaiting, 10);
  assert.deepEqual(writes(ds), NO_WRITES);
  assert.ok(ds.fetch <= 2, `fetches: ${ds.fetch}`);
});

test('replay: an out-of-order hold past retention re-reads its mapping before expiring it', async (t) => {
  _resetForTests();
  const db = createInMemoryZcql({ integration_logs: [{
    integration_id: '1000', external_lead_id: 'D1', happy_unhappy_path_name: 'Unhappy 7', status: 'FAILED',
    error_message: 'LEAD_MAPPING_NOT_FOUND', CREATEDTIME: '2000-01-01 00:00:00:000', MODIFIEDTIME: systemTime(Date.now()),
  }], lead_integrations: [], dealer_integrations: [{ dealer_code: 'D1', crm_type: 'ZOHO_CRM' }] });
  t.mock.method(crm, 'recordScenario', async () => {});
  const result = await replay.runInboundReplaySweep(db.app);
  assert.equal(result.expired, 1);
  const mappingReads = db.queries.filter((sql) => sql.includes('FROM lead_integrations'));
  assert.ok(mappingReads.some((sql) => sql.includes("external_crm_lead_id = 'D1'")), 'fresh single read before the expiry');
});

test('replay: a failed batched read falls back to one read per hold, with the same outcomes', async (t) => {
  _resetForTests();
  const db = liveQueue({ mappingOnly: 3, backedOff: 2 });
  const execute = db.app.zcql;
  db.app.zcql = () => ({
    executeZCQLQuery: async (sql) => {
      if (/external_crm_lead_id IN/.test(sql)) throw new Error('ZCQL unavailable');
      return execute().executeZCQLQuery(sql);
    },
  });
  const result = await replay.runInboundReplaySweep(db.app);
  assert.equal(result.awaitingMapping, 3);
  assert.equal(result.backedOff, 2);
  assert.equal(result.failed, 0);
});

// ---- outbound retry ----------------------------------------------------------

function retryDb({ notDue, due, nullDue = 0 }) {
  const now = Date.now();
  const mappings = [];
  const leads = [];
  const add = (id, nextRetryAt) => {
    mappings.push({ zoho_lead_id: id, dealer_code: 'D1', integration_id: '1000', sync_status: 'FAILED', next_retry_at: nextRetryAt });
    leads.push({ crm_record_id: id, lead_status: 'Not Contacted', sync_status: 'FAILED' });
  };
  for (let i = 0; i < due; i += 1) add(`due-${i}`, utc(now - (60 - i) * 60000));
  for (let i = 0; i < nullDue; i += 1) add(`null-${i}`, null);
  for (let i = 0; i < notDue; i += 1) add(`later-${i}`, utc(now + (60 + i) * 60000));
  return createInMemoryZcql({ lead_integrations: mappings, leads, dealer_integrations: [{ dealer_code: 'D1', status: 'ACTIVE' }] });
}

function deliveries(t) {
  const delivered = [];
  t.mock.method(crm, 'syncLeadToExternalCrm', async (_app, _integration, leadRow) => {
    delivered.push(leadRow.crm_record_id);
    return { ok: true, scenarioCode: 'Happy 4' };
  });
  return delivered;
}

test('retry: 150 failing rows not yet due + 2 due: one read of the due rows (was head + count + tail)', async (t) => {
  _resetForTests();
  const delivered = deliveries(t);
  const db = retryDb({ notDue: 150, due: 2 });
  const { result, ds } = await counted(() => retry.runOutboundRetrySweep(usageContext.instrument(db.app)));
  assert.deepEqual(delivered.sort(), ['due-0', 'due-1']);
  assert.equal(result.recovered, 2);
  const candidateReads = db.queries.filter((sql) => sql.includes("FROM lead_integrations WHERE sync_status IN ('FAILED', 'FAILED_CRITICAL')"));
  assert.equal(candidateReads.length, 1);
  assert.ok(ds.fetchRows < 10, `rows read: ${ds.fetchRows}`);
});

test('retry: a row with no next_retry_at is still due', async (t) => {
  _resetForTests();
  const delivered = deliveries(t);
  const db = retryDb({ notDue: 3, due: 0, nullDue: 1 });
  await retry.runOutboundRetrySweep(db.app);
  assert.deepEqual(delivered, ['null-0']);
});

test('retry: the fast-recover pass (ignoreSchedule) still reads and attempts every failing row', async (t) => {
  _resetForTests();
  const delivered = deliveries(t);
  const db = retryDb({ notDue: 3, due: 1 });
  await retry.runOutboundRetrySweep(db.app, { ignoreSchedule: true });
  assert.equal(delivered.length, 4);
});
