'use strict';

const logger = require('../utils/logger');
const { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } = require('./requireAdminRole');

/**
 * requireAdminOrViewRole.js
 * -----------------------------------------------------------------------
 * Guards the READ-ONLY Dealer CRM integration endpoints (get config, get
 * field/status mappings, get activity logs) to Admin/Super Admin PLUS the
 * new View User role. Deliberately a separate middleware from
 * requireAdminRole — that one stays exactly as it was and keeps guarding
 * every mutating endpoint (save/connect/test/renew/sync/etc.) to Admin or
 * Super Admin only. View User is view-only: it must never be added to
 * requireAdminRole itself, or it would gain access to every mutation route
 * that middleware also guards.
 *
 * Imports the two admin role IDs from requireAdminRole.js rather than
 * redefining them, so there is a single source of truth and no risk of
 * the IDs drifting apart.
 */
const VIEW_USER_ROLE_ID = '37148000000899033';

const ALLOWED_ROLE_IDS = [SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID, VIEW_USER_ROLE_ID];

function requireAdminOrViewRole(req, res, next) {
  const currentUser = res.locals.currentUser;

  if (!currentUser) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  const roleId = String(currentUser?.role_details?.role_id ?? '');

  if (!roleId || !ALLOWED_ROLE_IDS.includes(roleId)) {
    logger.error('requireAdminOrViewRole', `Access denied for role_id=${roleId}, user=${currentUser.email_id}`);
    return res.status(403).json({ success: false, error: 'Admin, Super Admin, or View User role required' });
  }

  next();
}

module.exports = { requireAdminOrViewRole, VIEW_USER_ROLE_ID };
