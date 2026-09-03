'use strict';

const logger = require('../utils/logger');
const { SUPER_ADMIN_ROLE_ID } = require('./requireAdminRole');

/**
 * requireSuperAdminRole.js
 * -----------------------------------------------------------------------
 * Guards the User Management endpoints (invite/resend/remove Dealer
 * access via admin_user_mapping) to Super Admin only.
 *
 * Deliberately a separate middleware from requireAdminRole — that one
 * allows Admin OR Super Admin through (for the CRM dealer-invite flow),
 * this one requires Super Admin specifically, per spec. It imports
 * SUPER_ADMIN_ROLE_ID from requireAdminRole.js itself (now that that
 * file exports it) rather than redefining the constant, so there's a
 * single source of truth and no risk of the two IDs drifting apart.
 */
function requireSuperAdminRole(req, res, next) {
  const currentUser = res.locals.currentUser;

  if (!currentUser) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

 const roleId = String(currentUser?.role_details?.role_id ?? '');


  if (roleId !== SUPER_ADMIN_ROLE_ID) {
    logger.error('requireSuperAdminRole', `Access denied for role_id=${roleId}, user=${currentUser.email_id}`);
    return res.status(403).json({ success: false, error: 'Super Admin access required' });
  }

  next();
}

module.exports = { requireSuperAdminRole };