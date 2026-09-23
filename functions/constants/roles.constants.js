'use strict';

/**
 * roles.constants.js
 * -----------------------------------------------------------------------
 * Backend mirror of mg-motor-web/src/constants/auth.constants.js's
 * APP_ROLES / CATALYST_ROLE_ID_MAP / CATALYST_ROLE_NAME_MAP.
 *
 * These two files are NOT shared code (separate projects — web app vs.
 * Catalyst function) so they must be kept in sync BY HAND. If a role is
 * ever added/renamed/re-created in the Catalyst console, update BOTH
 * this file and the frontend's auth.constants.js together, or role-based
 * notification targeting will silently break on whichever side you
 * forgot.
 */

const APP_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  DEALER: 'DEALER',
  UNKNOWN: 'UNKNOWN',
};

const CATALYST_ROLE_ID_MAP = {
  '37148000000359008': APP_ROLES.SUPER_ADMIN, // App Administrator
  '37148000000430003': APP_ROLES.ADMIN,        // Admin
  '37148000000430005': APP_ROLES.DEALER,       // Dealer
};

const CATALYST_ROLE_NAME_MAP = {
  'App Administrator': APP_ROLES.SUPER_ADMIN,
  'Admin': APP_ROLES.ADMIN,
  'Dealer': APP_ROLES.DEALER,
};

function normalizeRole(user) {
  if (!user) return APP_ROLES.UNKNOWN;

  const roleId = user?.role_details?.role_id ?? user?.roleId ?? null;
  const roleName = user?.role_details?.role_name ?? user?.roleName ?? null;

  if (roleId && CATALYST_ROLE_ID_MAP[roleId]) return CATALYST_ROLE_ID_MAP[roleId];
  if (roleName && CATALYST_ROLE_NAME_MAP[roleName]) return CATALYST_ROLE_NAME_MAP[roleName];
  return APP_ROLES.UNKNOWN;
}

module.exports = { APP_ROLES, CATALYST_ROLE_ID_MAP, CATALYST_ROLE_NAME_MAP, normalizeRole };