'use strict';

const logger = require('../utils/logger');
const { toCatalystDateTime } = require('../utils/dateFormat');

const MAPPING_TABLE = 'dealer_user_mapping';

// Dealer role ID, confirmed from Catalyst Console → Roles (Jul 29, 2026)
const DEALER_ROLE_ID = '37148000000430005';

/**
 * dealerInviteService.js
 * -----------------------------------------------------------------------
 * Super Admin-driven flow: given a CRM Dealer_Master record, creates a
 * Catalyst user (invited via email, assigned the Dealer role) and stores
 * the user-to-dealer mapping so getDealerContext() can resolve
 * dealer_code on future logins.
 *
 * registerUser()'s userDetails type explicitly excludes org_id (self-
 * signup style, single-org project) — confirmed against the SDK's own
 * type definitions, not guessed.
 */

async function findMappingByDealerCode(catalystApp, dealerCode) {
  const safeCode = String(dealerCode).replace(/'/g, "''");
  const query = `SELECT * FROM ${MAPPING_TABLE} WHERE dealer_code = '${safeCode}' LIMIT 1`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  if (!result || result.length === 0) return null;
  return result[0][MAPPING_TABLE];
}

async function inviteDealerUser(catalystApp, crmDealerRecord) {
  const { Dealer_Code, Dealer_Name, Email_Address, id: crmRecordId } = crmDealerRecord;

  if (!Dealer_Code || !Email_Address) {
    throw new Error('CRM dealer record is missing Dealer_Code or Email_Address');
  }

  const existingMapping = await findMappingByDealerCode(catalystApp, Dealer_Code);
  if (existingMapping) {
    throw new Error(`Dealer ${Dealer_Code} already has an invited user (${existingMapping.dealer_email})`);
  }

  const userManagement = catalystApp.userManagement();

  const signupConfig = {
    platform_type: 'web',
  };

  const userDetails = {
    first_name: Dealer_Name || Dealer_Code,
    email_id: Email_Address,
    role_id: DEALER_ROLE_ID,
  };

  let registeredUser;
  try {
    registeredUser = await userManagement.registerUser(signupConfig, userDetails);
  } catch (err) {
    logger.error('dealerInviteService', `Failed to register user for dealer_code=${Dealer_Code}`, err);
    throw new Error(`Catalyst user invitation failed: ${err.message}`);
  }

  const catalystUserId = registeredUser?.user_details?.user_id;
  if (!catalystUserId) {
    logger.error('dealerInviteService', 'registerUser response missing user_id', registeredUser);
    throw new Error('Catalyst did not return a user_id for the invited dealer user');
  }

  const table = catalystApp.datastore().table(MAPPING_TABLE);
  const mappingRow = await table.insertRow({
    catalyst_user_id: catalystUserId,
    crm_record_id: crmRecordId || '',
    dealer_code: Dealer_Code,
    dealer_name: Dealer_Name || '',
    dealer_email: Email_Address,
    invited_at: toCatalystDateTime(),
    invite_status: 'Invited',
  });

  return {
    catalystUserId,
    dealerCode: Dealer_Code,
    dealerEmail: Email_Address,
    mappingRow,
  };
}

/**
 * Resends an invite to a dealer whose Catalyst account is still
 * unconfirmed ('Invited', never completed signup).
 *
 * There is no documented "resend invitation" call in the Catalyst
 * Node SDK's userManagement component (checked against current docs —
 * only registerUser/updateUserDetails/updateUserStatus/deleteUser/
 * resetPassword/forgotPassword are exposed). So this recreates the
 * invite instead: deletes the stale, unconfirmed Catalyst user and
 * calls registerUser() again with the same details, which re-triggers
 * Catalyst's invitation email under a fresh user_id. The existing
 * mapping row is updated in place (not replaced), so dealer_code stays
 * a stable key across resends.
 *
 * Deliberately refuses once invite_status is 'Active' — deleting a
 * dealer's *confirmed* Catalyst account here would revoke real portal
 * access, not resend an invite. "Remove dealer" is the correct action
 * for that case, not this one.
 *
 * NOTE: confirm on a current SDK version whether a dedicated resend
 * method now exists before shipping — delete+recreate works but costs
 * an extra API round trip and a new user_id versus a purpose-built
 * resend call.
 */
async function resendDealerInvite(catalystApp, dealerCode) {
  const mapping = await findMappingByDealerCode(catalystApp, dealerCode);
  if (!mapping) {
    throw new Error(`No dealer mapping found for ${dealerCode}`);
  }

  if (mapping.invite_status && mapping.invite_status.toLowerCase() === 'active') {
    throw new Error(`${dealerCode} has already confirmed their account — there's nothing to resend`);
  }

  const userManagement = catalystApp.userManagement();

  try {
    await userManagement.deleteUser(mapping.catalyst_user_id);
  } catch (err) {
    logger.error('dealerInviteService', `Failed to delete stale unconfirmed user for ${dealerCode} before resend`, err);
    throw new Error(`Couldn't clear the previous invite: ${err.message}`);
  }

  const signupConfig = {
    platform_type: 'web',
  };

  const userDetails = {
    first_name: mapping.dealer_name || dealerCode,
    email_id: mapping.dealer_email,
    role_id: DEALER_ROLE_ID,
  };

  let registeredUser;
  try {
    registeredUser = await userManagement.registerUser(signupConfig, userDetails);
  } catch (err) {
    logger.error('dealerInviteService', `Failed to re-register user for dealer_code=${dealerCode}`, err);
    throw new Error(`Catalyst re-invitation failed: ${err.message}`);
  }

  const catalystUserId = registeredUser?.user_details?.user_id;
  if (!catalystUserId) {
    logger.error('dealerInviteService', 'registerUser response missing user_id on resend', registeredUser);
    throw new Error('Catalyst did not return a user_id for the re-invited dealer user');
  }

  const table = catalystApp.datastore().table(MAPPING_TABLE);
  const updatedRow = await table.updateRow({
    ROWID: mapping.ROWID,
    catalyst_user_id: catalystUserId,
    invited_at: toCatalystDateTime(),
    invite_status: 'Invited',
  });

  return {
    catalystUserId,
    dealerCode,
    dealerEmail: mapping.dealer_email,
    mappingRow: updatedRow,
  };
}

async function getDealerCodeForUser(catalystApp, catalystUserId) {
  const safeId = String(catalystUserId).replace(/'/g, "''");
  const query = `SELECT * FROM ${MAPPING_TABLE} WHERE catalyst_user_id = '${safeId}' LIMIT 1`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  if (!result || result.length === 0) return null;
  return result[0][MAPPING_TABLE].dealer_code || null;
}

/**
 * Removes a dealer's portal access entirely: deletes the Catalyst user
 * account and the mapping row. Used by Super Admin's "Remove dealer"
 * action once a dealer no longer belongs on the platform.
 *
 * NOTE: confirm `deleteUser` is the correct SDK method name/signature
 * before shipping — if the SDK only supports deactivation, swap this
 * for `updateUser(..., { status: 'INACTIVE' })` and keep the mapping
 * row's invite_status as 'Removed' instead of deleting it, so there's
 * still an audit trail of who was once a dealer.
 */
async function removeDealerUser(catalystApp, dealerCode) {
  const safeCode = String(dealerCode).replace(/'/g, "''");
  const query = `SELECT * FROM ${MAPPING_TABLE} WHERE dealer_code = '${safeCode}' LIMIT 1`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);

  if (!result || result.length === 0) {
    throw new Error(`No dealer mapping found for ${dealerCode}`);
  }

  const mappingRow = result[0][MAPPING_TABLE];
  const userManagement = catalystApp.userManagement();

  try {
    await userManagement.deleteUser(mappingRow.catalyst_user_id);
  } catch (err) {
    logger.error('dealerInviteService', `Failed to delete Catalyst user for ${dealerCode}`, err);
    throw new Error(`Couldn't remove Catalyst account: ${err.message}`);
  }

  const table = catalystApp.datastore().table(MAPPING_TABLE);
  await table.deleteRow(mappingRow.ROWID);

  return { dealerCode, removed: true };
}

module.exports = {
  inviteDealerUser,
  resendDealerInvite,
  getDealerCodeForUser,
  removeDealerUser,
};