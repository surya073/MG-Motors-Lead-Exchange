'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { tailWindow, ROTATION_BUCKET_MS } = require('../services/integrations/sweepWindow');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const dashboardStats = require('../services/dashboardStatsService');

// The sweeps read "the oldest N rows that still need work". A row that is
// looked at but cannot be acted on (it throws, waits on a human, belongs to a
// dealer that is not fixed yet) is not rewritten, so it stays the oldest row
// forever — and enough of them fill the whole window, hiding every newer row.
// Each scenario below puts MORE stuck rows at the front than a window holds, and
// shows (a) that the old fixed window really would starve, (b) that every
// workable row is still reached with the rotating window, (c) that nothing is
// processed twice and no evidence is rewritten.

const BASE_NOW = Date.parse('2026-10-09T06:00:00Z');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const HOUR = 3600 * 1000;
const pad = (n, w = 5) => String(n).padStart(w, '0');

// --- the rotation helper -----------------------------------------------------------

test('tail window: none when everything fits in the head; otherwise it walks the whole remainder', () => {
  assert.equal(tailWindow({ total: 100, headSize: 100, tailSize: 100 }), null);
  assert.equal(tailWindow({ total: 40, headSize: 100, tailSize: 100 }), null);

  const total = 1000;
  const visited = new Set();
  const rotations = tailWindow({ total, headSize: 100, tailSize: 100, now: 0 }).rotations;
  assert.equal(rotations, 9, '900 rows after the head, 100 per slice');
  for (let bucket = 0; bucket < rotations; bucket += 1) {
    const w = tailWindow({ total, headSize: 100, tailSize: 100, now: bucket * ROTATION_BUCKET_MS });
    assert.ok(w.offset >= 100, 'the tail never overlaps the head');
    for (let r = w.offset; r < Math.min(total, w.offset + 100); r += 1) visited.add(r);
  }
  assert.equal(visited.size, 900, 'every row beyond the head is covered once per cycle');
  assert.equal(
    tailWindow({ total, headSize: 100, tailSize: 100, now: rotations * ROTATION_BUCKET_MS }).offset,
    tailWindow({ total, headSize: 100, tailSize: 100, now: 0 }).offset,
    'and the cycle repeats'
  );
});

// --- SLA sweep ---------------------------------------------------------------------------

function slaDb({ poison = 0, good = 0, notDue = 0, nullAck = 0, missingIntegration = 0, actioned = 0 }) {
  const mappings = [];
  const leads = [];
  const add = (tag, minutesOld, extra = {}, leadStatus = 'Not Contacted') => {
    const id = `${tag}-${pad(mappings.length)}`;
    mappings.push({
      zoho_lead_id: id, dealer_code: 'D1', integration_id: '1000', sync_status: 'SYNCED',
      last_synced_at: utc(BASE_NOW - minutesOld * 60 * 1000), ...extra,
    });
    leads.push({ crm_record_id: id, lead_status: leadStatus, sync_status: 'SYNCED' });
  };
  // Oldest first: the stuck ("poison") rows sit at the very front of the queue.
  for (let i = 0; i < nullAck; i += 1) add('null', 0, { last_synced_at: null });
  for (let i = 0; i < poison; i += 1) add('poison', 60 * 24 * 10 - i);
  for (let i = 0; i < missingIntegration; i += 1) add('noint', 60 * 24 * 9 - i, { integration_id: null });
  for (let i = 0; i < actioned; i += 1) add('actioned', 60 * 24 * 8 - i, {}, 'Contacted');
  for (let i = 0; i < good; i += 1) add('good', 60 * 24 * 7 - i);
  for (let i = 0; i < notDue; i += 1) add('fresh', 60 - (i % 50));
  return createInMemoryZcql({
    lead_integrations: mappings,
    leads,
    dealer_integrations: [{ dealer_code: 'D1', status: 'ACTIVE' }],
  });
}

function slaMocks(t) {
  const oemCalls = [];
  const scenarios = [];
  t.mock.method(oemCrmService, 'updateOemLead', async (id) => {
    oemCalls.push(id);
    if (String(id).startsWith('poison')) throw new Error('Zoho: record cannot be updated');
    return { status: 'success' };
  });
  t.mock.method(crmIntegrationService, 'recordScenario', async (_app, args) => { scenarios.push(args); });
  return { oemCalls, scenarios };
}

