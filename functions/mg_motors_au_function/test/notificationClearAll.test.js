'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clearAllForUser } = require('../services/notificationService');

function buildApp(batches) {
  const deleted = [];
  let call = 0;
  const app = {
    zcql: () => ({
      executeZCQLQuery: async () => {
        const rows = batches[Math.min(call, batches.length - 1)];
        call += 1;
        return rows.map((r) => ({ notifications: r }));
      },
    }),
    datastore: () => ({
      table: () => ({
        deleteRow: async (rowId) => {
          deleted.push(rowId);
        },
      }),
    }),
  };
  return { app, deleted, queries: () => call };
}

test('clearAllForUser deletes every notification the caller can see and reports the count', async () => {
  const { app, deleted } = buildApp([[{ ROWID: '1' }, { ROWID: '2' }, { ROWID: '3' }]]);
  const result = await clearAllForUser(app, { userId: 'u1', role: 'ADMIN' });
  assert.deepEqual(deleted.sort(), ['1', '2', '3']);
  assert.deepEqual(result, { deleted: 3 });
});

test('clearAllForUser with nothing to clear deletes nothing', async () => {
  const { app, deleted } = buildApp([[]]);
  const result = await clearAllForUser(app, { userId: 'u1', role: 'ADMIN' });
  assert.deepEqual(deleted, []);
  assert.deepEqual(result, { deleted: 0 });
});

test('clearAllForUser keeps going in batches while full pages come back, and stops when they run out', async () => {
  const fullPage = Array.from({ length: 200 }, (_, i) => ({ ROWID: `a${i}` }));
  const lastPage = [{ ROWID: 'b0' }, { ROWID: 'b1' }];
  const { app, deleted, queries } = buildApp([fullPage, lastPage]);
  const result = await clearAllForUser(app, { userId: 'u1', role: 'ADMIN' });
  assert.equal(result.deleted, 202);
  assert.equal(deleted.length, 202);
  assert.equal(queries(), 2);
});
