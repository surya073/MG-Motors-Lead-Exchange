'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { removeUser } = require('../services/adminUserService');

// removeUser has two jobs:
//   - an Active / Invited user: delete the Catalyst account and mark the row Removed
//   - an already Removed user: clear the greyed-out list entry, touching no account

function buildApp(mapping) {
  const calls = { deleteUser: [], updateRow: [], deleteRow: [] };
  const app = {
    datastore: () => ({
      table: () => ({
        getRow: async () => mapping,
        updateRow: async (row) => {
          calls.updateRow.push(row);
          return row;
        },
        deleteRow: async (rowId) => {
          calls.deleteRow.push(rowId);
        },
      }),
    }),
    userManagement: () => ({
      deleteUser: async (userId) => {
        calls.deleteUser.push(userId);
      },
    }),
  };
  return { app, calls };
}

test('removeUser: an already-Removed entry is deleted from the list and no Catalyst account is touched', async () => {
  const { app, calls } = buildApp({
    ROWID: '111',
    admin_email: 'revoked@example.com',
    invite_status: 'Removed',
    catalyst_user_id: '999',
  });

  const result = await removeUser(app, '111');

  assert.deepEqual(calls.deleteRow, ['111']);
  assert.deepEqual(calls.deleteUser, [], 'must not delete a Catalyst user a second time');
  assert.deepEqual(calls.updateRow, []);
  assert.equal(result.purged, true);
  assert.equal(result.email, 'revoked@example.com');
});

test('removeUser: an Active user is revoked (account deleted, row marked Removed) but not purged', async () => {
  const { app, calls } = buildApp({
    ROWID: '222',
    admin_email: 'active@example.com',
    invite_status: 'Active',
    catalyst_user_id: '888',
  });

  const result = await removeUser(app, '222');

  assert.deepEqual(calls.deleteUser, ['888']);
  assert.equal(calls.updateRow.length, 1);
  assert.equal(calls.updateRow[0].invite_status, 'Removed');
  assert.deepEqual(calls.deleteRow, [], 'the row stays so the revoked user is still listed');
  assert.equal(result.removed, true);
  assert.equal(result.purged, undefined);
});

test('removeUser: an unknown id is rejected', async () => {
  const app = {
    datastore: () => ({ table: () => ({ getRow: async () => { throw new Error('not found'); } }) }),
  };
  await assert.rejects(() => removeUser(app, 'nope'), /No user mapping found/);
});