async function runSlaSweeps(db, count, startOffsetMs = 0) {
  const results = [];
  for (let i = 0; i < count; i += 1) {
    _resetForTests();
    results.push(await slaMonitorService.runSlaSweep(db.app, new Date(BASE_NOW + startOffsetMs + i * ROTATION_BUCKET_MS)));
  }
  return results;
}

const mappingByPrefix = (db, prefix) => db.tables.lead_integrations.filter((m) => m.zoho_lead_id.startsWith(prefix));

test('SLA: the old fixed window would never reach rows behind 250 stuck ones', async () => {
  const db = slaDb({ poison: 250, good: 100 });
  const oldWindow = await db.app.zcql().executeZCQLQuery(
    "SELECT * FROM lead_integrations WHERE sync_status = 'SYNCED' ORDER BY last_synced_at ASC LIMIT 1, 200"
  );
  assert.equal(oldWindow.length, 200);
  assert.ok(oldWindow.every((r) => r.lead_integrations.zoho_lead_id.startsWith('poison')), 'the whole old window is stuck rows');
});

test('SLA: every workable overdue mapping is breached even with more stuck rows ahead than a window holds', async (t) => {
  const { oemCalls, scenarios } = slaMocks(t);
  const db = slaDb({ poison: 250, good: 100 });
  const poisonBefore = mappingByPrefix(db, 'poison').map((m) => m.last_synced_at);

  const results = await runSlaSweeps(db, 8);

  const good = mappingByPrefix(db, 'good');
  assert.ok(good.every((m) => m.sync_status === 'SLA_BREACH'), 'all 100 workable rows were breached');
  assert.ok(results.slice(0, 6).some((r) => r.breached > 0), 'progress starts immediately');
  assert.equal(results.reduce((n, r) => n + r.breached, 0), 100);

  // Idempotent: each lead was written to the OEM CRM once as a breach, never repeated.
  const goodCalls = oemCalls.filter((id) => id.startsWith('good'));
  assert.equal(goodCalls.length, 100);
  assert.equal(new Set(goodCalls).size, 100);
  assert.equal(scenarios.length, 100);
  assert.ok(scenarios.every((s) => s.scenarioCode === 'Unhappy 10' && s.dealerCode === 'D1'));

  // Evidence untouched: the stuck rows were never rewritten.
  assert.deepEqual(mappingByPrefix(db, 'poison').map((m) => m.last_synced_at), poisonBefore);
  assert.ok(mappingByPrefix(db, 'poison').every((m) => m.sync_status === 'SYNCED'));
});

test('SLA: each sweep still reads a bounded number of rows however large the backlog', async (t) => {
  slaMocks(t);
  const db = slaDb({ poison: 900, good: 300 });
  await runSlaSweeps(db, 1);
  const reads = db.queries.filter((q) => /^SELECT \* FROM lead_integrations WHERE sync_status = 'SYNCED'/.test(q));
  assert.ok(reads.length <= 2, 'one head read and at most one tail read');
  assert.ok(reads.every((q) => /LIMIT \d+, 100$/.test(q)), 'each read is 100 rows');
  assert.ok(reads.every((q) => q.includes('last_synced_at <')), 'only overdue mappings are read');
});

test('SLA: not-yet-due rows and rows with no acknowledgement time are never read or touched', async (t) => {
  const { oemCalls } = slaMocks(t);
  const db = slaDb({ good: 3, notDue: 2000, nullAck: 150 });
  const nullBefore = mappingByPrefix(db, 'null').map((m) => ({ ...m }));

  const [result] = await runSlaSweeps(db, 1);

  assert.equal(result.candidates, 3);
  assert.equal(result.breached, 3);
  assert.equal(result.skippedNotDue, 0, 'no wasted reads of fresh mappings');
  assert.deepEqual(oemCalls.sort(), mappingByPrefix(db, 'good').map((m) => m.zoho_lead_id).sort());
  assert.deepEqual(mappingByPrefix(db, 'null'), nullBefore, 'rows with a missing timestamp are left alone and do not block');
});

test('SLA: a mapping with no integration is rotated out instead of failing on every sweep', async (t) => {
  slaMocks(t);
  const db = slaDb({ missingIntegration: 5, good: 2 });
  const [first, second] = await runSlaSweeps(db, 2);

  assert.equal(first.failed, 0);
  assert.equal(first.skippedUnhealthy, 5);
  assert.equal(first.breached, 2);
  assert.equal(second.candidates, 0, 'rotated rows are no longer overdue next sweep');
});

