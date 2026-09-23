  'use strict';

  const logger = require('../utils/logger');

  const SUPER_ADMIN_ROLE_ID = '37148000000359008';
  const ADMIN_ROLE_ID = '37148000000430003';

  const ALLOWED_ROLE_IDS = [SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID];

  function requireAdminRole(req, res, next) {
    const currentUser = res.locals.currentUser;


    if (!currentUser) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

  const roleId = String(currentUser?.role_details?.role_id ?? '');


    if (!roleId || !ALLOWED_ROLE_IDS.includes(roleId)) {
      logger.error('requireAdminRole', `Access denied for role_id=${roleId}, user=${currentUser.email_id}`);
      return res.status(403).json({ success: false, error: 'Admin or Super Admin role required' });
    }

    next();
  }

  module.exports = { requireAdminRole, SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID };
