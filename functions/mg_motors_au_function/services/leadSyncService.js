'use strict';

const { fetchOemLeads } = require('./zohoCrmService');
const { recordSyncRun } = require('./syncLogService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');
const { notifyAdmins, notifyUser } = require('./notificationService');
const crmIntegrationService = require('./integrations/crmIntegrationService'); // NEW
const pathPolicy = require('./integrations/pathPolicyService');

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
 *
 * NOTE (dispatch calls): dispatchNewLeadToDealer / dispatchLeadUpdateToDealer
 * are AWAITED in the main loop below, even though both already catch
 * their own errors internally and never throw. This isn't about error
 * propagation — it's because this whole function runs inside a
 * serverless invocation. If the outbound push isn't awaited, the
 * function can return (and Catalyst can freeze/recycle the execution
 * context) before the push actually finishes, silently truncating it
 * mid-flight with no error and nothing written to integration_logs.
 * Previously this caused some newly-synced leads to never reach the
 * dealer's external CRM, especially the last few processed in a batch.
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
    customer_name: [crmRecord.First_Name, crmRecord.Last_Name].filter(Boolean).join(' ') || '',
    mobile_number: crmRecord.Mobile || '',
    email_address: crmRecord.Email || '',
    vehicle_model: crmRecord.Enquiry_Model || '',
    lead_source: crmRecord.Enquiry_Source || '',
    lead_status: crmRecord.Lead_Status || '',
    // Zoho's real api_name is Lead_Status_Modified_Time. The old
    // crmRecord.Last_Status_Update / .Assigned_Date / .Dealer_Remarks
    // reads were against fields that do not exist on the Leads module,
    // so all three were silently undefined on every record — verified
    // against live field metadata.
    last_status_update: toCatalystDateTimeFromCrm(crmRecord.Lead_Status_Modified_Time),
    crm_record_id: crmRecord.id || '',

    // New fields
    enquiry_status: crmRecord.Enquiry_Status || '',
    nature_of_enquiry: crmRecord.Nature_of_Enquiry || '',
    purchase_classification: crmRecord.Purchase_Classification || '',
    enquiry_outcome: crmRecord.Enquiry_Outcome || '',
    lead_department: crmRecord.Lead_Department || '',
    franchise: crmRecord.Franchise || '',
    enquiry_id: crmRecord.Enquiry_ID || '',
    customer_message: crmRecord.Customer_Message || '',
    accept_privacy_policy: crmRecord.Accept_Privacy_Policy ?? false,
    receive_marketing_updates: crmRecord.Receive_Marketing_Updates ?? false,
    postcode: crmRecord.Postcode || '',
    unit_suite: crmRecord.Unit_Suite || '',
    enquiry_model: crmRecord.Enquiry_Model || '',
    enquiry_variant: crmRecord.Enquiry_Variant || '',
    enquiry_powertrain: crmRecord.Enquiry_Powertrain || '',
    chat_transcript: crmRecord.Chat_Transcript || '',
  };
}

// assigned_date is intentionally absent: MG's Leads module has no such
// field, so nothing populates it. Leaving it here would strip a key that
// is never set anyway, which only hides the gap.
const DATETIME_FIELDS = ['last_status_update'];

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

const NON_DELIVERED_SYNC_STATUSES = new Set([
  'Removed',
  'VALIDATION_HOLD',
  'CONSENT_HOLD',
  'ROUTING_HOLD',
  'DELIVERY_FAILED',
  'FAILED_CRITICAL',
  'DUPLICATE_LINKED',
]);

function findDeliveredBusinessDuplicate(incomingLead, existingLeadsByCrmId) {
  for (const candidate of existingLeadsByCrmId.values()) {
    if (NON_DELIVERED_SYNC_STATUSES.has(candidate.sync_status)) continue;
    if (pathPolicy.isBusinessDuplicate(incomingLead, candidate)) return candidate;
  }
  return null;
}

function incrementScenario(scenarioCounts, scenarioCode) {
  if (!scenarioCode) return;
  scenarioCounts[scenarioCode] = (scenarioCounts[scenarioCode] || 0) + 1;
}

