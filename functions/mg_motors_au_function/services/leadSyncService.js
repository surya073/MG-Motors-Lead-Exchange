'use strict';

const { fetchOemLeads } = require('./zohoCrmService');
const { recordSyncRun } = require('./syncLogService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');
const { notifyAdmins, notifyUser } = require('./notificationService');
const crmIntegrationService = require('./integrations/crmIntegrationService'); // NEW

const LEADS_TABLE = 'leads';
const ZCQL_PAGE_SIZE = 200; // Catalyst ZCQL's max rows per LIMIT clause

/**
 * leadSyncService.js
 * -----------------------------------------------------------------------
 * Same pattern as dealerSyncService.js: fetch from CRM, upsert into
 * Catalyst, log the run. Uniqueness key here is crm_record_id (not
 * dealer_code — leads have no natural business-unique code, unlike
 * dealers), since a dealer can have many leads.
 *
 * NOTE: resolveUsersForDealerCode (from leadAccessService.js) is
 * required LAZILY inside notifyDealerOfNewLead(), not at the top of
 * this file. leadAccessService.js sits in a require chain that loops
 * back here (via dealerLeadRoutes.js), and a top-level require caused
 * Node to hand back a still-initializing exports object — silently
 * making resolveUsersForDealerCode undefined at call time. See:
 * "Warning: Accessing non-existent property 'resolveUsersForDealerCode'
 * of module exports inside circular dependency" in logs. Lazy-requiring
 * inside the function avoids this since by request time the module is
 * already fully loaded and cached.
 */

/**
 * Converts a CRM datetime string (e.g. "2026-07-15T10:30:00+05:30") into
 * the format Catalyst's datetime column accepts. Returns '' if the value
 * is missing or unparseable — callers must strip empty datetime fields
 * before insert/update (see stripEmptyDateFields) since Catalyst's
 * datastore rejects an empty string for a datetime column outright,
 * which previously failed the ENTIRE record over one bad date field.
 */
function toCatalystDateTimeFromCrm(crmDateString) {
  if (!crmDateString) return '';
  const parsed = new Date(crmDateString);
  if (isNaN(parsed.getTime())) return '';
  return toCatalystDateTime(parsed);
}

function mapCrmRecordToLeadRow(crmRecord) {
  return {
    dealer_code: crmRecord.Dealer_Code || '',
    customer_name: crmRecord.Customer_Name || '',
    mobile_number: crmRecord.Mobile_Number || '',
    email_address: crmRecord.Email_Address || '',
    vehicle_model: crmRecord.Vehicle_Model || '',
    lead_source: crmRecord.Lead_Source || '',
    lead_status: crmRecord.Lead_Status || '',
    assigned_date: toCatalystDateTimeFromCrm(crmRecord.Assigned_Date),
    last_status_update: toCatalystDateTimeFromCrm(crmRecord.Last_Status_Update),
    dealer_remarks: crmRecord.Dealer_Remarks || '',
    crm_record_id: crmRecord.id || '',
  };
}

const DATETIME_FIELDS = ['assigned_date', 'last_status_update'];

/**
 * Removes any datetime field left as '' by toCatalystDateTimeFromCrm
 * before the row is sent to insertRow/updateRow. Catalyst's datastore
 * rejects '' for a datetime-typed column ("Invalid input value for
 * assigned_date. datetime value expected"), which previously failed
 * the whole record — including every other valid field on it — just
 * because CRM's Assigned_Date or Last_Status_Update was blank on that
 * one record. Omitting the key entirely leaves the column untouched on
 * update, or unset on insert, instead of failing the sync.
 */
function stripEmptyDateFields(row) {
  const cleaned = { ...row };
  DATETIME_FIELDS.forEach((field) => {
    if (cleaned[field] === '') delete cleaned[field];
  });
  return cleaned;
}

/**
 * Fetches ALL existing leads and returns a Map(crm_record_id -> row) —
 * one ZCQL request per 200 rows rather than one per CRM record. Paged
 * with LIMIT offset,count since a bare `SELECT *` silently caps at 100
 * rows regardless of actual table size — this previously made every
 * lead beyond row 100 invisible to this function, so syncLeads treated
 * already-synced leads as new and tried to re-insert them instead of
 * updating.
 */
