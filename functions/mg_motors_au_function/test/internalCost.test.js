'use strict';

// Internal cost module (23 Oct 2026): hourly usage totals saved by
// usageRollup.js and read back by the key-protected /internal/cost page.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const usageRollup = require('../services/usageRollup');
const usageContext = require('../services/usageContext');
const internalCostService = require('../services/internalCostService');
const logger = require('../utils/logger');

const NOW = Date.parse('2026-10-23T05:10:00Z'); // 10:40 IST
const line = (route, extra = {}) => ({
  route, trigger: 'cron', status: 200, ms: 100,
  ds: { fetch: 2, fetchRows: 5, insert: 1, update: 0, delete: 0 },
  api: { mg: 1 }, credits: {}, token: { refresh: 0, hit: 1 }, ...extra,
});

function fakeStore(rows = []) {
  const inserted = [];
  const queries = [];
  return {
    inserted,
    queries,
    app: {
      datastore: () => ({ table: (name) => ({ insertRows: async (list) => { inserted.push(...list.map((r) => ({ table: name, ...r }))); return list; } }) }),
      zcql: () => ({ executeZCQLQuery: async (sql) => {
        queries.push(sql);
        const m = /LIMIT (\d+),(\d+)/.exec(sql);
        const start = Number(m[1]) - 1;
        return rows.slice(start, start + Number(m[2])).map((r) => ({ cost_usage_hourly: r }));
      } }),
    },
  };
}

test.beforeEach(() => usageRollup._test.reset());

test('rollup: lines add up per hour and component; one flush saves them in one insert', async () => {
  usageRollup.record(line('/cron/fast-recover', { outcome: 'idle' }), NOW);
  usageRollup.record(line('/cron/fast-recover', { api: { mg: 2, '725001': 3 }, credits: { mg: 4000 } }), NOW);
  usageRollup.record(line('/webhooks/crm-notify', { status: 500, trigger: 'webhook' }), NOW);
  const store = fakeStore();
  const result = await usageRollup.flush(store.app, NOW);
  assert.deepEqual(result, { inserted: 1 });
  const [row] = store.inserted;
  assert.equal(row.table, 'cost_usage_hourly');
  assert.equal(row.bucket_hour, '2026-10-23 10');
  const payload = JSON.parse(row.payload);
  const fr = payload.components['/cron/fast-recover'];
  assert.equal(fr.requests, 2);
  assert.equal(fr.idle, 1);
  assert.deepEqual(fr.ds, { fetch: 4, fetchRows: 10, insert: 2, update: 0, delete: 0 });
  assert.deepEqual(fr.api, { mg: 3, '725001': 3 });
  assert.equal(payload.components['/webhooks/crm-notify'].errors, 1);
  assert.deepEqual(payload.credits, { mg: 4000 });
  // The save itself is counted under the cost module, for the next flush.
  assert.deepEqual(usageRollup._test.pending().get('2026-10-23 10').components[usageRollup.COST_MODULE].ds.insert, 1);
});

test('rollup: a failed save keeps the totals for the next try', async (t) => {
  t.mock.method(logger, 'error', () => {});
  usageRollup.record(line('/a'), NOW);
  const app = { datastore: () => ({ table: () => ({ insertRows: async () => { throw new Error('boom'); } }) }) };
  assert.equal((await usageRollup.flush(app, NOW)).inserted, 0);
  usageRollup.record(line('/a'), NOW);
  const store = fakeStore();
  await usageRollup.flush(store.app, NOW);
  assert.equal(JSON.parse(store.inserted[0].payload).components['/a'].requests, 2);
});

test('rollup: due 2 minutes after the oldest unsaved request or when the hour changes, not before', () => {
  const start = Date.parse('2026-10-23T05:00:00Z'); // 10:30 IST
  usageRollup.record(line('/a'), start);
  assert.equal(usageRollup._test.isDue(start + 60 * 1000), false);
  assert.equal(usageRollup._test.isDue(start + usageRollup._test.FLUSH_EVERY_MS), true);
  assert.equal(usageRollup._test.isDue(Date.parse('2026-10-23T05:31:00Z')), true); // 11:01 IST: new hour
});