async function markLeadState(catalystApp, leadRow, syncStatus) {
  if (!leadRow?.ROWID) return;
  await catalystApp.datastore().table(LEADS_TABLE).updateRow({
    ROWID: leadRow.ROWID,
    sync_status: syncStatus,
    last_synced_at: toCatalystDateTime(),
  });
  leadRow.sync_status = syncStatus;
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
 *
 * Callers AWAIT this (see syncLeads loop) so the outbound push has a
 * chance to finish before the enclosing function invocation returns —
 * see the file-level note above. This function still swallows its own
 * errors internally, so awaiting it can never fail the sync loop.
 */
async function dispatchNewLeadToDealer(catalystApp, leadRow) {
  try {
    const dealer = leadRow.dealer_code
      ? await crmIntegrationService.findDealerByCode(catalystApp, leadRow.dealer_code)
      : null;
    const dealerIsUsable = dealer && dealer.sync_status !== 'Removed';
    if (!dealerIsUsable) {
      await markLeadState(catalystApp, leadRow, 'ROUTING_HOLD');
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode: 'Unhappy 5',
        dealerCode: leadRow.dealer_code,
        leadRow,
        errorCode: 'DEALER_ROUTING_INVALID',
        reason: 'Assigned Dealer Master record is missing, inactive, or removed.',
        notify: true,
      });
      return { held: true, scenarioCode: 'Unhappy 5', reason: 'DEALER_ROUTING_INVALID' };
    }

    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, leadRow.dealer_code);

    if (integration && integration.integration_type === 'EXTERNAL_CRM') {
      return crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
    }

    if (!integration || integration.integration_type !== 'PORTAL') {
      await markLeadState(catalystApp, leadRow, 'ROUTING_HOLD');
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode: 'Unhappy 5',
        dealerCode: leadRow.dealer_code,
        leadRow,
        errorCode: 'INTEGRATION_NOT_CONFIGURED',
        reason: 'The assigned dealer has no approved Lead Exchange integration mode.',
        notify: true,
      });
      return { held: true, scenarioCode: 'Unhappy 5', reason: 'INTEGRATION_NOT_CONFIGURED' };
    }

    // Explicit PORTAL mode — existing Catalyst dealer workflow.
    await notifyDealerOfNewLead(catalystApp, {
      dealerCode: leadRow.dealer_code,
      customerName: leadRow.customer_name,
      vehicleModel: leadRow.vehicle_model,
      leadRowId: leadRow.ROWID,
    });
    await markLeadState(catalystApp, leadRow, 'SYNCED');
    await crmIntegrationService.recordScenario(catalystApp, {
      scenarioCode: 'Happy 1',
      dealerCode: leadRow.dealer_code,
      leadRow,
    });
    return { ok: true, scenarioCode: 'Happy 1' };
  } catch (err) {
    // Never let a dealer-CRM push failure break the sync loop — same
    // fire-and-forget contract notifyDealerOfNewLead already had.
    logger.error('leadSyncService', `dispatchNewLeadToDealer failed for dealer_code=${leadRow.dealer_code}`, err);
    return { ok: false, scenarioCode: err.scenarioCode || 'Unhappy 1', error: err.message };
  }
}

/**
 * Only EXTERNAL_CRM dealers need an active push on lead update — PORTAL
 * dealers already see updated data live from the `leads` table via the
 * existing dealer portal reads, no action needed there.
 *
 * Callers AWAIT this (see syncLeads loop) for the same reason as
 * dispatchNewLeadToDealer above.
 */
