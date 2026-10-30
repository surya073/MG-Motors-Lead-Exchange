'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

// COST_OPTIMIZATION_PLAN.md, Batch 7 (decision C6): the Super Admin Cost KPIs
// page. Cost data is an uploaded daily summary (scripts/usageReport.js --json)
// plus billing snapshots typed in from the Console, in one small table,
// cost_daily. Lead outcomes come from integration_logs on demand.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const costKpiService = require('../services/costKpiService');
const usageContext = require('../services/usageContext');
const { summarize } = require('../scripts/usageReport');
const costKpiRoutes = require('../routes/costKpiRoutes');
const { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');

const NOW = new Date('2026-10-22T06:30:00Z'); // 12:00 IST, 22 Oct

function db(extra = {}) {
  return createInMemoryZcql({ cost_daily: [], integration_logs: [], ...extra });
}

const usage = (requests, ds, extra = {}) => ({ requests, fetch: 0, fetchRows: 0, insert: 0, update: 0, delete: 0, api: 0, tokenRefresh: 0, idle: 0, unchanged: 0, ...ds, ...extra });
const live = (store) => store.tables.cost_daily.filter((row) => !row.__deleted);

// ---- upload -------------------------------------------------------------------

test('upload: one row per day and route, priced from the counts (an uploaded ₹ is ignored)', async () => {
  const store = db();
  const result = await costKpiService.uploadUsage(store.app, { days: {
    '2026-10-21': { '/webhooks/crm-notify': usage(240, { fetch: 1000, insert: 100 }, { rupees: 999 }) },
  } });
  assert.deepEqual(result, { days: 1, inserted: 1, updated: 0, deleted: 0 });
  const [row] = live(store);
  assert.equal(row.record_type, 'USAGE');
  assert.equal(row.cost_inr, 4.2); // 1000 x 0.0036 + 100 x 0.006
  assert.equal(row.requests, 240);
});

test('re-uploading a day replaces that day only: changed route updated, missing route deleted', async () => {
  const store = db();
  await costKpiService.uploadUsage(store.app, { days: {
    '2026-10-20': { '/a': usage(1, { fetch: 1 }) },
    '2026-10-21': { '/a': usage(1, { fetch: 1 }), '/b': usage(1, { fetch: 1 }) },
  } });
  const result = await costKpiService.uploadUsage(store.app, { days: { '2026-10-21': { '/a': usage(5, { fetch: 9 }) } } });
  assert.deepEqual(result, { days: 1, inserted: 0, updated: 1, deleted: 1 });
  const rows = live(store).map((r) => `${r.usage_day} ${r.route_label} ${r.requests}`).sort();
  assert.deepEqual(rows, ['2026-10-20 /a 1', '2026-10-21 /a 5']);
});

for (const [label, body] of [
  ['no days object', { foo: 1 }],
  ['a bad day', { days: { '21-10-2026': { '/a': usage(1) } } }],
  ['a negative count', { days: { '2026-10-21': { '/a': usage(-1) } } }],
  ['a fractional count', { days: { '2026-10-21': { '/a': usage(1.5) } } }],
  ['only undated lines', { days: { unknown: { '/a': usage(1) } } }],
]) {
  test(`upload rejects ${label} with 400 and writes nothing`, async () => {
    const store = db();
    await assert.rejects(costKpiService.uploadUsage(store.app, body), (err) => err.statusCode === 400);
    assert.deepEqual(live(store), []);
  });
}

// ---- billing snapshots ----------------------------------------------------------

test('billing snapshot: stored with its ₹ for ops; only BILLING rows can be deleted', async () => {
  const store = db();
  const { ROWID } = await costKpiService.addBillingSnapshot(store.app, {
    snapshotAt: '2026-10-22T08:00:00+05:30', fetch: 2355759, update: 271501, insert: 147892, delete: 110429,
  });
  const [row] = live(store);
  assert.equal(row.snapshot_at, '2026-10-22 02:30:00');
  assert.equal(row.usage_day, '2026-10-22');
  assert.equal(row.cost_inr, 11201.35); // matches the 22 Oct Console snapshot (₹11,201)
  await costKpiService.uploadUsage(store.app, { days: { '2026-10-21': { '/a': usage(1) } } });
  const usageRowId = String(1000 + store.tables.cost_daily.findIndex((r) => r.record_type === 'USAGE'));
  await assert.rejects(costKpiService.deleteBillingSnapshot(store.app, usageRowId), (err) => err.statusCode === 404);
  assert.deepEqual(await costKpiService.deleteBillingSnapshot(store.app, ROWID), { deleted: true });
  assert.deepEqual(live(store).map((r) => r.record_type), ['USAGE']);
});

test('billing snapshot rejects a missing or future time', async () => {
  await assert.rejects(costKpiService.addBillingSnapshot(db().app, { fetch: 1 }), (err) => err.statusCode === 400);
  await assert.rejects(costKpiService.addBillingSnapshot(db().app, { snapshotAt: '2999-01-01T00:00:00Z' }), (err) => err.statusCode === 400);
});

// ---- the KPIs -------------------------------------------------------------------

test('KPIs: trend, routes by cost, projection, billing periods, lead outcomes, idle sweeps, credits', async () => {
  const store = db({ integration_logs: [
    ...Array(8).fill({ happy_unhappy_path_name: 'Happy 1' }),
    ...Array(2).fill({ happy_unhappy_path_name: 'Happy 4' }),
    ...Array(1).fill({ happy_unhappy_path_name: 'Unhappy 3' }),
    ...Array(9).fill({ happy_unhappy_path_name: 'Unhappy 5' }),
    { happy_unhappy_path_name: 'Happy 2', direction: 'EXTERNAL_CRM_TO_ZOHO', operation: 'UPDATE_LEAD' },
    { happy_unhappy_path_name: 'Connection Test', operation: 'TEST_CONNECTION' },
    { happy_unhappy_path_name: 'Happy 1', CREATEDTIME: '2026-08-01 10:00:00:000' },
  ].map((row) => ({ direction: 'ZOHO_TO_EXTERNAL_CRM', operation: 'CREATE_LEAD', CREATEDTIME: '2026-10-21 10:00:00:000', ...row })) });

  await costKpiService.uploadUsage(store.app, { days: {
    '2026-10-20': {
      '/webhooks/crm-notify': usage(100, { fetch: 1000 }, { unchanged: 80, credits: { mg: 4000 } }),
      '/cron/fast-recover': usage(10, { insert: 100 }, { idle: 9, tokenRefresh: 2 }),
    },
    '2026-10-21': {
      '/webhooks/crm-notify': usage(100, { fetch: 1000 }, { unchanged: 70, credits: { mg: 3500 } }),
    },
  } });
  await costKpiService.addBillingSnapshot(store.app, { snapshotAt: '2026-10-20T00:00:00+05:30', fetch: 1000000, update: 0, insert: 0, delete: 0 });
  await costKpiService.addBillingSnapshot(store.app, { snapshotAt: '2026-10-22T00:00:00+05:30', fetch: 1002000, update: 0, insert: 0, delete: 0 });

  const kpis = await costKpiService.getCostKpis(store.app, { days: 30, now: NOW });

  assert.deepEqual(kpis.daily.map((d) => [d.day, d.cost]), [['2026-10-20', 4.2], ['2026-10-21', 3.6]]);
  assert.deepEqual(kpis.routes.map((r) => r.route), ['/webhooks/crm-notify', '/cron/fast-recover']);
  assert.equal(kpis.totals.cost, 7.8);
  // Month-to-date 7.8 + average 3.9/day for the 9 days left in October.
  assert.deepEqual(kpis.projection, { monthToDate: 7.8, averageDaily: 3.9, basedOnDays: 2, monthEnd: 42.9 });

  const [period] = kpis.billingPeriods;
  assert.equal(period.billed, 7.2); // 2000 fetches x 0.0036
  assert.equal(period.billedPerDay, 3.6);
  assert.equal(period.metered, 7.8);
  assert.equal(period.gap, -8.3);
  assert.equal(period.sameCycle, true);

  assert.equal(kpis.leads.delivered, 10);
  assert.equal(kpis.leads.outboundEvents, 20, 'inbound, connection tests and older events excluded');
  assert.equal(kpis.leads.nonDeliverableShare, 0.45);
  assert.equal(kpis.leads.recoveryRate, 2 / 3);
  assert.equal(kpis.leads.costPerDelivered, 0.78);

  assert.deepEqual(kpis.sweeps, [{ route: '/cron/fast-recover', runs: 10, idle: 9, idleShare: 0.9 }]);
  assert.deepEqual(kpis.crmNotify, { calls: 200, unchanged: 150 });
  assert.deepEqual(kpis.credits, { mg: { day: '2026-10-21', remaining: 3500 } });
  assert.deepEqual(kpis.tokenRefreshes, [{ day: '2026-10-20', refreshes: 2 }, { day: '2026-10-21', refreshes: 0 }]);
});

test('KPIs: snapshots from different billing cycles are flagged, not subtracted as a negative bill', async () => {
  const store = db();
  await costKpiService.addBillingSnapshot(store.app, { snapshotAt: '2026-09-30T00:00:00+05:30', fetch: 900000, update: 0, insert: 0, delete: 0 });
  await costKpiService.addBillingSnapshot(store.app, { snapshotAt: '2026-10-02T00:00:00+05:30', fetch: 1000, update: 0, insert: 0, delete: 0 });
  const kpis = await costKpiService.getCostKpis(store.app, { now: NOW });
  assert.equal(kpis.billingPeriods[0].sameCycle, false);
  assert.equal(kpis.projection, null, 'no metered days, no projection');
});

// ---- sweep outcome on the usage line ---------------------------------------------

test('a sweep is "worked" only on an outcome that changed something', () => {
  const { usefulWork } = usageContext._test;
  assert.equal(usefulWork({ totalCandidates: 3, attempted: 3, stillFailing: 3, heldByPolicy: 0, recovered: 0 }), 0);
  assert.equal(usefulWork({ slaCheck: { candidates: 16, skippedUnhealthy: 16, breached: 0 }, inboundReplay: { queued: 200, attempted: 0 }, alertBatch: { sent: false } }), 0);
  assert.equal(usefulWork({ recovered: 1, routingHolds: { delivered: 2 }, slaCheck: { breached: 1 }, alertBatch: { sent: true } }), 5);
  assert.equal(usefulWork({ recordsInserted: 0, recordsUpdated: 2 }), 2);
});

test('the sweep outcome is annotated onto the request usage line', async () => {
  await usageContext.runWithContext({}, async (ctx) => {
    usageContext.annotateSweepOutcome({ attempted: 2, recovered: 0 });
    assert.deepEqual(ctx.detail, { outcome: 'idle', work: 0 });
  });
});

test('usageReport sums idle sweeps, unchanged notifications and the lowest credits seen', () => {
  const line = (obj) => `2026-10-21T10:00:00+05:30 [INFO] [usage] ${JSON.stringify(obj)}`;
  const days = summarize([
    line({ route: '/cron/fast-recover', ds: {}, outcome: 'idle', token: { refresh: 1 } }),
    line({ route: '/cron/fast-recover', ds: {}, outcome: 'worked' }),
    line({ route: '/webhooks/crm-notify', ds: { fetch: 1 }, outcome: 'unchanged', credits: { mg: 900 } }),
    line({ route: '/webhooks/crm-notify', ds: { fetch: 1 }, credits: { mg: 850 } }),
  ].join('\n'));
  const day = days['2026-10-21'];
  assert.equal(day['/cron/fast-recover'].idle, 1);
  assert.equal(day['/cron/fast-recover'].tokenRefresh, 1);
  assert.equal(day['/webhooks/crm-notify'].unchanged, 1);
  assert.deepEqual(day['/webhooks/crm-notify'].credits, { mg: 850 });
});

// ---- routes ---------------------------------------------------------------------

async function request(t, store, method, path, body, roleId = SUPER_ADMIN_ROLE_ID) {
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => {
    res.locals.catalystApp = store.app;
    res.locals.currentUser = { email_id: 'a@example.com', role_details: { role_id: roleId } };
    next();
  });
  server.use(costKpiRoutes);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test('routes: Super Admin only (Admin gets 403)', async (t) => {
  const response = await request(t, db(), 'GET', '/admin/cost-kpis', null, ADMIN_ROLE_ID);
  assert.equal(response.status, 403);
});

test('routes: a missing cost_daily table answers 503 COST_TABLE_MISSING, not a crash', async (t) => {
  const store = createInMemoryZcql({ integration_logs: [] });
  const response = await request(t, store, 'GET', '/admin/cost-kpis');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'COST_TABLE_MISSING');
});