test('SLA: already-actioned leads rotate out and are not breached; dealer scope is preserved', async (t) => {
  const { oemCalls } = slaMocks(t);
  const db = slaDb({ actioned: 4, good: 2 });
  db.tables.lead_integrations.push({
    zoho_lead_id: 'other-dealer', dealer_code: 'D2', integration_id: '1000', sync_status: 'SYNCED',
    last_synced_at: utc(BASE_NOW - 5 * 24 * HOUR),
  });
  db.tables.leads.push({ crm_record_id: 'other-dealer', lead_status: 'Not Contacted', sync_status: 'SYNCED' });

  const [first] = await runSlaSweeps(db, 1);
  assert.equal(first.skippedActioned, 4);
  assert.equal(first.breached, 3, 'the two good leads and the other dealer\'s overdue lead are all legitimately breached');
  assert.ok(!oemCalls.some((id) => id.startsWith('actioned')));
  const breachedDealers = db.tables.lead_integrations.filter((m) => m.sync_status === 'SLA_BREACH').map((m) => m.dealer_code);
  assert.deepEqual(breachedDealers.sort(), ['D1', 'D1', 'D2'], 'each breach stays attributed to its own dealer');
});

// --- routing-hold reprocessing --------------------------------------------------------------

function routingDb({ blockedCount = 40, fixedA = 60, fixedB = 5, noDealer = 12 }) {
  const integ = (dealer_code, status, MODIFIEDTIME) => ({ dealer_code, status, integration_type: 'EXTERNAL_CRM', MODIFIEDTIME });
  const leads = [];
  const hold = (dealer, n, tag, MODIFIEDTIME) => {
    for (let i = 0; i < n; i += 1) {
      leads.push({ crm_record_id: `${tag}-${i}`, dealer_code: dealer, sync_status: 'ROUTING_HOLD', MODIFIEDTIME: `${MODIFIEDTIME}:${pad(i, 3)}` });
    }
  };
  // The OLDEST holds belong to a dealer that is still not configured, so they can
  // never be delivered — exactly the rows that used to fill the 20-row window.
  hold('BLOCKED', blockedCount, 'blocked', '2026-09-20 08:00:00');
  hold('', noDealer, 'nodealer', '2026-09-21 08:00:00');
  hold('FIXED-A', fixedA, 'fixedA', '2026-09-25 08:00:00');
  hold('FIXED-B', fixedB, 'fixedB', '2026-09-26 08:00:00');
  hold('STALE-C', 30, 'staleC', '2026-10-05 08:00:00'); // held AFTER the dealer's last change
  return createInMemoryZcql({
    leads,
    dealer_integrations: [
      integ('BLOCKED', 'NOT_CONFIGURED', '2026-10-08 08:00:00:000'),
      integ('FIXED-A', 'ACTIVE', '2026-10-08 08:00:00:000'),
      integ('FIXED-B', 'ACTIVE', '2026-10-08 08:00:00:000'),
      integ('STALE-C', 'ACTIVE', '2026-10-01 08:00:00:000'),
    ],
  });
}

function routingMocks(t, db) {
  const attempts = [];
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async (_app, code) =>
    db.tables.dealer_integrations.find((d) => d.dealer_code === code) || null);
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async (app, _integration, leadRow) => {
    attempts.push(leadRow.crm_record_id);
    const idx = db.tables.leads.findIndex((l) => l.crm_record_id === leadRow.crm_record_id);
    await app.datastore().table('leads').updateRow({ ROWID: String(1000 + idx), sync_status: 'SYNCED' });
    return { ok: true };
  });
  return attempts;
}

test('routing holds: the old 20-row window only ever contained the unfixable oldest leads', async () => {
  const db = routingDb({});
  const old = await db.app.zcql().executeZCQLQuery(
    "SELECT * FROM leads WHERE sync_status = 'ROUTING_HOLD' ORDER BY MODIFIEDTIME ASC LIMIT 1, 20"
  );
  assert.ok(old.every((r) => r.leads.dealer_code === 'BLOCKED'));
});