test('rollup: a burst is saved 20 s after its last request (instances live only minutes)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = fakeStore();
  usageRollup.rememberApp(() => store.app);
  usageRollup.record(line('/a'));
  t.mock.timers.tick(10 * 1000);
  usageRollup.record(line('/a')); // the burst continues: the idle clock restarts
  t.mock.timers.tick(15 * 1000);
  assert.equal(store.inserted.length, 0);
  t.mock.timers.tick(usageRollup._test.IDLE_FLUSH_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.inserted.length, 1);
  assert.equal(JSON.parse(store.inserted[0].payload).components['/a'].requests, 2);
  // Its own insert is pending now, but does not start another save.
  t.mock.timers.tick(10 * usageRollup._test.IDLE_FLUSH_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.inserted.length, 1);
  assert.equal(usageRollup._test.isDue(Date.now() + 60 * 60 * 1000), false);
});

test('rollup: a long hour is split into payloads that fit the text column', () => {
  const components = {};
  for (let i = 0; i < 200; i += 1) components[`/route/with/a/long/name/${i}`] = { requests: 1, ds: { fetch: 1 }, api: { mg: 1, '411802': 2 }, token: {} };
  const parts = usageRollup._test.payloads({ components, credits: {} });
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 9000));
  assert.equal(parts.reduce((n, p) => n + Object.keys(JSON.parse(p).components).length, 0), 200);
});

test('rollup: every usage line from the request middleware is recorded', async () => {
  const app = express();
  app.use(usageContext.middleware);
  app.get('/probe', (req, res) => res.json({ ok: true }));
  const listener = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  try {
    await (await fetch(`http://127.0.0.1:${listener.address().port}/probe`)).json();
    await new Promise((r) => setImmediate(r));
  } finally { listener.close(); }
  const hour = [...usageRollup._test.pending().values()][0];
  assert.equal(hour.components['/probe'].requests, 1);
});

test('read: totals per component, hour and org, priced; projection from the window', async () => {
  const rows = [
    { bucket_hour: '2026-10-23 09', payload: JSON.stringify({ components: { '/cron/x': { requests: 4, ms: 400, ds: { fetch: 1000, insert: 10 }, api: { mg: 5 }, token: { refresh: 1 }, idle: 3 } }, credits: { mg: 100 } }) },
    { bucket_hour: '2026-10-23 10', payload: JSON.stringify({ components: { '/cron/x': { requests: 1, ds: { fetch: 0 }, api: { '725001': 2 } }, '/webhooks/y': { requests: 2, ds: { update: 100 } } }, credits: { mg: 90 } }) },
    { bucket_hour: '2026-10-23 10', payload: 'not json' },
  ];
  const store = fakeStore(rows);
  const usage = await internalCostService.getUsage(store.app, { hours: 3, now: NOW });
  assert.equal(usage.from, '2026-10-23 08');
  assert.match(store.queries[0], /bucket_hour >= '2026-10-23 08'/);
  assert.equal(usage.hourly.length, 3);
  assert.equal(usage.unreadable, 1);
  const x = usage.components.find((c) => c.route === '/cron/x');
  assert.equal(x.requests, 5);
  assert.equal(x.api, 7);
  assert.deepEqual(x.apiByOrg, { mg: 5, '725001': 2 });
  assert.equal(x.costInr, 3.66); // 1000 × 0.0036 + 10 × 0.006
  assert.equal(usage.components[0].route, '/cron/x'); // most expensive first
  assert.equal(usage.totals.requests, 7);
  assert.equal(usage.totals.costInr, 4.14); // + 100 × 0.0048
  assert.equal(usage.totals.projectedMonthlyInr, Math.round((4.14 / 3) * 24 * 30 * 100) / 100);
  assert.deepEqual(usage.orgs, [{ org: 'mg', calls: 5 }, { org: '725001', calls: 2 }]);
  assert.deepEqual(usage.credits.mg, { value: 90, hour: '2026-10-23 10' });
});

