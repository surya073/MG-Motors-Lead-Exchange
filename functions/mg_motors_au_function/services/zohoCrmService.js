'use strict';

const axios = require('axios');
const { getZohoConfig } = require('../config/env');
const { getAccessToken } = require('./zohoAuthService');
const logger = require('../utils/logger');

/**
 * zohoCrmService.js
 * -----------------------------------------------------------------------
 * Thin wrapper around Zoho CRM's REST API.
 */

const DEALER_MASTER_FIELDS = [
  'Dealer_Name',
  'Dealer_Code',
  'Phone_Number',
  'Email_Address',
  'Region',
];

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
      response = await axios.get(`${apiDomain}/crm/v8/Dealer_Master`, {
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
      logger.error('zohoCrmService', 'Dealer_Master fetch failed', err);
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
  'Dealer_Code',
  'Customer_Name',
  'Mobile_Number',
  'Email_Address',
  'Vehicle_Model',
  'Lead_Source',
  'Lead_Status',
  'Assigned_Date',
  'Last_Status_Update',
  'Dealer_Remarks',
];

/**
 * Fetches ALL OEM_Leads records from Zoho CRM, paging through
 * info.more_records until exhausted. Previously fetched only page 1 —
 * with default per_page behavior returning 100 records, this silently
 * dropped any leads beyond the first 100 (e.g. 102 in CRM, 100 synced).
 */
async function fetchOemLeads() {
  const { apiDomain } = getZohoConfig();
  const accessToken = await getAccessToken();

  const allRecords = [];
  let page = 1;
  let moreRecords = true;

  while (moreRecords) {
    let response;
    try {
      response = await axios.get(`${apiDomain}/crm/v8/OEM_Leads`, {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
        params: {
          fields: OEM_LEADS_FIELDS.join(','),
          page,
          per_page: CRM_PAGE_SIZE,
        },
      });
    } catch (err) {
      logger.error('zohoCrmService', 'OEM_Leads fetch failed', err);
      throw new Error(
        `Zoho CRM API call failed: ${err.response?.data?.message || err.message}`
      );
    }

    const records = response.data?.data || [];
    allRecords.push(...records);

    moreRecords = Boolean(response.data?.info?.more_records);

    // TEMP DEBUG — remove once the 100-lead cap is confirmed fixed.
    console.log(
      `[DEBUG] fetchOemLeads page ${page}: got ${records.length} records, ` +
      `info=${JSON.stringify(response.data?.info)}`
    );

    page += 1;
  }

  console.log(`[DEBUG] fetchOemLeads total fetched: ${allRecords.length}`);

  return allRecords;
}

/**
 * Pushes a field update to a single OEM_Leads record in Zoho CRM.
 * Used for write-back when a Dealer updates lead_status/dealer_remarks
 * locally — keeps CRM as the eventual source of truth in both
 * directions, not just CRM -> Catalyst.
 */
async function updateOemLead(crmRecordId, fields) {
  const { apiDomain } = getZohoConfig();
  const accessToken = await getAccessToken();

  let response;
  try {
    response = await axios.put(
      `${apiDomain}/crm/v8/OEM_Leads/${crmRecordId}`,
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
    throw new Error(
      `Zoho CRM update failed: ${err.response?.data?.message || err.message}`
    );
  }

  const result = response.data?.data?.[0];
  if (result?.status !== 'success') {
    const detail = result?.message || 'Unknown CRM error';
    throw new Error(`Zoho CRM rejected the update: ${detail}`);
  }

  return result;
}

module.exports = { fetchDealerMaster, fetchOemLeads, updateOemLead };