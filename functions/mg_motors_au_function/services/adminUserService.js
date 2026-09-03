'use strict';

const logger = require('../utils/logger');
const { toCatalystDateTime } = require('../utils/dateFormat');
const { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');

const MAPPING_TABLE = 'admin_user_mapping';

// Role IDs not used in access-control middleware, so not imported from
// requireAdminRole — defined here purely to label existing Catalyst
// accounts during the pre-invite check below.
const APP_USER_ROLE_ID = '37148000000359009';  // App User (Default)
const DEALER_ROLE_ID = '37148000000430005';    // Dealer

// Only these two roles are assignable from this screen. Super Admin can
// promote/demote between them, but never to App User or Dealer here —
// those are separate flows (self-signup / CRM dealer invite).
const ASSIGNABLE_ROLE_IDS = [SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID];

const ROLE_LABELS = {
  [SUPER_ADMIN_ROLE_ID]: 'Super Admin',
  [ADMIN_ROLE_ID]: 'Admin',
};

// Superset used only for labeling *existing* Catalyst accounts found
// during the pre-invite check — includes roles this screen never
// assigns itself (App User, Dealer), unlike ASSIGNABLE_ROLE_IDS above.
const ALL_ROLE_LABELS = {
  ...ROLE_LABELS,
  [APP_USER_ROLE_ID]: 'App User',
  [DEALER_ROLE_ID]: 'Dealer',
};

function roleLabel(roleId) {
  return ROLE_LABELS[String(roleId)] || 'Admin';
}

function labelForAnyRoleId(roleId) {
  return ALL_ROLE_LABELS[String(roleId)] || 'App User';
}

const VALID_INVITE_STATUSES = ['Invited', 'Active', 'Removed'];

function escapeZcql(value) {
  return String(value).replace(/'/g, "''");
}

async function findMappingByEmail(catalystApp, email) {
  const safeEmail = escapeZcql(email);
  const query = `SELECT * FROM ${MAPPING_TABLE} WHERE admin_email = '${safeEmail}' LIMIT 1`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  if (!result || result.length === 0) return null;
  return result[0][MAPPING_TABLE];
}

async function findMappingByRowId(catalystApp, rowId) {
  const table = catalystApp.datastore().table(MAPPING_TABLE);
  try {
    return await table.getRow(rowId);
  } catch {
    return null;
  }
}

/**
 * findCatalystUserByEmail
 * -----------------------------------------------------------------------
 * Catalyst's SDK has no direct "get user by email" call — getUserDetails()
 * only accepts a numeric user ID. getAllUsers() is the only way to check
 * by email, so this scans the full list and matches case-insensitively.
 * Fine at current scale; would want caching or a ZCQL-backed lookup if
 * the org grows into the thousands of users.
 */
async function findCatalystUserByEmail(catalystApp, email) {
  const userManagement = catalystApp.userManagement();
  const allUsers = await userManagement.getAllUsers();
  const target = String(email).toLowerCase();
  return allUsers.find((u) => String(u.email_id).toLowerCase() === target) || null;
}

/**
 * listUsers
 * -----------------------------------------------------------------------
 * Reads our own mapping rows AND cross-checks each non-removed row
 * against live Catalyst state (is_confirmed). Catalyst is the source of
 * truth for whether someone actually finished signup — our own
 * 'Invited' write from inviteUser() never updates on its own, so
 * without this cross-check every user would show "Invited" forever
 * even after they set a password and started using the app.
 *
 * Self-heals: if a row is still 'Invited' locally but Catalyst reports
 * is_confirmed === true, we persist 'Active' back to the datastore so
 * subsequent reads don't need to re-derive it.
 */
async function listUsers(catalystApp) {
  const table = catalystApp.datastore().table(MAPPING_TABLE);
  const userManagement = catalystApp.userManagement();

  const rows = [];
  let nextToken;
  do {
    const page = await table.getPagedRows({ nextToken, maxRows: 100 });
    rows.push(...page.data);
    nextToken = page.more_records ? page.next_token : undefined;
  } while (nextToken);

  let catalystUsers = [];
  try {
    catalystUsers = await userManagement.getAllUsers();
  } catch (err) {
    logger.error('adminUserService', 'getAllUsers failed during listUsers, statuses may be stale', err);
  }
  const catalystById = new Map(catalystUsers.map((u) => [String(u.user_id), u]));

  const results = [];
  for (const row of rows) {
    if (row.invite_status === 'Removed') {
      results.push({ ...row, role_label: roleLabel(row.role_id) });
      continue;
    }

    const catalystUser = catalystById.get(String(row.catalyst_user_id));
    const shouldBeActive = Boolean(catalystUser?.is_confirmed);
    const currentlyActive = row.invite_status === 'Active';

    if (shouldBeActive && !currentlyActive) {
      try {
        const updated = await table.updateRow({ ROWID: row.ROWID, invite_status: 'Active' });
        results.push({ ...updated, role_label: roleLabel(updated.role_id) });
        continue;
      } catch (err) {
        logger.error('adminUserService', `Failed to self-heal status for row ${row.ROWID}`, err);
      }
    }

    results.push({ ...row, role_label: roleLabel(row.role_id) });
  }

  results.sort((a, b) => new Date(b.invited_at || 0) - new Date(a.invited_at || 0));
  return results;
}

/**
 * inviteUser
 * -----------------------------------------------------------------------
 * Two checks before creating anything:
 *   1. Our own mapping table (cheap, catches admins we already invited).
 *   2. Live Catalyst auth (catches Dealer / App User / any other
 *      account that exists outside admin_user_mapping entirely).
 * Only after both come back clear does this call registerUser(). If the
 * subsequent datastore insertRow fails, the Catalyst user is rolled
 * back (deleted) so we never leave an orphaned Catalyst account that
 * blocks re-inviting the same email later.
 */
async function inviteUser(catalystApp, { email, name, permissions }) {
  if (!email) {
    throw new Error('Email is required');
  }

  const existingMapping = await findMappingByEmail(catalystApp, email);
  if (existingMapping && existingMapping.invite_status !== 'Removed') {
    throw new Error(`${email} has already been invited (status: ${existingMapping.invite_status})`);
  }

  const existingCatalystUser = await findCatalystUserByEmail(catalystApp, email);
  if (existingCatalystUser) {
    const roleId = String(existingCatalystUser?.role_details?.role_id || '');

    if (roleId === DEALER_ROLE_ID) {
      throw new Error(
        `${email} already exists as a Dealer user. This screen can't invite existing dealer accounts as admins.`
      );
    }

    throw new Error(
      `${email} already exists as an app user (role: ${labelForAnyRoleId(roleId)}). Use a different email, or manage their role from the existing account instead of inviting again.`
    );
  }

  const userManagement = catalystApp.userManagement();

  const signupConfig = { platform_type: 'web' };
  const userDetails = {
    first_name: name || email.split('@')[0],
    email_id: email,
    role_id: ADMIN_ROLE_ID,
  };

  let registeredUser;
  try {
    registeredUser = await userManagement.registerUser(signupConfig, userDetails);
  } catch (err) {
    logger.error('adminUserService', `Failed to register user for email=${email}`, err);
    throw new Error(`Catalyst user invitation failed: ${err.message}`);
  }

  const catalystUserId = registeredUser?.user_details?.user_id;
  if (!catalystUserId) {
    logger.error('adminUserService', 'registerUser response missing user_id', registeredUser);
    throw new Error('Catalyst did not return a user_id for the invited user');
  }

  const table = catalystApp.datastore().table(MAPPING_TABLE);
  try {
    const mappingRow = await table.insertRow({
      catalyst_user_id: catalystUserId,
      admin_name: name || '',
      admin_email: email,
      permissions: permissions || 'admin_access',
      invited_at: toCatalystDateTime(),
      invite_status: 'Invited',
      role_id: ADMIN_ROLE_ID,
    });
    return { catalystUserId, email, mappingRow };
  } catch (err) {
    logger.error('adminUserService', `Mapping insert failed after Catalyst user created (email=${email}), rolling back`, err);
    try {
      await userManagement.deleteUser(catalystUserId);
    } catch (rollbackErr) {
      logger.error('adminUserService', `Rollback delete also failed for catalystUserId=${catalystUserId}`, rollbackErr);
      throw new Error(
        `Invite partially failed and automatic cleanup also failed. A Catalyst account for ${email} (user_id ${catalystUserId}) may need manual removal in the console. Original error: ${err.message}`
      );
    }
    throw new Error(`Couldn't save the invite record: ${err.message}`);
  }
}

async function resendUserInvite(catalystApp, rowId) {
  const mapping = await findMappingByRowId(catalystApp, rowId);
  if (!mapping) {
    throw new Error('No user mapping found for that id');
  }
  if (mapping.invite_status === 'Active') {
    throw new Error(`${mapping.admin_email} has already accepted the invite — nothing to resend`);
  }
  if (mapping.invite_status === 'Removed') {
    throw new Error(`${mapping.admin_email} was removed — invite them again instead of resending`);
  }

  const userManagement = catalystApp.userManagement();

  try {
    await userManagement.deleteUser(mapping.catalyst_user_id);
  } catch (err) {
    logger.error('adminUserService', `Failed to delete stale unconfirmed user before resend (row ${rowId})`, err);
    throw new Error(`Couldn't clear the previous invite: ${err.message}`);
  }

  const signupConfig = { platform_type: 'web' };
  const userDetails = {
    first_name: mapping.admin_name || mapping.admin_email,
    email_id: mapping.admin_email,
    role_id: mapping.role_id || ADMIN_ROLE_ID,
  };

  let registeredUser;
  try {
    registeredUser = await userManagement.registerUser(signupConfig, userDetails);
  } catch (err) {
    logger.error('adminUserService', `Failed to re-register user for row ${rowId}`, err);
    throw new Error(
      `Catalyst re-invitation failed: ${err.message}. Note: the previous account was already deleted — this row's stored catalyst_user_id is now stale until a new invite succeeds.`
    );
  }

  const catalystUserId = registeredUser?.user_details?.user_id;
  if (!catalystUserId) {
    throw new Error('Catalyst did not return a user_id for the re-invited user');
  }

  const table = catalystApp.datastore().table(MAPPING_TABLE);
  const updatedRow = await table.updateRow({
    ROWID: mapping.ROWID,
    catalyst_user_id: catalystUserId,
    invited_at: toCatalystDateTime(),
    invite_status: 'Invited',
  });

  return { catalystUserId, email: mapping.admin_email, mappingRow: updatedRow };
}

async function removeUser(catalystApp, rowId) {
  const mapping = await findMappingByRowId(catalystApp, rowId);
  if (!mapping) {
    throw new Error('No user mapping found for that id');
  }
  if (mapping.invite_status === 'Removed') {
    throw new Error(`${mapping.admin_email} has already been removed`);
  }

  const userManagement = catalystApp.userManagement();

  try {
    await userManagement.deleteUser(mapping.catalyst_user_id);
  } catch (err) {
    logger.error('adminUserService', `Failed to delete Catalyst user for row ${rowId}`, err);
    throw new Error(`Couldn't revoke Catalyst account: ${err.message}`);
  }

  const table = catalystApp.datastore().table(MAPPING_TABLE);
  const updatedRow = await table.updateRow({
    ROWID: mapping.ROWID,
    invite_status: 'Removed',
  });

  return { email: mapping.admin_email, removed: true, mappingRow: updatedRow };
}

/**
 * updateUser
 * -----------------------------------------------------------------------
 * Edits name and/or role for an existing (non-removed) mapping. Pushes
 * the change to Catalyst via updateUserDetails so it actually affects
 * the user's real permissions, then mirrors it into our own mapping row.
 */
async function updateUser(catalystApp, rowId, { admin_name, role_id }) {
  const mapping = await findMappingByRowId(catalystApp, rowId);
  if (!mapping) {
    throw new Error('No user mapping found for that id');
  }
  if (mapping.invite_status === 'Removed') {
    throw new Error(`${mapping.admin_email} was removed — invite them again instead of editing`);
  }
  if (role_id && !ASSIGNABLE_ROLE_IDS.includes(String(role_id))) {
    throw new Error('Role must be Super Admin or Admin.');
  }

  const userManagement = catalystApp.userManagement();
  const nameToUse = admin_name ?? mapping.admin_name ?? '';
  const [firstName, ...rest] = nameToUse.trim().split(' ');

  try {
    await userManagement.updateUserDetails(mapping.catalyst_user_id, {
      email_id: mapping.admin_email,
      first_name: firstName || mapping.admin_email,
      last_name: rest.join(' ') || '',
      role_id: role_id || mapping.role_id || ADMIN_ROLE_ID,
    });
  } catch (err) {
    logger.error('adminUserService', `Failed to update Catalyst user for row ${rowId}`, err);
    throw new Error(`Couldn't update the user's Catalyst account: ${err.message}`);
  }

  const table = catalystApp.datastore().table(MAPPING_TABLE);
  const updatedRow = await table.updateRow({
    ROWID: rowId,
    admin_name: nameToUse,
    role_id: role_id || mapping.role_id || ADMIN_ROLE_ID,
  });

  return { mappingRow: { ...updatedRow, role_label: roleLabel(updatedRow.role_id) } };
}

module.exports = {
  listUsers,
  inviteUser,
  resendUserInvite,
  removeUser,
  updateUser,
  VALID_INVITE_STATUSES,
  ASSIGNABLE_ROLE_IDS,
  ROLE_LABELS,
};