'use strict';

const { fetchFieldPicklistValues } = require('./zohoCrmService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');

const OEM_STATUS_PICKLIST_TABLE = 'oem_status_picklist';

// TODO: confirm this against Zoho Setup → Modules and Fields — could be
// the standard 'Leads' module or a custom one (comments elsewhere in
// this codebase reference 'OEM_Leads' too). Get this wrong and
// fetchFieldPicklistValues will 404.
const LEADS_MODULE = 'Leads';

/**
 * oemPicklistService.js
 * -----------------------------------------------------------------------
 * Caches a single Zoho CRM picklist field's configured values into our
 * own oem_status_picklist table, so the Status Mapping tab's "Our
 * Status" dropdown reflects whatever an admin has set up in Zoho itself
 * — instead of a hardcoded list here that silently drifts out of sync
 * the next time someone adds/renames/removes a status in Zoho.
 *
 * Refresh is admin-triggered (POST .../refresh), not automatic on every
 * page load — picklists change rarely, and this avoids adding a Zoho
 * API round-trip to a page load that already makes several other calls.
 */

async function refreshStatusPicklist(catalystApp, fieldApiName) {
  const values = await fetchFieldPicklistValues(LEADS_MODULE, fieldApiName);
  const now = toCatalystDateTime();
  const table = catalystApp.datastore().table(OEM_STATUS_PICKLIST_TABLE);

  // Delete-all-reinsert here is fine — unlike the mappings save route
  // (fired on every admin edit), this only runs when an admin explicitly
  // clicks "Refresh from CRM", so it won't burn through Datastore delete
  // quota the way the earlier mappings bug did.
  const existing = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID FROM ${OEM_STATUS_PICKLIST_TABLE} WHERE field_api_name = '${fieldApiName}'`
  );
  for (const r of existing) {
    await table.deleteRow(r[OEM_STATUS_PICKLIST_TABLE].ROWID);
  }

  for (const v of values) {
    await table.insertRow({
      field_api_name: fieldApiName,
      value: v.value,
      display_label: v.displayLabel,
      sequence: v.sequence,
      last_synced_at: now,
    });
  }

  logger.info('oemPicklistService', `Refreshed ${fieldApiName} picklist: ${values.length} values cached`);

  return { count: values.length, syncedAt: now };
}

async function getCachedStatusPicklist(catalystApp, fieldApiName) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${OEM_STATUS_PICKLIST_TABLE} WHERE field_api_name = '${fieldApiName}' ORDER BY sequence`
  );
  return rows.map((r) => r[OEM_STATUS_PICKLIST_TABLE]);
}

module.exports = { refreshStatusPicklist, getCachedStatusPicklist };