async function loadExistingLeadsByCrmId(catalystApp) {
  const map = new Map();
  let offset = 0;

  while (true) {
    const query = `SELECT * FROM ${LEADS_TABLE} LIMIT ${offset}, ${ZCQL_PAGE_SIZE}`;
    const result = await catalystApp.zcql().executeZCQLQuery(query);
    result.forEach((row) => {
      const lead = row[LEADS_TABLE];
      map.set(lead.crm_record_id, lead);
    });

    if (result.length < ZCQL_PAGE_SIZE) break;
    offset += ZCQL_PAGE_SIZE;
  }

  return map;
}

function hasChanges(existingRow, mappedRow) {
  return Object.keys(mappedRow).some((key) => {
    const existingValue = existingRow[key] ?? '';
    const newValue = mappedRow[key] ?? '';
    return String(existingValue) !== String(newValue);
  });
}

async function notifyDealerOfNewLead(catalystApp, { dealerCode, customerName, vehicleModel, leadRowId }) {
  try {
    // Lazy require — see note at top of file re: circular dependency.
    const { resolveUsersForDealerCode } = require('./leadAccessService');

    const userIds = await resolveUsersForDealerCode(catalystApp, dealerCode);
    logger.info('leadSyncService', `resolveUsersForDealerCode("${dealerCode}") returned: ${JSON.stringify(userIds)}`);

    if (userIds.length === 0) {
      logger.error('leadSyncService', `notifyDealerOfNewLead: no dealer_user_mapping rows found for dealer_code="${dealerCode}" — lead ${leadRowId} not notified`);
      return;
    }

    const results = await Promise.all(
      userIds.map((userId) =>
        notifyUser(catalystApp, {
          recipientUserId: userId,
          type: 'LEAD_ASSIGNED',
          title: 'New lead assigned to you',
          message: `${customerName || 'A new customer'}${vehicleModel ? ` — ${vehicleModel}` : ''}`,
          relatedLeadId: leadRowId,
          relatedDealerCode: dealerCode,
        })
      )
    );
    logger.info('leadSyncService', `notifyUser results for dealer_code="${dealerCode}": ${JSON.stringify(results)}`);
  } catch (err) {
    logger.error('leadSyncService', `notifyDealerOfNewLead failed for dealer_code=${dealerCode}`, err);
  }
}

/**
 * Branches a newly-inserted lead: EXTERNAL_CRM dealers get it pushed to
 * their own CRM; PORTAL dealers (the default / existing behaviour) get
 * the existing Catalyst-portal notification, completely unchanged.
 */
async function dispatchNewLeadToDealer(catalystApp, leadRow) {
  try {
    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, leadRow.dealer_code);

    if (integration && integration.integration_type === 'EXTERNAL_CRM') {
      await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
      return;
    }

    // No integration row, or integration_type === 'PORTAL' — existing behaviour.
    await notifyDealerOfNewLead(catalystApp, {
      dealerCode: leadRow.dealer_code,
      customerName: leadRow.customer_name,
      vehicleModel: leadRow.vehicle_model,
      leadRowId: leadRow.ROWID,
    });
  } catch (err) {
    // Never let a dealer-CRM push failure break the sync loop — same
    // fire-and-forget contract notifyDealerOfNewLead already had.
    logger.error('leadSyncService', `dispatchNewLeadToDealer failed for dealer_code=${leadRow.dealer_code}`, err);
  }
}

/**
 * Only EXTERNAL_CRM dealers need an active push on lead update — PORTAL
 * dealers already see updated data live from the `leads` table via the
 * existing dealer portal reads, no action needed there.
 */
async function dispatchLeadUpdateToDealer(catalystApp, leadRow) {
  try {
    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, leadRow.dealer_code);
    if (integration && integration.integration_type === 'EXTERNAL_CRM') {
      await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
    }
  } catch (err) {
    logger.error('leadSyncService', `dispatchLeadUpdateToDealer failed for dealer_code=${leadRow.dealer_code}`, err);
  }
}

/**
 * Syncs all OEM_Leads records from Zoho CRM into the Catalyst `leads`
 * table. Same entry-point shape as syncDealers() — reusable by a manual
 * route now, a scheduled Cron job later, with no changes needed here.
 */