async function dispatchLeadUpdateToDealer(catalystApp, leadRow) {
  try {
    const validation = pathPolicy.validateLeadForDelivery(leadRow);
    if (validation.routingIssue) {
      await markLeadState(catalystApp, leadRow, 'ROUTING_HOLD');
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode: 'Unhappy 5', leadRow, errorCode: 'DEALER_ROUTING_INVALID',
        reason: validation.routingIssue.rule, notify: true,
      });
      return { held: true, scenarioCode: 'Unhappy 5' };
    }
    if (validation.privacyIssue) {
      await markLeadState(catalystApp, leadRow, 'CONSENT_HOLD');
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode: 'Unhappy 8', leadRow, errorCode: 'CONSENT_MISMATCH',
        reason: validation.privacyIssue.rule, notify: true,
      });
      return { held: true, scenarioCode: 'Unhappy 8' };
    }
    if (validation.issues.length > 0) {
      await markLeadState(catalystApp, leadRow, 'VALIDATION_HOLD');
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode: 'Unhappy 2', leadRow, errorCode: 'LEAD_VALIDATION_FAILED',
        reason: validation.issues.map((issue) => `${issue.field}: ${issue.rule}`).join('; '),
        notify: true,
      });
      return { held: true, scenarioCode: 'Unhappy 2' };
    }

    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, leadRow.dealer_code);
    if (integration && integration.integration_type === 'EXTERNAL_CRM') {
      return crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
    }
    if (!integration || integration.integration_type !== 'PORTAL') {
      await markLeadState(catalystApp, leadRow, 'ROUTING_HOLD');
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode: 'Unhappy 5', leadRow, errorCode: 'INTEGRATION_NOT_CONFIGURED',
        reason: 'The assigned dealer has no approved Lead Exchange integration mode.', notify: true,
      });
      return { held: true, scenarioCode: 'Unhappy 5' };
    }
    await markLeadState(catalystApp, leadRow, 'SYNCED');
    return { skipped: true, reason: 'PORTAL_LIVE_READ' };
  } catch (err) {
    logger.error('leadSyncService', `dispatchLeadUpdateToDealer failed for dealer_code=${leadRow.dealer_code}`, err);
    return { ok: false, scenarioCode: err.scenarioCode || 'Unhappy 1', error: err.message };
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
  let unchanged = 0;
  const errors = [];
  const seenCrmIds = new Set();
  const scenarioCounts = {};

  for (const crmRecord of crmRecords) {
    try {
      if (!crmRecord.id) throw new Error('CRM record missing id — skipped');

      seenCrmIds.add(crmRecord.id);

      const mappedRow = stripEmptyDateFields(mapCrmRecordToLeadRow(crmRecord));
      const validation = pathPolicy.validateLeadForDelivery(mappedRow);
      const now = toCatalystDateTime();
      const existingRow = existingLeadsByCrmId.get(crmRecord.id);

      if (!existingRow) {
        const duplicate = validation.valid
          ? findDeliveredBusinessDuplicate(
              { ...mappedRow, CREATEDTIME: crmRecord.Created_Time },
              existingLeadsByCrmId
            )
          : null;
        let initialSyncStatus = 'PENDING';
        if (validation.routingIssue) initialSyncStatus = 'ROUTING_HOLD';
        else if (validation.privacyIssue) initialSyncStatus = 'CONSENT_HOLD';
        else if (validation.issues.length > 0) initialSyncStatus = 'VALIDATION_HOLD';
        else if (duplicate) initialSyncStatus = 'DUPLICATE_LINKED';

        const insertedRow = await table.insertRow({
          ...mappedRow,
          last_synced_at: now,
          sync_status: initialSyncStatus,
        });
        inserted += 1;

        const fullLeadRow = {
          ...mappedRow,
          crm_record_id: crmRecord.id,
          ROWID: insertedRow.ROWID,
          CREATEDTIME: insertedRow.CREATEDTIME || crmRecord.Created_Time,
          sync_status: initialSyncStatus,
        };
        existingLeadsByCrmId.set(crmRecord.id, fullLeadRow);

        logger.info('leadSyncService', `New lead inserted (ROWID=${insertedRow.ROWID}, dealer_code=${mappedRow.dealer_code})`);

        if (validation.routingIssue) {
          await crmIntegrationService.recordScenario(catalystApp, {
            scenarioCode: 'Unhappy 5',
            leadRow: fullLeadRow,
            errorCode: 'DEALER_ROUTING_INVALID',
            reason: validation.routingIssue.rule,
            notify: true,
          });
          incrementScenario(scenarioCounts, 'Unhappy 5');
        } else if (validation.privacyIssue) {
          await crmIntegrationService.recordScenario(catalystApp, {
            scenarioCode: 'Unhappy 8',
            dealerCode: fullLeadRow.dealer_code,
            leadRow: fullLeadRow,
            errorCode: 'CONSENT_MISMATCH',
            reason: validation.privacyIssue.rule,
            notify: true,
          });
          incrementScenario(scenarioCounts, 'Unhappy 8');
        } else if (validation.issues.length > 0) {
          await crmIntegrationService.recordScenario(catalystApp, {
            scenarioCode: 'Unhappy 2',
            dealerCode: fullLeadRow.dealer_code,
            leadRow: fullLeadRow,
            errorCode: 'LEAD_VALIDATION_FAILED',
            reason: validation.issues.map((issue) => `${issue.field}: ${issue.rule}`).join('; '),
            notify: true,
          });
          incrementScenario(scenarioCounts, 'Unhappy 2');
        } else if (duplicate) {
          const originalSubmittedAt = pathPolicy.parseTimestamp(
            duplicate.assigned_date || duplicate.CREATEDTIME
          );
          const duplicateSubmittedAt = pathPolicy.parseTimestamp(
            fullLeadRow.assigned_date || fullLeadRow.CREATEDTIME
          );
          const gapMinutes = originalSubmittedAt && duplicateSubmittedAt
            ? Math.max(0, (duplicateSubmittedAt.getTime() - originalSubmittedAt.getTime()) / 60000)
            : null;
          await crmIntegrationService.recordScenario(catalystApp, {
            scenarioCode: 'Happy 3',
            dealerCode: fullLeadRow.dealer_code,
            leadRow: fullLeadRow,
            reason: `Exact mandatory-field match within ${pathPolicy.DUPLICATE_WINDOW_MINUTES} minutes; linked to ${duplicate.crm_record_id}.`,
            fieldChanges: [{
              field: 'duplicate_link',
              from: duplicate.crm_record_id,
              to: fullLeadRow.crm_record_id,
              original_submitted_at: originalSubmittedAt?.toISOString() || null,
              duplicate_submitted_at: duplicateSubmittedAt?.toISOString() || null,
              gap_minutes: gapMinutes,
              matched_fields: pathPolicy.DUPLICATE_FIELDS,
            }],
          });
          incrementScenario(scenarioCounts, 'Happy 3');
        } else {
          // AWAITED so Catalyst cannot freeze this serverless invocation
          // before dealer delivery and its audit row finish.
          const dispatchResult = await dispatchNewLeadToDealer(catalystApp, fullLeadRow);
          incrementScenario(scenarioCounts, dispatchResult?.scenarioCode);
        }
      } else if (existingRow.sync_status === 'Removed' || hasChanges(existingRow, mappedRow)) {
        await table.updateRow({ ROWID: existingRow.ROWID, ...mappedRow, last_synced_at: now, sync_status: 'PENDING' });
        updated += 1;

        // INTEGRATION POINT: EXTERNAL_CRM dealers also need updates
        // pushed out (status changes, remarks changes from Zoho side) —
        // the old code had no equivalent call here at all for PORTAL
        // dealers either, since the portal reads leads live from the
        // table. Only EXTERNAL_CRM dealers need an active push on
        // update. AWAITED for the same reason as dispatchNewLeadToDealer
        // above.
        const dispatchResult = await dispatchLeadUpdateToDealer(catalystApp, {
          ...mappedRow,
          crm_record_id: crmRecord.id,
          ROWID: existingRow.ROWID,
        });
        incrementScenario(scenarioCounts, dispatchResult?.scenarioCode);
        const scenarioHoldStatus = {
          'Unhappy 2': 'VALIDATION_HOLD',
          'Unhappy 5': 'ROUTING_HOLD',
          'Unhappy 8': 'CONSENT_HOLD',
        }[dispatchResult?.scenarioCode];
        existingLeadsByCrmId.set(crmRecord.id, {
          ...existingRow,
          ...mappedRow,
          sync_status: dispatchResult?.held
            ? (scenarioHoldStatus || existingRow.sync_status)
            : 'SYNCED',
        });
      } else {
        unchanged += 1;
      }


    } catch (err) {
      failed += 1;
      errors.push({ crm_record_id: crmRecord.id || 'UNKNOWN', error: err.message });
      incrementScenario(scenarioCounts, 'Unhappy 1');
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
  const unhappyCount = Object.entries(scenarioCounts)
    .filter(([code]) => code.startsWith('Unhappy '))
    .reduce((sum, [, count]) => sum + count, 0);
  const status = failed === 0 && unhappyCount === 0
    ? 'Success'
    : (inserted + updated > 0 ? 'Partial' : 'Failed');

  if (inserted > 0 || updated > 0) {
    logger.info('leadSyncService', `Calling notifyAdmins — inserted=${inserted}, updated=${updated}`);
    await notifyAdmins(catalystApp, {
      type: 'SYNC_SUMMARY',
      title: 'Lead sync complete',
      message: `${inserted} new, ${updated} updated${removed ? `, ${removed} removed` : ''}.`,
    });
  }

  await recordSyncRun(catalystApp, {
    syncType: 'Lead_Sync', syncTrigger: trigger, triggeredBy, startTime, endTime,
    totalRecordsFetched: crmRecords.length, recordsInserted: inserted, recordsUpdated: updated,
    recordsFailed: failed, status, errorDetails: errors.length > 0 ? errors : null,
    scenarioCounts,
  });

  return {
    status,
    totalRecordsFetched: crmRecords.length,
    recordsInserted: inserted,
    recordsUpdated: updated,
    recordsUnchanged: unchanged,
    recordsFailed: failed,
    recordsRemoved: removed,
    scenarioCounts,
    errors,
  };
}

module.exports = {
  syncLeads,
  _test: {
    mapCrmRecordToLeadRow,
    hasChanges,
    findDeliveredBusinessDuplicate,
  },
};
