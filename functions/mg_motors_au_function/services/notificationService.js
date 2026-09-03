'use strict';

const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');

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

async function listForUser(catalystApp, { userId, role, maxRows = 50 }) {
  const query = `
    SELECT * FROM ${NOTIFICATIONS_TABLE}
    WHERE recipient_user_id = '${userId}' OR recipient_role = '${role}'
    ORDER BY CREATEDTIME DESC
    LIMIT 0, ${maxRows}
  `;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  return result.map((row) => row[NOTIFICATIONS_TABLE]);
}

async function markRead(catalystApp, notificationId) {
  const table = catalystApp.datastore().table(NOTIFICATIONS_TABLE);
  return table.updateRow({ ROWID: notificationId, is_read: true }); // boolean, not 'true'
}

async function markAllRead(catalystApp, { userId, role }) {
  const unread = await listForUser(catalystApp, { userId, role, maxRows: ZCQL_PAGE_SIZE });
  const table = catalystApp.datastore().table(NOTIFICATIONS_TABLE);
  await Promise.all(
    unread
      .filter((n) => n.is_read !== true) // boolean comparison, not string
      .map((n) => table.updateRow({ ROWID: n.ROWID, is_read: true }))
  );
}

async function deleteNotification(catalystApp, notificationId) {
  const table = catalystApp.datastore().table(NOTIFICATIONS_TABLE);
  return table.deleteRow(notificationId);
}

module.exports = { notifyUser, notifyRole, notifyAdmins, listForUser, markRead, markAllRead, deleteNotification };