async function syncLeads(catalystApp, { trigger = 'Manual', triggeredBy = 'System' } = {}) {
  const startTime = toCatalystDateTime();
  const table = catalystApp.datastore().table(LEADS_TABLE);

  let crmRecords;
  try {
    crmRecords = await fetchOemLeads();
  } catch (err) {
    const endTime = toCatalystDateTime();
    await recordSyncRun(catalystApp, {
      syncType: 'Lead_Sync', syncTrigger: trigger, triggeredBy, startTime, endTime,
      totalRecordsFetched: 0, recordsInserted: 0, recordsUpdated: 0, recordsFailed: 0,
      status: 'Failed', errorDetails: [{ error: `CRM fetch failed: ${err.message}` }],
    });
    throw err;
  }

  const existingLeadsByCrmId = await loadExistingLeadsByCrmId(catalystApp);

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let removed = 0;
  const errors = [];
  const seenCrmIds = new Set();

  for (const crmRecord of crmRecords) {
    try {
      if (!crmRecord.id) throw new Error('CRM record missing id — skipped');
      if (!crmRecord.Dealer_Code) throw new Error('CRM record missing Dealer_Code — skipped');

      seenCrmIds.add(crmRecord.id);

      const mappedRow = stripEmptyDateFields(mapCrmRecordToLeadRow(crmRecord));
      const now = toCatalystDateTime();
      const existingRow = existingLeadsByCrmId.get(crmRecord.id);

      if (!existingRow) {
        const insertedRow = await table.insertRow({ ...mappedRow, last_synced_at: now, sync_status: 'Synced' });
        inserted += 1;

        logger.info('leadSyncService', `New lead inserted (ROWID=${insertedRow.ROWID}, dealer_code=${mappedRow.dealer_code})`);

        // INTEGRATION POINT: branch on dealer's integration_type instead
        // of always notifying via the Catalyst portal. Fire-and-forget
        // in both branches, matching the existing notifyDealerOfNewLead
        // pattern — a slow/failed dealer-CRM push must not block or
        // fail the overall Zoho sync loop.
        dispatchNewLeadToDealer(catalystApp, {
          ...mappedRow,
          crm_record_id: crmRecord.id,
          ROWID: insertedRow.ROWID,
        });
      } else if (existingRow.sync_status === 'Removed' || hasChanges(existingRow, mappedRow)) {
        await table.updateRow({ ROWID: existingRow.ROWID, ...mappedRow, last_synced_at: now, sync_status: 'Synced' });
        updated += 1;

        // INTEGRATION POINT: EXTERNAL_CRM dealers also need updates
        // pushed out (status changes, remarks changes from Zoho side) —
        // the old code had no equivalent call here at all for PORTAL
        // dealers either, since the portal reads leads live from the
        // table. Only EXTERNAL_CRM dealers need an active push on update.
        dispatchLeadUpdateToDealer(catalystApp, {
          ...mappedRow,
          crm_record_id: crmRecord.id,
          ROWID: existingRow.ROWID,
        });
      }


    } catch (err) {
      failed += 1;
      errors.push({ crm_record_id: crmRecord.id || 'UNKNOWN', error: err.message });
      logger.error('leadSyncService', `Failed syncing crm_record_id=${crmRecord.id}`, err);
    }
  }

  // Soft-delete pass — same reasoning as dealerSyncService.
  for (const [crmId, existingRow] of existingLeadsByCrmId) {
    if (!seenCrmIds.has(crmId) && existingRow.sync_status !== 'Removed') {
      try {
        await table.updateRow({
          ROWID: existingRow.ROWID,
          sync_status: 'Removed',
          last_synced_at: toCatalystDateTime(),
        });
        removed += 1;
      } catch (err) {
        logger.error('leadSyncService', `Failed soft-deleting crm_record_id=${crmId}`, err);
      }
    }
  }

  const endTime = toCatalystDateTime();
  const status = failed === 0 ? 'Success' : (inserted + updated > 0 ? 'Partial' : 'Failed');

  if (inserted > 0 || updated > 0) {
    logger.info('leadSyncService', `Calling notifyAdmins — inserted=${inserted}, updated=${updated}`);
    notifyAdmins(catalystApp, {
      type: 'SYNC_SUMMARY',
      title: 'Lead sync complete',
      message: `${inserted} new, ${updated} updated${removed ? `, ${removed} removed` : ''}.`,
    }); // fire-and-forget
  }

  await recordSyncRun(catalystApp, {
    syncType: 'Lead_Sync', syncTrigger: trigger, triggeredBy, startTime, endTime,
    totalRecordsFetched: crmRecords.length, recordsInserted: inserted, recordsUpdated: updated,
    recordsFailed: failed, status, errorDetails: errors.length > 0 ? errors : null,
  });

  return { status, totalRecordsFetched: crmRecords.length, recordsInserted: inserted, recordsUpdated: updated, recordsFailed: failed, recordsRemoved: removed, errors };
}

module.exports = { syncLeads };