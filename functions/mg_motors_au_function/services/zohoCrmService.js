'use strict';

const axios = require('axios');
const { getZohoConfig, getLeadSyncSince } = require('../config/env');
const { getAccessToken } = require('./zohoAuthService');
const logger = require('../utils/logger');

/**
 * zohoCrmService.js
 * -----------------------------------------------------------------------
 * Thin wrapper around Zoho CRM's REST API.
 */

const DEALER_MASTER_FIELDS = [
  // Confirmed from Zoho Setup > Dealer_Master field list (2026-10-05):
  // "Name" (label "Dealer Master Name") is the module's standard
  // record-title field — the one actually edited when someone renames a
  // dealer in the Zoho UI. "Dealer_Name" is a SEPARATE custom field that
  // is not kept in sync with it (apparently only ever set once, at
  // record creation) — reading only Dealer_Name is why dealer renames in
  // Zoho silently never reached this app. Both are fetched; Name is
  // preferred, Dealer_Name kept as a fallback for any historical record
  // where Name is somehow blank. See dealerSyncService.js/
  // dealerSyncRoutes.js/dealerInviteService.js for where this matters.
  'Name',
  'Dealer_Code',
  'Phone_Number',
  'Email',
  'Dealer_Region',
  'Dealer_State',
  'City_Suburb',
  'Dealer_Stage',
];

// MG OEM org (live metadata, 2026-10-08): the dealer module's API name is
// "Dealers" (label "ANZ Dealer"). The trial org called it Dealer_Master.
const DEALERS_MODULE = 'Dealers';

const CRM_PAGE_SIZE = 200; // Zoho CRM's max allowed per_page

/**
 * Fetches ALL Dealer_Master records from Zoho CRM, paging through
 * info.more_records until exhausted. Dealer count is small today (~15)
 * so this will always be a single page in practice, but paginating
 * unconditionally means it never silently truncates as the count grows —
 * the same class of bug that dropped leads in fetchOemLeads below.
 */
async function fetchDealerMaster() {
  const { apiDomain } = getZohoConfig();
  const accessToken = await getAccessToken();


  const allRecords = [];
  let page = 1;
  let moreRecords = true;

  while (moreRecords) {
    let response;
    try {
      response = await axios.get(`${apiDomain}/crm/v8/${DEALERS_MODULE}`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        params: {
          fields: DEALER_MASTER_FIELDS.join(','),
          page,
          per_page: CRM_PAGE_SIZE,
        },
      });
    } catch (err) {
      logger.error('zohoCrmService', 'Dealers fetch failed', err);
      throw new Error(
        `Zoho CRM API call failed: ${err.response?.data?.message || err.message}`
      );
    }

    const records = response.data?.data || [];
    allRecords.push(...records);

    moreRecords = Boolean(response.data?.info?.more_records);
    page += 1;
  }

  return allRecords;
}

const OEM_LEADS_FIELDS = [
  'Created_Time',
  // MG OEM org: "ANZ Dealer Code" (label) is api_name Franchise_Code.
  'Franchise_Code',
  'Last_Name',
  'First_Name',
  'Mobile',
  'Email',
  'Enquiry_Model',
  // MG OEM org: label "Enquiry Source" is api_name Lead_Source and label
  // "Enquiry Status" is Lead_Status — there is no Enquiry_Source or
  // Enquiry_Status field.
  'Lead_Source',
  'Lead_Status',
  // Lead_Status_Modified_Time is the real api_name — 'Last_Status_Update'
  // does not exist on this module. Zoho silently DROPS unknown names from
  // the `fields` param rather than erroring, so the old value came back
  // absent on every record and last_status_update was permanently blank.
  'Last_Status_Changed',
  // REMOVED, verified absent from the Leads module:
  //   'Assigned_Date'   — no equivalent field exists.
  //   'Dealer_Remarks'  — no equivalent field exists. The nearest home is
  //                       the standard 'Description' textarea, but that is
  //                       an MG mapping decision, not one to make silently.
  'Nature_of_enquiry',
  'Purchase_Classification',
  'Enquiry_Outcome',
  'Lead_Department',
  'Franchise',
  'Enq_ID',
  'Message',
  'Accept_Privacy_Polic',
  'Receive_Offers_Updates',
  'Postcode',
  'Unit_Suite',
  'Variant',
  'Enquiry_Powertrain',
  'Chat_Trascript',
  // Zoho silently DROPS unknown names from `fields` rather than erroring
  // (same class of bug as Lead_Status_Modified_Time above) — this name was
  // simply missing from the allowlist, so every fetch came back with this
  // field absent regardless of what the OEM CRM actually held, and
  // leadSyncService.js's `crmRecord.Dealer_Rejected_Reason || ''` always
  // fell through to ''.
  'Dealer_Rejected_Reason',
];


