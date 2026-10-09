'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { mapWithConcurrency } = require('../utils/concurrency');
const notificationService = require('../services/notificationService');
const integrationAlertBatchService = require('../services/integrations/integrationAlertBatchService');
const integrationAlertService = require('../services/integrations/integrationAlertService');
const adminDashboardService = require('../services/adminDashboardService');

// Catalyst answers "429 Concurrency limit reached" when too many Data Store or
// Authentication calls are in flight at once (reproduced against the live
// project). Work whose size depends on the data — "mark 200 notifications read",
// "dequeue 500 alerts", "check every invited dealer" — must therefore run with
// a fixed ceiling on in-flight calls. A tracker records the peak.

function tracker() {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  return {
    async run(fn) {
      inFlight += 1;
      calls += 1;
      peak = Math.max(peak, inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await fn();
      } finally {
        inFlight -= 1;
      }
    },
    get peak() { return peak; },
    get calls() { return calls; },
  };
}

test('mapWithConcurrency: never exceeds the limit, keeps order, runs every item', async () => {
  const t = tracker();
  const items = Array.from({ length: 100 }, (_, i) => i);
  const out = await mapWithConcurrency(items, 5, (n) => t.run(async () => n * 2));
  assert.deepEqual(out, items.map((n) => n * 2), 'results are in input order');
  assert.equal(t.calls, 100);
  assert.ok(t.peak <= 5, `peak ${t.peak}`);
  assert.ok(t.peak >= 2, 'it still runs work in parallel');
});

test('mapWithConcurrency: edge cases (empty, limit above length, junk limit, errors)', async () => {
  assert.deepEqual(await mapWithConcurrency([], 5, async () => 1), []);
  assert.deepEqual(await mapWithConcurrency([1, 2], 50, async (n) => n), [1, 2]);
  assert.deepEqual(await mapWithConcurrency([1, 2, 3], 0, async (n) => n), [1, 2, 3], 'a non-positive limit still makes progress');
  await assert.rejects(mapWithConcurrency([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; }), /boom/);
});

test('notifications: mark-all-read and clear-all write at most 5 rows at a time', async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ ROWID: String(1000 + i), recipient_user_id: 'u1', recipient_role: 'ADMIN', is_read: false }));
  const writes = tracker();
  const app = {
    zcql: () => ({ executeZCQLQuery: async () => rows.map((n) => ({ notifications: n })) }),
    datastore: () => ({
      table: () => ({
        updateRow: (fields) => writes.run(async () => fields),
        deleteRow: (id) => writes.run(async () => id),
      }),
    }),
  };

  await notificationService.markAllRead(app, { userId: 'u1', role: 'ADMIN' });
  assert.equal(writes.calls, 200, 'every notification is marked read');
  assert.ok(writes.peak <= 5, `mark-all peak ${writes.peak}`);

  const before = writes.calls;
  const small = [...rows.slice(0, 120)];
  app.zcql = () => ({ executeZCQLQuery: async () => small.splice(0, 200).map((n) => ({ notifications: n })) });
  const result = await notificationService.clearAllForUser(app, { userId: 'u1', role: 'ADMIN' });
  assert.equal(result.deleted, 120);
  assert.equal(writes.calls - before, 120);
  assert.ok(writes.peak <= 5, `clear-all peak ${writes.peak}`);
});

test('alert queue flush: dequeues 450 rows at most 5 at a time, and one failed delete does not strand the rest', async (t) => {
  const old = '2000-01-01 00:00:00:000';
  const queued = Array.from({ length: 450 }, (_, i) => ({ ROWID: String(1000 + i), CREATEDTIME: old, scenario_code: 'Unhappy 1', dealer_code: 'D1', lead_id: `l${i}`, reason: 'x', priority_for: 'P2' }));
  const deletes = tracker();
  const deleted = [];
  const app = {
    zcql: () => ({ executeZCQLQuery: async () => queued.map((r) => ({ integration_alert_queue: r })) }),
    datastore: () => ({
      table: () => ({
        deleteRow: (id) => deletes.run(async () => {
          if (id === '1007') throw new Error('transient');
          deleted.push(id);
        }),
      }),
    }),
  };
  t.mock.method(integrationAlertService, 'sendConfiguredEmail', async () => ({ sent: true }));

  await integrationAlertBatchService.flushIfWindowElapsed(app);

  assert.equal(deletes.calls, 450, 'every queued row is attempted');
  assert.equal(deleted.length, 449, 'the one that failed does not stop the others');
  assert.ok(deletes.peak <= 5, `dequeue peak ${deletes.peak}`);
});

test('invitation status: checks every invited dealer, but only 5 Catalyst user lookups at a time', async () => {
  const mappings = Array.from({ length: 120 }, (_, i) => ({
    catalyst_user_id: `u${i}`, dealer_code: `D${i}`, invite_status: i < 100 ? 'Invited' : 'Active',
  }));
  const db = createInMemoryZcql({ dealer_user_mapping: mappings });
  const lookups = tracker();
  const app = {
    ...db.app,
    userManagement: () => ({
      getUserDetails: (id) => lookups.run(async () => ({ is_confirmed: Number(id.slice(1)) % 2 === 0 })),
    }),
  };

  const result = await adminDashboardService.getDealerInvitationStatus(
    app,
    mappings.map((m) => ({ dealer_code: m.dealer_code, dealer_name: m.dealer_code }))
  );

  assert.equal(lookups.calls, 100, 'only the Invited rows are looked up');
  assert.ok(lookups.peak <= 5, `lookup peak ${lookups.peak}`);
  const byCode = Object.fromEntries(result.map((r) => [r.dealer_code, r.invite_status]));
  assert.equal(byCode.D0, 'active', 'a confirmed invitee becomes active');
  assert.equal(byCode.D1, 'invited', 'an unconfirmed one stays invited');
  assert.equal(byCode.D110, 'active');
});