test('routes: the live Catalyst wording for a missing table is also a 503 COST_TABLE_MISSING', async (t) => {
  const store = db();
  const execute = store.app.zcql;
  store.app.zcql = () => ({
    executeZCQLQuery: async (sql) => {
      if (sql.includes('FROM cost_daily')) throw new Error('No such Table with the given name exists.');
      return execute().executeZCQLQuery(sql);
    },
  });
  const response = await request(t, store, 'GET', '/admin/cost-kpis');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'COST_TABLE_MISSING');
});

test('routes: upload, snapshot and read round-trip; a bad upload is a 400', async (t) => {
  const store = db();
  assert.equal((await request(t, store, 'POST', '/admin/cost-kpis/usage', { days: { '2026-10-21': { '/a': usage(1, { fetch: 10 }) } } })).status, 200);
  assert.equal((await request(t, store, 'POST', '/admin/cost-kpis/usage', { days: 'x' })).status, 400);
  assert.equal((await request(t, store, 'POST', '/admin/cost-kpis/billing', { snapshotAt: '2026-10-21T10:00:00Z', fetch: 5 })).status, 201);
  const read = await request(t, store, 'GET', '/admin/cost-kpis?days=7');
  assert.equal(read.status, 200);
  assert.equal(read.body.snapshots.length, 1);
});
