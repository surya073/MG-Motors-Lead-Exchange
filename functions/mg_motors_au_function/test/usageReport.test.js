'use strict';

// COST_OPTIMIZATION_PLAN.md, Batch 1: the daily sum of `[usage]` lines.

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize, parseUsageLine, dayOf } = require('../scripts/usageReport');

const line = (when, route, ds, extra = '') =>
  `${when} [INFO] [cid=x] [usage] ${JSON.stringify({ cid: 'x', route, ds, api: { mg: 1 }, token: { refresh: 1, hit: 0 } })} ${extra}`;

test('sums ops per IST day and route and prices them at the plan rates', () => {
  const text = [
    line('2026-10-23T18:29:00Z', '/webhooks/crm-notify', { fetch: 10, fetchRows: 3, insert: 1, update: 2, delete: 0 }),
    line('2026-10-23T18:31:00Z', '/webhooks/crm-notify', { fetch: 5, fetchRows: 0, insert: 0, update: 0, delete: 1 }),
    line('2026-10-24 09:00:00', '/cron/fast-recover', { fetch: 64, fetchRows: 0, insert: 16, update: 16, delete: 16 }, 'trailing}'),
    '[INFO] [leadSyncService] not a usage line {"ds":{"fetch":999}}',
  ].join('\n');
  const days = summarize(text);
  assert.deepEqual(Object.keys(days).sort(), ['2026-10-23', '2026-10-24']);
  assert.equal(days['2026-10-23']['/webhooks/crm-notify'].fetch, 10); // 23:59 IST
  const day2 = days['2026-10-24'];
  assert.equal(day2['/webhooks/crm-notify'].delete, 1); // 00:01 IST
  assert.equal(day2['/cron/fast-recover'].requests, 1);
  // 64×0.0036 + 16×0.006 + 16×0.0048 + 16×0.0048 = 0.2304 + 0.096 + 0.0768 + 0.0768
  assert.equal(day2['/cron/fast-recover'].rupees, 0.48);
  assert.equal(day2['/cron/fast-recover'].api, 1);
  assert.equal(day2['/cron/fast-recover'].tokenRefresh, 1);
});

test('parses the usage JSON even with braces inside strings and noise after it', () => {
  assert.deepEqual(parseUsageLine('[INFO] [usage] {"route":"/a}{","ds":{"fetch":1}} extra }'), { route: '/a}{', ds: { fetch: 1 } });
  assert.equal(parseUsageLine('[INFO] [usage] not json'), null);
  assert.equal(dayOf('no timestamp here'), 'unknown');
});