test('routing holds: leads of dealers that have been fixed are delivered; unfixable ones never block them', async (t) => {
  const db = routingDb({});
  const attempts = routingMocks(t, db);
  t.mock.timers.enable({ apis: ['Date'], now: BASE_NOW });

  const sweeps = [];
  for (let i = 0; i < 6; i += 1) {
    sweeps.push(await outboundRetryScheduler._test.reprocessRoutingHolds(db.app));
    t.mock.timers.tick(ROTATION_BUCKET_MS);
  }

  assert.ok(sweeps.every((s) => s.attempted <= 20), 'never more than 20 attempts in one sweep');
  assert.ok(attempts.every((id) => id.startsWith('fixedA') || id.startsWith('fixedB')), 'only fixed dealers\' leads are attempted');
  assert.equal(attempts.filter((id) => id.startsWith('fixedA')).length, 60);
  assert.equal(attempts.filter((id) => id.startsWith('fixedB')).length, 5);
  assert.equal(new Set(attempts).size, attempts.length, 'each lead is attempted exactly once');
  assert.equal(attempts.some((id) => /^(blocked|nodealer|staleC)/.test(id)), false, 'unfixable, dealer-less and not-yet-changed holds are left alone');
  assert.equal(db.tables.leads.filter((l) => l.sync_status === 'ROUTING_HOLD').length, 40 + 12 + 30);
});

test('routing holds: a dealer with 5 held leads is served in the first sweep, not after the dealer with 60 drains', async (t) => {
  const db = routingDb({ fixedA: 60, fixedB: 5 });
  const attempts = routingMocks(t, db);
  t.mock.timers.enable({ apis: ['Date'], now: BASE_NOW });

  const first = await outboundRetryScheduler._test.reprocessRoutingHolds(db.app);
  assert.equal(attempts.filter((id) => id.startsWith('fixedB')).length, 5, 'the small dealer gets its share in the very first sweep');
  assert.equal(attempts.filter((id) => id.startsWith('fixedA')).length, 15, 'the large dealer uses the rest of the 20-lead budget');
  assert.equal(first.attempted, 20);
});

test('routing holds: a lead that is re-held after an attempt stops being a candidate (no endless retry)', async (t) => {
  const db = routingDb({ blockedCount: 0, noDealer: 0, fixedA: 3, fixedB: 0 });
  const attempts = [];
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async (_a, code) => db.tables.dealer_integrations.find((d) => d.dealer_code === code));
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async (app, _i, leadRow) => {
    attempts.push(leadRow.crm_record_id);
    const idx = db.tables.leads.findIndex((l) => l.crm_record_id === leadRow.crm_record_id);
    // still not deliverable: re-held, which bumps MODIFIEDTIME past the integration's
    await app.datastore().table('leads').updateRow({ ROWID: String(1000 + idx), MODIFIEDTIME: '2026-10-09 09:00:00:000' });
    return { ok: false };
  });

  await outboundRetryScheduler._test.reprocessRoutingHolds(db.app);
  await outboundRetryScheduler._test.reprocessRoutingHolds(db.app);
  assert.equal(attempts.length, 3, 'attempted once each, not on every sweep');
});

// --- inbound replay -----------------------------------------------------------------------------

function replayDb({ awaiting = 300, workable = 120, dealers = 8 }) {
  const integrations = Array.from({ length: dealers }, (_, i) => ({ dealer_code: `D${i}`, integration_type: 'EXTERNAL_CRM', status: 'ACTIVE' }));
  const logs = [];
  const mappings = [];
  let t = BASE_NOW - 30 * 24 * HOUR;
  const row = (tag, i, error, last_error) => {
    const integration_id = String(1000 + (i % dealers));
    const external_lead_id = `${tag}-${i}`;
    logs.push({
      integration_id, external_lead_id, happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
      error_message: error, CREATEDTIME: `${utc(t)}:000`, MODIFIEDTIME: '',
    });
    mappings.push({ integration_id, external_crm_lead_id: external_lead_id, last_error, MODIFIEDTIME: '' });
    t += 60 * 1000;
  };
  // The OLDEST failures are waiting for a status mapping that was never approved:
  // they stay FAILED indefinitely and used to fill the whole 200-row window.
  for (let i = 0; i < awaiting; i += 1) row('awaiting', i, 'STATUS_MAPPING_NOT_FOUND: dealer status "Mystery"', 'UNMAPPED_STATUS');
  for (let i = 0; i < workable; i += 1) row('workable', i, 'EXTERNAL_CRM_UNREACHABLE', '');
  return createInMemoryZcql({
    integration_logs: logs,
    dealer_integrations: integrations,
    lead_integrations: mappings,
    integration_status_mappings: [],
  });
}

