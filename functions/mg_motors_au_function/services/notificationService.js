'use strict';

const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');
const { mapWithConcurrency } = require('../utils/concurrency');

const NOTIFICATIONS_TABLE = 'notifications';

async function insertNotification(catalystApp, row) {
  const table = catalystApp.datastore().table(NOTIFICATIONS_TABLE);
  return table.insertRow({
    recipient_user_id: row.recipientUserId || '',
    recipient_role: row.recipientRole || '',
    type: row.type,
    title: row.title,
    message: row.message,
    related_lead_id: row.relatedLeadId || '',
    related_dealer_code: row.relatedDealerCode || '',
    is_read: false, // boolean column — must be an actual boolean, not the string 'false'
    created_time: toCatalystDateTime(),
  });
}

async function notifyUser(catalystApp, { recipientUserId, type, title, message, relatedLeadId, relatedDealerCode }) {
  try {
    if (!recipientUserId) {
      logger.error('notificationService', 'notifyUser called without recipientUserId', { type, title });
      return null;
    }
    return await insertNotification(catalystApp, { recipientUserId, type, title, message, relatedLeadId, relatedDealerCode });
  } catch (err) {
    logger.error('notificationService', `notifyUser failed (type=${type})`, err);
    return null;
  }
}

async function notifyRole(catalystApp, { recipientRole, type, title, message, relatedLeadId, relatedDealerCode }) {
  try {
    return await insertNotification(catalystApp, { recipientRole, type, title, message, relatedLeadId, relatedDealerCode });
  } catch (err) {
    logger.error('notificationService', `notifyRole failed (type=${type}, role=${recipientRole})`, err);
    return null;
  }
}

async function notifyAdmins(catalystApp, { type, title, message, relatedLeadId, relatedDealerCode }) {
  await Promise.all([
    notifyRole(catalystApp, { recipientRole: 'ADMIN', type, title, message, relatedLeadId, relatedDealerCode }),
    notifyRole(catalystApp, { recipientRole: 'SUPER_ADMIN', type, title, message, relatedLeadId, relatedDealerCode }),
  ]);
}

const ZCQL_PAGE_SIZE = 200;
// Bulk row writes (mark all read / clear all) run a few at a time: up to 200 in
// parallel trips Catalyst's concurrency limit.
const NOTIFICATION_WRITE_CONCURRENCY = 5;
const MAX_BULK_BATCHES = 10;

function visibilityCondition({ userId, role } = {}) {
  const id = String(userId ?? '').trim();
  if (!id) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  const quote = (value) => String(value).replace(/'/g, "''");
  const own = `recipient_user_id = '${quote(id)}'`;
  // Unknown roles may read their directly addressed notifications, but must
  // never match an empty recipient_role (used on every directly addressed row).
  return ['ADMIN', 'SUPER_ADMIN', 'DEALER', 'VIEW_USER'].includes(role)
    ? `(${own} OR recipient_role = '${quote(role)}')`
    : `(${own})`;
}

const unreadCondition = '(is_read IS NULL OR is_read = false)';

async function listForUser(catalystApp, { userId, role, maxRows = 50, unreadOnly = false }) {
  const requested = Number(maxRows);
  const limit = Number.isFinite(requested)
    ? Math.min(ZCQL_PAGE_SIZE, Math.max(1, Math.floor(requested)))
    : 50;
  const query = `
    SELECT * FROM ${NOTIFICATIONS_TABLE}
    WHERE ${visibilityCondition({ userId, role })}${unreadOnly ? ` AND ${unreadCondition}` : ''}
    ORDER BY CREATEDTIME DESC, ROWID DESC
    LIMIT 1, ${limit}
  `;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  return result.map((row) => row[NOTIFICATIONS_TABLE]);
}

async function countUnreadForUser(catalystApp, scope) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT COUNT(ROWID) FROM ${NOTIFICATIONS_TABLE} WHERE ${visibilityCondition(scope)} AND ${unreadCondition}`
  );
  return Number(rows[0]?.[NOTIFICATIONS_TABLE]?.['COUNT(ROWID)']) || 0;
}

async function visibleNotification(catalystApp, notificationId, scope) {
  const visible = visibilityCondition(scope);
  const id = String(notificationId ?? '');
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Notification not found'), { statusCode: 404 });
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID, is_read FROM ${NOTIFICATIONS_TABLE} WHERE ROWID = '${id}' AND ${visible} LIMIT 1, 1`
  );
  if (!rows.length) throw Object.assign(new Error('Notification not found'), { statusCode: 404 });
  return rows[0][NOTIFICATIONS_TABLE];
}

async function markRead(catalystApp, notificationId, scope) {
  const notification = await visibleNotification(catalystApp, notificationId, scope);
  if (notification.is_read === true) return notification;
  const table = catalystApp.datastore().table(NOTIFICATIONS_TABLE);
  return table.updateRow({ ROWID: notificationId, is_read: true }); // boolean, not 'true'
}

async function markAllRead(catalystApp, { userId, role }) {
  const table = catalystApp.datastore().table(NOTIFICATIONS_TABLE);
  let markedRead = 0;
  for (let batch = 0; batch < MAX_BULK_BATCHES; batch += 1) {
    // Always fetch the first unread page: writing is_read removes these rows
    // from the next query, so offset paging would skip part of the backlog.
    const unread = await listForUser(catalystApp, { userId, role, maxRows: ZCQL_PAGE_SIZE, unreadOnly: true });
    await mapWithConcurrency(unread, NOTIFICATION_WRITE_CONCURRENCY,
      (n) => table.updateRow({ ROWID: n.ROWID, is_read: true }));
    markedRead += unread.length;
    if (unread.length < ZCQL_PAGE_SIZE) return { markedRead, hasMore: false };
  }
  const remaining = await listForUser(catalystApp, { userId, role, maxRows: 1, unreadOnly: true });
  return { markedRead, hasMore: remaining.length > 0 };
}

async function deleteNotification(catalystApp, notificationId, scope) {
  await visibleNotification(catalystApp, notificationId, scope);
  const table = catalystApp.datastore().table(NOTIFICATIONS_TABLE);
  return table.deleteRow(notificationId);
}

// Removes every notification the caller can see (their own plus their role's).
// Works in batches of ZCQL_PAGE_SIZE, bounded so a huge backlog can never
// turn one click into an unbounded loop. Returns how many were deleted.
async function clearAllForUser(catalystApp, { userId, role }) {
  const table = catalystApp.datastore().table(NOTIFICATIONS_TABLE);
  let deleted = 0;

  for (let batch = 0; batch < MAX_BULK_BATCHES; batch += 1) {
    const rows = await listForUser(catalystApp, { userId, role, maxRows: ZCQL_PAGE_SIZE });
    if (rows.length === 0) return { deleted, hasMore: false };
    await mapWithConcurrency(rows, NOTIFICATION_WRITE_CONCURRENCY, (n) => table.deleteRow(n.ROWID));
    deleted += rows.length;
    if (rows.length < ZCQL_PAGE_SIZE) return { deleted, hasMore: false };
  }

  const remaining = await listForUser(catalystApp, { userId, role, maxRows: 1 });
  return { deleted, hasMore: remaining.length > 0 };
}

module.exports = {
  notifyUser,
  notifyRole,
  notifyAdmins,
  listForUser,
  countUnreadForUser,
  markRead,
  markAllRead,
  deleteNotification,
  clearAllForUser,
};
