'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const notifications = require('../services/notificationService');
const routes = require('../routes/notificationRoutes');

const scope = { userId: 'u1', role: 'ADMIN' };
const own = (extra = {}) => ({ recipient_user_id: 'u1', recipient_role: '', is_read: false, CREATEDTIME: '2026-10-01 00:00:00', ...extra });
function dbFor(rows) {
  const db = createInMemoryZcql({ notifications: rows });
  const counts = { updates: 0, deletes: 0, active: 0, peak: 0 };
  const original = db.app.datastore;
  db.app.datastore = () => ({ table: (name) => {
    const table = original().table(name);
    const run = async (kind, action) => {
      counts[kind] += 1;
      counts.active += 1;
      counts.peak = Math.max(counts.peak, counts.active);
      try { await Promise.resolve(); return await action(); } finally { counts.active -= 1; }
    };
    return { ...table,
      updateRow: (row) => run('updates', () => table.updateRow(row)),
      deleteRow: (id) => run('deletes', () => table.deleteRow(id)),
    };
  } });
  return { ...db, counts };
}

async function route(db, method, path, { query = {}, id, user = { user_id: 'u1', role_details: { role_name: 'Admin' } } } = {}) {
  const layer = routes.stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  const res = { locals: { catalystApp: db.app, currentUser: user }, statusCode: 200,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await layer.route.stack.at(-1).handle({ params: { id }, query }, res);
  return res;
}

test('individual reads/deletes reject foreign notifications without a datastore mutation', async () => {
  for (const operation of ['markRead', 'deleteNotification']) {
    const db = dbFor([own({ recipient_user_id: 'another-user' }), own({ recipient_user_id: '', recipient_role: 'SUPER_ADMIN' })]);
    for (const id of ['1000', '1001', '999999', "1000' OR '1'='1"]) {
      await assert.rejects(notifications[operation](db.app, id, scope), (err) => err.statusCode === 404);
    }
    assert.equal(db.counts.updates + db.counts.deletes, 0);
    assert.equal(db.tables.notifications.every((row) => row.is_read === false), true);
  }
});

test('own and same-role broadcast rows remain accessible, and a repeated read costs no second write', async () => {
  const db = dbFor([own(), own({ recipient_user_id: '', recipient_role: 'ADMIN' })]);
  await notifications.markRead(db.app, '1000', scope);
  await notifications.markRead(db.app, '1000', scope);
  assert.equal(db.counts.updates, 1);
  await notifications.deleteNotification(db.app, '1001', scope);
  assert.equal(db.counts.deletes, 1);
});

test('missing identity fails closed and unknown roles cannot match empty broadcast recipients', async () => {
  const db = dbFor([own(), own({ recipient_user_id: 'u2' })]);
  await assert.rejects(notifications.listForUser(db.app, { role: 'ADMIN' }), (err) => err.statusCode === 401);
  await assert.rejects(notifications.markRead(db.app, '1000'), (err) => err.statusCode === 401);
  const rows = await notifications.listForUser(db.app, { userId: 'u1', role: '' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient_user_id, 'u1');
});

test('list uses stable ordering and scoped total unread count includes rows beyond the newest 50', async () => {
  const db = dbFor([...Array.from({ length: 250 }, () => own()), own({ recipient_user_id: 'u2' })]);
  const rows = await notifications.listForUser(db.app, scope);
  assert.equal(rows.length, 50);
  assert.equal(rows[0].ROWID, '1249');
  assert.equal(await notifications.countUnreadForUser(db.app, scope), 250);
  const response = await route(db, 'get', '/notifications');
  assert.equal(response.body.unreadCount, 250);
  assert.equal(response.body.notifications.length, 50);
});

test('unread tab fetch reaches old unread rows behind more than 200 already-read rows', async () => {
  const db = dbFor([own(), ...Array.from({ length: 250 }, () => own({ is_read: true }))]);
  const response = await route(db, 'get', '/notifications', { query: { unreadOnly: 'true' } });
  assert.equal(response.body.notifications.length, 1);
  assert.equal(response.body.notifications[0].ROWID, '1000');
  assert.equal(response.body.unreadCount, 1);
});

test('mark-all drains 450 unread rows in three pages, writes each once and preserves other recipients', async () => {
  const db = dbFor([...Array.from({ length: 450 }, () => own()), own({ is_read: true }), own({ recipient_user_id: 'u2' })]);
  assert.deepEqual(await notifications.markAllRead(db.app, scope), { markedRead: 450, hasMore: false });
  assert.equal(db.counts.updates, 450);
  assert.ok(db.counts.peak <= 5);
  assert.equal(db.tables.notifications.at(-1).is_read, false);
  assert.equal(db.queries.filter((sql) => sql.includes('SELECT * FROM notifications')).length, 3);
  assert.deepEqual(await notifications.markAllRead(db.app, scope), { markedRead: 0, hasMore: false });
  assert.equal(db.counts.updates, 450);
});

test('bulk read bound reports continuation, then a repeated action completes the remaining backlog', async () => {
  const db = dbFor(Array.from({ length: 2101 }, () => own()));
  assert.deepEqual(await notifications.markAllRead(db.app, scope), { markedRead: 2000, hasMore: true });
  assert.equal(await notifications.countUnreadForUser(db.app, scope), 101);
  assert.deepEqual(await notifications.markAllRead(db.app, scope), { markedRead: 101, hasMore: false });
  assert.equal(db.counts.updates, 2101);
  assert.ok(db.counts.peak <= 5);
});

test('clear-all reports a 2,000-row bound and leaves other recipients intact across continuation', async () => {
  const db = dbFor([...Array.from({ length: 2101 }, () => own()), own({ recipient_user_id: 'u2' })]);
  assert.deepEqual(await notifications.clearAllForUser(db.app, scope), { deleted: 2000, hasMore: true });
  assert.equal(db.tables.notifications.filter((row) => !row.__deleted && row.recipient_user_id === 'u1').length, 101);
  assert.deepEqual(await notifications.clearAllForUser(db.app, scope), { deleted: 101, hasMore: false });
  assert.equal(db.tables.notifications.at(-1).recipient_user_id, 'u2');
  assert.equal(db.counts.deletes, 2101);
  assert.ok(db.counts.peak <= 5);
});

test('HTTP mutation wiring passes recipient scope and returns 404 for another role/user', async () => {
  for (const [method, path] of [['post', '/notifications/:id/read'], ['delete', '/notifications/:id']]) {
    const db = dbFor([own({ recipient_user_id: 'u2' })]);
    const denied = await route(db, method, path, { id: '1000' });
    assert.equal(denied.statusCode, 404);
    const anonymous = await route(db, method, path, { id: '1000', user: null });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(db.counts.updates + db.counts.deletes, 0);
  }
});