test('replay: the old oldest-200 window contained none of the recoverable failures', async () => {
  const db = replayDb({});
  const old = await db.app.zcql().executeZCQLQuery(
    "SELECT * FROM integration_logs WHERE happy_unhappy_path_name IN ('Unhappy 4', 'Unhappy 7', 'Unhappy 9') AND status = 'FAILED' ORDER BY CREATEDTIME ASC LIMIT 1, 200"
  );
  assert.equal(old.length, 200);
  assert.ok(old.every((r) => r.integration_logs.external_lead_id.startsWith('awaiting')));
});

test('replay: recoverable failures behind hundreds of stuck ones are all replayed, once each', async (t) => {
  const db = replayDb({ awaiting: 300, workable: 120 });
  const replayed = [];
  t.mock.method(crmIntegrationService, 'replayInboundLead', async (_app, _integration, externalLeadId) => {
    replayed.push(externalLeadId);
    return { ok: true };
  });
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  t.mock.timers.enable({ apis: ['Date'], now: BASE_NOW });

  const sweeps = [];
  for (let i = 0; i < 40; i += 1) {
    _resetForTests();
    sweeps.push(await inboundReplayScheduler.runInboundReplaySweep(db.app));
    t.mock.timers.tick(ROTATION_BUCKET_MS);
    if (db.tables.integration_logs.filter((l) => l.external_lead_id.startsWith('workable') && l.status === 'FAILED').length === 0) break;
  }

  const workable = db.tables.integration_logs.filter((l) => l.external_lead_id.startsWith('workable'));
  assert.ok(workable.every((l) => l.status === 'RECOVERED'), 'every recoverable failure was replayed and closed');
  assert.equal(replayed.length, 120);
  assert.equal(new Set(replayed).size, 120, 'no lead was replayed twice');
  assert.ok(sweeps.every((s) => s.attempted <= 20), 'per-sweep budget (20) respected');
  assert.ok(db.tables.integration_logs.filter((l) => l.external_lead_id.startsWith('awaiting')).every((l) => l.status === 'FAILED'),
    'rows awaiting a mapping are left open for the humans who own them');
  assert.ok(sweeps.every((s) => s.queued <= 200), 'a sweep never reads more than 200 rows');
});

test('replay: a sweep reads head + one rotating slice, never the whole queue', async (t) => {
  const db = replayDb({ awaiting: 600, workable: 0 });
  t.mock.method(crmIntegrationService, 'replayInboundLead', async () => ({ ok: true }));
  _resetForTests();
  await inboundReplayScheduler.runInboundReplaySweep(db.app);

  const reads = db.queries.filter((q) => q.startsWith('SELECT * FROM integration_logs'));
  assert.equal(reads.length, 2, 'head slice and tail slice');
  assert.ok(reads.every((q) => /LIMIT \d+, 100$/.test(q)));
  assert.ok(db.queries.some((q) => /^SELECT COUNT\(ROWID\) FROM integration_logs/.test(q)));
});

// --- complete reads in cron jobs ------------------------------------------------------------------

test('a job that must see every row reads past the 300-row cut-off of a bare SELECT', async () => {
  const rows = Array.from({ length: 650 }, (_, i) => ({ dealer_code: `Z${i}`, integration_type: 'EXTERNAL_CRM', crm_type: 'ZOHO_CRM' }));
  const db = createInMemoryZcql({ dealer_integrations: rows });

  const bare = await db.app.zcql().executeZCQLQuery("SELECT * FROM dealer_integrations WHERE integration_type = 'EXTERNAL_CRM' AND crm_type = 'ZOHO_CRM'");
  assert.equal(bare.length, 300, 'the old webhook-renewal query silently stopped at 300 dealers');

  const all = await dashboardStats.selectEveryRow(
    db.app, 'dealer_integrations', "WHERE integration_type = 'EXTERNAL_CRM' AND crm_type = 'ZOHO_CRM'", 'ORDER BY ROWID ASC', 5000
  );
  assert.equal(all.length, 650);
  assert.equal(new Set(all.map((r) => r.dealer_code)).size, 650);
});