test('read: pages past 300 rows with the 1-based LIMIT offset', async () => {
  const rows = Array.from({ length: 450 }, () => ({ bucket_hour: '2026-10-23 10', payload: JSON.stringify({ components: { '/a': { requests: 1 } } }) }));
  const store = fakeStore(rows);
  const usage = await internalCostService.getUsage(store.app, { hours: 1, now: NOW });
  assert.equal(usage.totals.requests, 450);
  assert.match(store.queries[1], /LIMIT 301,300/);
});

test('read: hours is clamped to 1..336 and defaults to 24', () => {
  const { clampHours } = internalCostService._test;
  assert.equal(clampHours(undefined), 24);
  assert.equal(clampHours('abc'), 24);
  assert.equal(clampHours(0), 24);
  assert.equal(clampHours(9999), 336);
  assert.equal(clampHours('72'), 72);
});

// ---- routes ---------------------------------------------------------------

async function call(t, { key, path, headers = {} }) {
  const before = process.env.COST_DASHBOARD_KEY;
  if (key === undefined) delete process.env.COST_DASHBOARD_KEY; else process.env.COST_DASHBOARD_KEY = key;
  t.after(() => { if (before === undefined) delete process.env.COST_DASHBOARD_KEY; else process.env.COST_DASHBOARD_KEY = before; });
  const store = fakeStore([{ bucket_hour: '2026-10-23 10', payload: JSON.stringify({ components: { '/a': { requests: 1 } } }) }]);
  t.mock.method(usageContext, 'initialize', () => store.app);
  const routes = require('../routes/internalCostRoutes');
  const app = express();
  app.use(routes);
  const listener = await new Promise((resolve) => { const l = app.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, { headers });
  return { status: response.status, type: response.headers.get('content-type'), text: await response.text(), cache: response.headers.get('cache-control') };
}

test('routes: with no COST_DASHBOARD_KEY set, page and data are 404', async (t) => {
  assert.equal((await call(t, { path: '/internal/cost' })).status, 404);
  assert.equal((await call(t, { path: '/internal/cost/data', headers: { 'X-Internal-Key': '' } })).status, 404);
});

test('routes: the page is served without a key; data needs the right key', async (t) => {
  const page = await call(t, { key: 'k-123', path: '/internal/cost' });
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.text, /<title>Cost Monitor<\/title>/);
  assert.equal(page.text.includes('k-123'), false, 'the key is never in the page');
  assert.equal(page.cache, 'no-store');
  assert.equal((await call(t, { key: 'k-123', path: '/internal/cost/data' })).status, 401);
  assert.equal((await call(t, { key: 'k-123', path: '/internal/cost/data', headers: { 'X-Internal-Key': 'wrong' } })).status, 401);
  const ok = await call(t, { key: 'k-123', path: '/internal/cost/data?hours=6', headers: { 'X-Internal-Key': 'k-123' } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).hours, 6);
});

test('the portal Cost KPIs routes are no longer mounted in index.js', () => {
  const source = require('node:fs').readFileSync(require.resolve('../index.js'), 'utf8');
  assert.equal(/costKpiRoutes/.test(source), false);
  assert.match(source, /app\.use\('\/', internalCostRoutes\)/);
  assert.ok(source.indexOf('internalCostRoutes);') < source.indexOf('usageContext.initialize(catalyst, req);\n      const currentUser'), 'mounted before the user-auth middleware');
});

test('the background save initializes Catalyst in admin scope, not as the portal user', async (t) => {
  const catalyst = require('zcatalyst-sdk-node');
  const store = fakeStore();
  const initCalls = [];
  t.mock.method(catalyst, 'initialize', (req, options) => { initCalls.push(options); return store.app; });
  usageRollup.record(line('/admin/leads', { trigger: 'user' }), Date.now() - 3 * 60 * 1000); // older than FLUSH_EVERY_MS

  const app = express();
  app.use(usageContext.middleware);
  app.get('/probe', (req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  await fetch(`http://127.0.0.1:${server.address().port}/probe`);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(initCalls, [{ scope: 'admin' }]);
  assert.equal(store.inserted.length, 1);
  assert.equal(store.inserted[0].table, 'cost_usage_hourly');
});