/**
 * Fetches OEM Leads from Zoho CRM. Zoho v8 refuses `page` beyond the first
 * 2000 records ("You can only get the first 2000 records without using
 * page_token param"), so after page 1 this follows info.next_page_token.
 *
 * With LEAD_SYNC_SINCE set it walks newest-first and stops at the first lead
 * created before the cutoff — the MG org holds ~72k historical leads that
 * must not be mirrored. Records are always returned oldest-first so Happy 3
 * (keep the earliest enquiry, link the later repeat) is unaffected.
 */
async function fetchOemLeads() {
  const { apiDomain } = getZohoConfig();
  const accessToken = await getAccessToken();
  const since = getLeadSyncSince();

  const allRecords = [];
  let pageToken = null;
  let moreRecords = true;
  let reachedCutoff = false;

  while (moreRecords && !reachedCutoff) {
    let response;
    try {
      response = await axios.get(`${apiDomain}/crm/v8/Leads`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        params: {
          fields: OEM_LEADS_FIELDS.join(','),
          per_page: CRM_PAGE_SIZE,
          sort_by: 'Created_Time',
          sort_order: since ? 'desc' : 'asc',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
    } catch (err) {
      logger.error('zohoCrmService', 'OEM_Leads fetch failed', err);
      throw new Error(
        `Zoho CRM API call failed: ${err.response?.data?.message || err.message}`
      );
    }

    const records = response.data?.data || [];
    for (const record of records) {
      if (since && new Date(record.Created_Time) < since) {
        reachedCutoff = true;
        break;
      }
      allRecords.push(record);
    }

    pageToken = response.data?.info?.next_page_token || null;
    moreRecords = Boolean(response.data?.info?.more_records) && Boolean(pageToken);
  }

  return since ? allRecords.reverse() : allRecords;
}

const LEADS_BY_IDS_CHUNK = 100; // Zoho's max `ids` per Get Records call

/** True when `record` was created before the LEAD_SYNC_SINCE cutoff. */
function isBeforeLeadSyncWindow(record, since) {
  if (!since) return false;
  const created = new Date(record.Created_Time);
  return !Number.isNaN(created.getTime()) && created < since;
}

function sortByCreatedTimeAsc(records) {
  return records.sort((a, b) => new Date(a.Created_Time) - new Date(b.Created_Time));
}

/**
 * Fetches only the given Leads records (webhook path). Zoho silently omits
 * ids that no longer exist, so a missing record is simply absent from the
 * result. Records created before LEAD_SYNC_SINCE are dropped, exactly as the
 * full fetch never returns them. Oldest-first, so Happy 3 (earliest enquiry
 * is the original) behaves the same as in a full sync.
 */
async function fetchOemLeadsByIds(ids) {
  const { apiDomain } = getZohoConfig();
  const accessToken = await getAccessToken();
  const since = getLeadSyncSince();
  const unique = [...new Set((ids || []).map(String).filter(Boolean))];

  const records = [];
  for (let i = 0; i < unique.length; i += LEADS_BY_IDS_CHUNK) {
    let response;
    try {
      response = await axios.get(`${apiDomain}/crm/v8/Leads`, {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        params: {
          fields: OEM_LEADS_FIELDS.join(','),
          ids: unique.slice(i, i + LEADS_BY_IDS_CHUNK).join(','),
        },
      });
    } catch (err) {
      logger.error('zohoCrmService', 'OEM_Leads fetch-by-ids failed', err);
      throw new Error(
        `Zoho CRM API call failed: ${err.response?.data?.message || err.message}`
      );
    }
    records.push(...(response.data?.data || []));
  }

  return sortByCreatedTimeAsc(records.filter((record) => !isBeforeLeadSyncWindow(record, since)));
}

/**
 * Fetches Leads modified at/after `modifiedSince` (a Date) using Zoho's
 * If-Modified-Since header, following page_token. Zoho answers 304 with no
 * body when nothing changed, which is an empty result, not an error. Used
 * for webhook recovery and for notifications that carry no record ids.
 */
async function fetchOemLeadsModifiedSince(modifiedSince) {
  const { apiDomain } = getZohoConfig();
  const accessToken = await getAccessToken();
  const since = getLeadSyncSince();
  const header = modifiedSince.toISOString().replace(/\.\d+Z$/, '+00:00');

  const records = [];
  let pageToken = null;
  let moreRecords = true;

  while (moreRecords) {
    let response;
    try {
      response = await axios.get(`${apiDomain}/crm/v8/Leads`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          'If-Modified-Since': header,
        },
        params: {
          fields: OEM_LEADS_FIELDS.join(','),
          per_page: CRM_PAGE_SIZE,
          sort_by: 'Modified_Time',
          sort_order: 'asc',
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
    } catch (err) {
      if (err.response?.status === 304) break;
      logger.error('zohoCrmService', 'OEM_Leads modified-since fetch failed', err);
      throw new Error(
        `Zoho CRM API call failed: ${err.response?.data?.message || err.message}`
      );
    }

    records.push(...(response.data?.data || []));
    pageToken = response.data?.info?.next_page_token || null;
    moreRecords = Boolean(response.data?.info?.more_records) && Boolean(pageToken);
  }

  return sortByCreatedTimeAsc(records.filter((record) => !isBeforeLeadSyncWindow(record, since)));
}

/**
 * Pushes approved fields to a single Leads record in MG Zoho CRM.
 * Dealer_Remarks is deliberately not supported: live metadata confirms
 * that field does not exist, so callers must resolve an approved MG field
 * before attempting to persist dealer remarks.
 */
async function updateOemLead(crmRecordId, fields) {
  const { apiDomain } = getZohoConfig();
  const accessToken = await getAccessToken();

  // Values may contain customer PII; field names are enough to diagnose
  // which mapping produced a write-back request.
  logger.info(
    'zohoCrmService',
    `Updating OEM lead ${crmRecordId}; fields=${Object.keys(fields || {}).join(',')}`
  );

  let response;
  try {
    response = await axios.put(
      `${apiDomain}/crm/v8/Leads/${crmRecordId}`,
      { data: [fields] },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (err) {
    logger.error('zohoCrmService', `OEM_Leads write-back failed for ${crmRecordId}`, err);
    // Unhappy 4 must say which of three categories a failed write-back
    // is. A 400 is Zoho refusing the values (validation at MG); anything
    // else — no response, 401/403 token, 429 limit, 5xx — is transport.
    const httpStatus = err.response?.status;
    const recordError = err.response?.data?.data?.[0];
    const detail = recordError?.message || err.response?.data?.message || err.message;
    const wrapped = new Error(`Zoho CRM update failed: ${detail}`);
    wrapped.writeBackCategory = httpStatus === 400 ? 'VALIDATION' : 'TRANSPORT';
    wrapped.httpStatus = httpStatus;
    wrapped.zohoCode = recordError?.code || err.response?.data?.code;
    throw wrapped;
  }

  const result = response.data?.data?.[0];
  if (result?.status !== 'success') {
    const detail = result?.message || 'Unknown CRM error';
    const rejected = new Error(`Zoho CRM rejected the update: ${detail}`);
    rejected.writeBackCategory = 'VALIDATION';
    rejected.zohoCode = result?.code;
    throw rejected;
  }

  return result;
}

/**
 * Fetches the picklist values configured for a single field on a Zoho
 * CRM module, via the field-metadata API. Used to keep our cached
 * oem_status_picklist table in sync with whatever an admin has
 * configured as valid Lead Status values in Zoho itself, rather than
 * hardcoding them here.
 */
async function fetchFieldPicklistValues(moduleApiName, fieldApiName) {
  const { apiDomain } = getZohoConfig();
  const accessToken = await getAccessToken();

  let response;
  try {
    response = await axios.get(`${apiDomain}/crm/v8/settings/fields`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      params: { module: moduleApiName },
    });
  } catch (err) {
    logger.error('zohoCrmService', `Field metadata fetch failed for ${moduleApiName}`, err);
    throw new Error(`Zoho CRM API call failed: ${err.response?.data?.message || err.message}`);
  }

  const fields = response.data?.fields || [];
  const field = fields.find((f) => f.api_name === fieldApiName);
  if (!field) {
    throw new Error(`Field "${fieldApiName}" not found on module "${moduleApiName}"`);
  }
  if (!Array.isArray(field.pick_list_values)) {
    throw new Error(`Field "${fieldApiName}" is not a picklist field`);
  }

  // Zoho's pick_list_values already carry a "sequence_number" giving
  // display order — preserved so our cached dropdown matches Zoho's own
  // admin-configured ordering, not alphabetical or insertion order.
  return field.pick_list_values.map((v) => ({
    value: v.actual_value,
    displayLabel: v.display_value,
    sequence: v.sequence_number,
  }));
}

module.exports = {
  fetchDealerMaster,
  fetchOemLeads,
  fetchOemLeadsByIds,
  fetchOemLeadsModifiedSince,
  updateOemLead,
  fetchFieldPicklistValues,
};
