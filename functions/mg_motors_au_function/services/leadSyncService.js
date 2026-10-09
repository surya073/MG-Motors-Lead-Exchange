'use strict';

const {
  fetchOemLeads,
  fetchOemLeadsByIds,
  fetchOemLeadsModifiedSince,
  updateOemLead,
} = require('./zohoCrmService');
const { getLeadSyncSince } = require('../config/env');
const { recordSyncRun } = require('./syncLogService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');
const dashboardStats = require('./dashboardStatsService');
const { notifyAdmins, notifyUser } = require('./notificationService');
const crmIntegrationService = require('./integrations/crmIntegrationService'); // NEW
const pathPolicy = require('./integrations/pathPolicyService');
const outboundSyncClaimService = require('./integrations/outboundSyncClaimService');

const LEADS_TABLE = 'leads';
const FULL_SYNC_LEAD_ROW_BOUND = 500000;

/**
 * Renders validation failures so the operator can act on them directly:
 * which field, what it currently holds, and the rule it broke. The value is
 * masked because the error panel is visible in the application and must not
 * expose full customer data (register, Unhappy 2 edge case f).
 */
function describeValidationIssues(issues) {
  return (issues || [])
    .map((issue) => {
      const shown = pathPolicy.maskSensitiveValue(issue.field, issue.value);
      const seen = shown === '' || shown === undefined || shown === null ? 'empty' : `"${shown}"`;
      return `${issue.field} is ${seen} — ${issue.rule}`;
    })
    .join('; ');
}
const ZCQL_PAGE_SIZE = 200; // Catalyst ZCQL's max rows per LIMIT clause

// The leadSync:${dealer_code} claim (see syncLeads()) is held only for the
// duration of one record's classification/insert/dispatch, so genuine
// contention — a second overlapping syncLeads() execution for the same
// dealer — is expected to clear in well under a second, not minutes. Unlike
// every other claim/sweep in this codebase, there is no scheduled job that
// retries a syncLeads() pass, so a claim that is busy for just one instant
// must not permanently drop that record until some unrelated future
// webhook/manual sync happens to pick it up again. A short bounded retry
// here — still going through the same atomic claim each attempt, never
// bypassing it — closes that gap without weakening the mutual exclusion.
const LEAD_SYNC_CLAIM_MAX_ATTEMPTS = 3;
const LEAD_SYNC_CLAIM_RETRY_DELAY_MS = 250;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    dealer_code: crmRecord.Franchise_Code || '',
    customer_name: [crmRecord.First_Name, crmRecord.Last_Name].filter(Boolean).join(' ') || '',
    // Normalized once here, at the point the number enters the system, so
    // every downstream consumer (dealer CRM push, UI display, duplicate
    // fingerprint) sees the same canonical 04XXXXXXXX form regardless of
    // whether the OEM CRM held it as "0412345678" or "+61412345678".
    // isValidAustralianMobile() already normalizes internally for its own
    // check, so this does not change validation behavior — it only stops
    // the un-normalized raw value from being the one that gets stored.
    mobile_number: pathPolicy.normalizePhone(crmRecord.Mobile) || '',
    email_address: crmRecord.Email || '',
    vehicle_model: crmRecord.Enquiry_Model || '',
    lead_source: crmRecord.Lead_Source || '',
    lead_status: crmRecord.Lead_Status || '',
    // `Assigned_Date` does not exist in MG CRM. The local column is used as
    // the immutable enquiry-submission timestamp for the 15-minute duplicate
    // rule, so populate it from Zoho's real system Created_Time instead.
    assigned_date: toCatalystDateTimeFromCrm(crmRecord.Created_Time),
    // Zoho's real api_name is Lead_Status_Modified_Time. The old
    // Last_Status_Update and Dealer_Remarks reads referenced fields that do
    // not exist on the Leads module and were silently undefined — verified
    // against live field metadata.
    last_status_update: toCatalystDateTimeFromCrm(crmRecord.Last_Status_Changed),
    crm_record_id: crmRecord.id || '',

    // New fields
    // MG OEM has no separate Enquiry_Status; its "Enquiry Status" label is Lead_Status.
    enquiry_status: crmRecord.Lead_Status || '',
    nature_of_enquiry: crmRecord.Nature_of_enquiry || '',
    purchase_classification: crmRecord.Purchase_Classification || '',
    enquiry_outcome: crmRecord.Enquiry_Outcome || '',
    lead_department: crmRecord.Lead_Department || '',
    franchise: crmRecord.Franchise || '',
    enquiry_id: crmRecord.Enq_ID || '',
    customer_message: crmRecord.Message || '',
    accept_privacy_policy: crmRecord.Accept_Privacy_Polic ?? false,
    receive_marketing_updates: crmRecord.Receive_Offers_Updates ?? false,
    postcode: crmRecord.Postcode || '',
    unit_suite: crmRecord.Unit_Suite || '',
    enquiry_model: crmRecord.Enquiry_Model || '',
    enquiry_variant: crmRecord.Variant || '',
    enquiry_powertrain: crmRecord.Enquiry_Powertrain || '',
    chat_transcript: crmRecord.Chat_Trascript || '',
    // Written back to MG's own CRM as Dealer_Rejected_Reason (see
    // INTERNAL_FIELD_TO_ZOHO_API_FIELD in crmIntegrationService.js, and the
    // Unhappy 9 handling in processResolvedInboundLead that populates it
    // from the dealer's Lead_Rejected_Reason). Read back under the SAME
    // MG-side name here so this periodic OEM mirror does not blank it out
    // again on the next sync.
    dealer_rejected_reason: crmRecord.Dealer_Rejected_Reason || '',
  };
}

const DATETIME_FIELDS = ['assigned_date', 'last_status_update'];

/**
 * Removes any datetime field left as '' by toCatalystDateTimeFromCrm
 * before the row is sent to insertRow/updateRow. Catalyst's datastore
 * rejects '' for a datetime-typed column ("Invalid input value for
 * assigned_date. datetime value expected"), which previously failed
 * the whole record — including every other valid field on it — just
 * because CRM's Created_Time or Lead_Status_Modified_Time was blank on
 * that record. Omitting the key entirely leaves the column untouched on
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
  // Used only by the full manual sync. Paged in a stable order (ROWID) with a
  // true 0-based offset: the old loop used an unordered scan with a 1-based
  // offset, so it re-read a row at the first page boundary and gave the
  // database no stable order to page through.
  const rows = await dashboardStats.selectEveryRow(
    catalystApp,
    LEADS_TABLE,
    '',
    'ORDER BY ROWID ASC',
    FULL_SYNC_LEAD_ROW_BOUND
  );
  const map = new Map();
  rows.forEach((lead) => map.set(lead.crm_record_id, lead));
  return map;
}

function hasChanges(existingRow, mappedRow) {
  return Object.keys(mappedRow).some((key) => {
    // Immutable source timestamp used for duplicate timing. Older rows may
    // not have it yet; a backfill alone is not a business change and must not
    // trigger a dealer API update.
    if (key === 'assigned_date') return false;
    const existingValue = existingRow[key] ?? '';
    const newValue = mappedRow[key] ?? '';
    return String(existingValue) !== String(newValue);
  });
}

function needsAssignedDateBackfill(existingRow, mappedRow) {
  return !existingRow?.assigned_date && Boolean(mappedRow?.assigned_date);
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

function safeQuoteForZcql(value) {
  return String(value ?? '').replace(/'/g, "''");
}

const LEADS_BY_CRM_ID_CHUNK = 50;
const DUPLICATE_CANDIDATE_LIMIT = 200;

/**
 * Loads only the Catalyst rows for the given OEM record ids — the incremental
 * counterpart of loadExistingLeadsByCrmId(), which reads the whole table.
 */
async function loadExistingLeadsByCrmIds(catalystApp, crmIds) {
  const map = new Map();
  const unique = [...new Set((crmIds || []).map(String).filter(Boolean))];
  for (let i = 0; i < unique.length; i += LEADS_BY_CRM_ID_CHUNK) {
    const list = unique.slice(i, i + LEADS_BY_CRM_ID_CHUNK).map((id) => `'${safeQuoteForZcql(id)}'`).join(', ');
    const result = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id IN (${list})`
    );
    result.forEach((row) => map.set(row[LEADS_TABLE].crm_record_id, row[LEADS_TABLE]));
  }
  return map;
}

/**
 * Duplicate detection needs every lead that could match the incoming one.
 * isBusinessDuplicate() requires an equal fingerprint (which includes the
 * normalised mobile number — stored normalised by mapCrmRecordToLeadRow), so
 * the same mobile is a safe pre-filter and keeps the lookup to a handful of
 * rows. Without a mobile the fingerprint can only match another blank-mobile
 * lead of the same dealer and postcode, which is what the fallback selects.
 * The authoritative check is still isBusinessDuplicate() on the candidates.
 */
async function loadDuplicateCandidates(catalystApp, incomingLead) {
  const mobile = incomingLead.mobile_number;
  const where = mobile
    ? `mobile_number = '${safeQuoteForZcql(mobile)}'`
    : `dealer_code = '${safeQuoteForZcql(incomingLead.dealer_code)}' AND postcode = '${safeQuoteForZcql(incomingLead.postcode)}'`;
  const result = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEADS_TABLE} WHERE ${where} ORDER BY CREATEDTIME DESC LIMIT 0, ${DUPLICATE_CANDIDATE_LIMIT}`
  );
  return result.map((row) => row[LEADS_TABLE]);
}

/**
 * Incremental-mode duplicate finder: leads already known in this run (the
 * loaded records plus anything inserted earlier in the same batch) take
 * precedence, then the targeted candidate query adds the rest.
 */
async function findDuplicateWithTargetedLookup(catalystApp, incomingLead, knownLeadsByCrmId) {
  const candidates = new Map(knownLeadsByCrmId);
  const queried = await loadDuplicateCandidates(catalystApp, incomingLead);
  queried.forEach((row) => {
    if (!candidates.has(row.crm_record_id)) candidates.set(row.crm_record_id, row);
  });
  return findDeliveredBusinessDuplicate(incomingLead, candidates);
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
        reason: describeValidationIssues(validation.issues),
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
  // Full synchronisation — kept for manual recovery. Reads every OEM lead in
  // the LEAD_SYNC_SINCE window and every Catalyst lead row, so it is NOT used
  // for webhooks (see syncLeadsByIds / syncModifiedLeads).
  return runLeadSync(catalystApp, {
    trigger,
    triggeredBy,
    loadRecords: () => fetchOemLeads(),
    loadExisting: () => loadExistingLeadsByCrmId(catalystApp),
    findDuplicate: async (incoming, existing) => findDeliveredBusinessDuplicate(incoming, existing),
    // A windowed fetch is deliberately partial: "not seen" != "gone from CRM".
    removalPass: !getLeadSyncSince(),
  });
}

/**
 * Shared sync engine. The three loaders are the only things that differ
 * between a full sync and an incremental one; everything after them —
 * validation, duplicate classification (Happy 3), per-dealer claims, dealer
 * dispatch, scenario counting, logging — is the single existing code path.
 */
async function runLeadSync(catalystApp, {
  trigger,
  triggeredBy,
  loadRecords,
  loadExisting,
  findDuplicate,
  removalPass,
  skipLogWhenEmpty = false,
}) {
  const startTime = toCatalystDateTime();
  const table = catalystApp.datastore().table(LEADS_TABLE);

  let crmRecords;
  try {
    crmRecords = await loadRecords();
  } catch (err) {
    const endTime = toCatalystDateTime();
    await recordSyncRun(catalystApp, {
      syncType: 'Lead_Sync', syncTrigger: trigger, triggeredBy, startTime, endTime,
      totalRecordsFetched: 0, recordsInserted: 0, recordsUpdated: 0, recordsFailed: 0,
      status: 'Failed', errorDetails: [{ error: `CRM fetch failed: ${err.message}` }],
    });
    throw err;
  }

  if (skipLogWhenEmpty && crmRecords.length === 0) {
    return {
      status: 'Success', totalRecordsFetched: 0, recordsInserted: 0, recordsUpdated: 0,
      recordsUnchanged: 0, recordsFailed: 0, recordsRemoved: 0, scenarioCounts: {},
    };
  }

  const existingLeadsByCrmId = await loadExisting(crmRecords);

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
        // Cross-instance guard for the confirmed syncLeads() race: two
        // concurrent executions (webhook + webhook, webhook + manual, or
        // two manual triggers) each load their own loadExistingLeadsByCrmId()
        // snapshot, so two different-but-business-duplicate OEM records
        // (duplicate matching always requires the same dealer_code — see
        // DUPLICATE_FIELDS) could both be classified "new" before either
        // insert is visible to the other, both bypassing Happy Path 3.
        // sweepOverlapGuard is in-memory only (one warm instance); this
        // reuses the existing cross-instance DB-backed claim mechanism
        // instead, scoped per-dealer (not globally, so unrelated dealers —
        // and 200+ dealer scale — stay fully concurrent) and namespaced
        // with a 'leadSync' prefix so it can never collide with a real
        // outbound-dispatch claim_key (always `${integrationId}:${zohoLeadId}`,
        // a numeric-shaped pair). Scoped to just this one record's
        // classification/insert/dispatch, released immediately after,
        // never the whole batch or the whole function.
        let claimResult;
        for (let attempt = 1; attempt <= LEAD_SYNC_CLAIM_MAX_ATTEMPTS; attempt += 1) {
          claimResult = await outboundSyncClaimService.withOutboundSyncClaim(
            catalystApp,
            'leadSync',
            mappedRow.dealer_code,
            crmRecord.id,
            async () => {
            // Re-check under the claim. Another instance (a second webhook, the
            // modified-since sweep, a manual sync) may have inserted this exact
            // record while this one waited for the claim; inserting again would
            // hit the unique crm_record_id and be miscounted as a failed record.
            // The record is already in Catalyst, so there is nothing to insert —
            // its fields are brought up to date by the next sync of that lead.
            const alreadyInserted = (await loadExistingLeadsByCrmIds(catalystApp, [crmRecord.id])).get(crmRecord.id);
            if (alreadyInserted) {
              existingLeadsByCrmId.set(crmRecord.id, alreadyInserted);
              unchanged += 1;
              return;
            }

            const duplicate = validation.valid
              ? await findDuplicate(
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
                reason: describeValidationIssues(validation.issues),
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

              // Confirmed duplicate: this branch never reaches the dealer
              // dispatch call below (mutually exclusive with the `else` branch
              // that calls dispatchNewLeadToDealer), so the duplicate is
              // already guaranteed to skip the dealer CRM push — no change
              // needed there. Reflect the outcome on the NEW duplicate lead's
              // own OEM CRM record only, using the existing OEM status-update
              // call and an already-approved Lead_Status value — crmRecord.id
              // is THIS incoming record, never duplicate.crm_record_id (the
              // original/existing lead, which stays untouched). No new field,
              // no change to detection/linking above. Best-effort: a rejected
              // write here must not affect the duplicate outcome already
              // recorded.
              try {
                await updateOemLead(crmRecord.id, { Lead_Status: 'Not Qualified' });
                await table.updateRow({ ROWID: fullLeadRow.ROWID, lead_status: 'Not Qualified' });
                fullLeadRow.lead_status = 'Not Qualified';
              } catch (err) {
                logger.error('leadSyncService', `Failed to set Not Qualified on duplicate OEM lead ${crmRecord.id}`, err);
              }

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
          }
          );

          if (!claimResult?.skipped) break;

          if (attempt < LEAD_SYNC_CLAIM_MAX_ATTEMPTS) {
            await wait(LEAD_SYNC_CLAIM_RETRY_DELAY_MS);
          }
        }

        if (claimResult?.skipped) {
          // Another concurrent syncLeads() execution still owned the
          // leadSync claim for this dealer_code after every retry — this
          // record was NOT inserted, classified, or dispatched. It stays
          // exactly as it is in OEM and will be picked up as a new record
          // again on the next sync/webhook/manual run.
          logger.info(
            'leadSyncService',
            `Deferred new-lead classification for crm_record_id=${crmRecord.id} (dealer_code=${mappedRow.dealer_code}) — another sync is still processing a new lead for this dealer after ${LEAD_SYNC_CLAIM_MAX_ATTEMPTS} attempts; will retry next pass`
          );
        }
      } else if (existingRow.sync_status === 'DUPLICATE_LINKED') {
        // A lead already classified as a Happy Path 3 duplicate must stay
        // blocked from Dealer CRM forever, even if the OEM record is edited
        // again later. The generic update branch below calls
        // dispatchLeadUpdateToDealer() unconditionally, which — finding no
        // lead_integrations row for a never-dispatched duplicate — would
        // treat a later edit as a first-time CREATE. Intercepting here,
        // before that branch's condition is even evaluated, keeps mirrored
        // fields fresh for operators without ever reaching dispatch.
        if (hasChanges(existingRow, mappedRow)) {
          await table.updateRow({
            ROWID: existingRow.ROWID,
            ...mappedRow,
            last_synced_at: now,
            sync_status: 'DUPLICATE_LINKED',
          });
          existingLeadsByCrmId.set(crmRecord.id, {
            ...existingRow,
            ...mappedRow,
            sync_status: 'DUPLICATE_LINKED',
          });
          updated += 1;
        } else if (needsAssignedDateBackfill(existingRow, mappedRow)) {
          await table.updateRow({
            ROWID: existingRow.ROWID,
            assigned_date: mappedRow.assigned_date,
            last_synced_at: now,
          });
          existingLeadsByCrmId.set(crmRecord.id, {
            ...existingRow,
            assigned_date: mappedRow.assigned_date,
            last_synced_at: now,
          });
          unchanged += 1;
        } else {
          unchanged += 1;
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
      } else if (needsAssignedDateBackfill(existingRow, mappedRow)) {
        // Maintenance-only migration for rows created before Created_Time was
        // mapped. Persist the real submission timestamp without classifying a
        // business change or sending the lead back to the dealer.
        await table.updateRow({
          ROWID: existingRow.ROWID,
          assigned_date: mappedRow.assigned_date,
          last_synced_at: now,
        });
        existingLeadsByCrmId.set(crmRecord.id, {
          ...existingRow,
          assigned_date: mappedRow.assigned_date,
          last_synced_at: now,
        });
        unchanged += 1;
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

  // Soft-delete pass — same reasoning as dealerSyncService. Skipped (see
  // `removalPass`) for any partial fetch: a LEAD_SYNC_SINCE window or an
  // incremental run only sees some records, so "not seen" no longer means
  // "gone from the CRM".
  for (const [crmId, existingRow] of removalPass ? existingLeadsByCrmId : []) {
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

// ---------------------------------------------------------------------------
// Incremental sync (webhook path)
// ---------------------------------------------------------------------------

// One incremental job at a time per warm instance. Each job fetches the
// CURRENT state of its records when its turn starts, so a webhook that
// arrives while another is running is processed afterwards with fresh data —
// never concurrently, never from a stale snapshot. Cross-instance races are
// still closed by the existing per-dealer 'leadSync' claim (new leads) and
// the outbound claim/fingerprint idempotency (dealer dispatch).
let incrementalSyncTail = Promise.resolve();

function runIncrementalSerially(job) {
  const run = incrementalSyncTail.then(job, job);
  incrementalSyncTail = run.catch(() => {});
  return run;
}

/**
 * Marks local rows Removed for OEM records deleted in Zoho (a delete
 * notification carries ids but the records can no longer be fetched).
 */
async function markLeadsRemoved(catalystApp, crmIds) {
  const existing = await loadExistingLeadsByCrmIds(catalystApp, crmIds);
  const table = catalystApp.datastore().table(LEADS_TABLE);
  let removed = 0;
  for (const row of existing.values()) {
    if (row.sync_status === 'Removed') continue;
    await table.updateRow({ ROWID: row.ROWID, sync_status: 'Removed', last_synced_at: toCatalystDateTime() });
    removed += 1;
  }
  return { status: 'Success', totalRecordsFetched: 0, recordsRemoved: removed };
}

/**
 * Webhook entry point: syncs only the OEM records named in the notification.
 * Because the current record is always re-read from Zoho, duplicate and
 * out-of-order notifications are harmless — the second pass sees no change.
 */
async function syncLeadsByIds(catalystApp, ids, {
  operation = '',
  trigger = 'Webhook',
  triggeredBy = 'Zoho CRM',
} = {}) {
  const uniqueIds = [...new Set((ids || []).map(String).filter(Boolean))];
  if (uniqueIds.length === 0) {
    return { status: 'Success', totalRecordsFetched: 0, recordsInserted: 0, recordsUpdated: 0, recordsFailed: 0 };
  }

  return runIncrementalSerially(async () => {
    if (String(operation).toLowerCase() === 'delete') {
      return markLeadsRemoved(catalystApp, uniqueIds);
    }
    return runLeadSync(catalystApp, {
      trigger,
      triggeredBy,
      loadRecords: () => fetchOemLeadsByIds(uniqueIds),
      loadExisting: (records) => loadExistingLeadsByCrmIds(catalystApp, records.map((r) => r.id)),
      findDuplicate: (incoming, known) => findDuplicateWithTargetedLookup(catalystApp, incoming, known),
      removalPass: false,
    });
  });
}

const INCREMENTAL_TRIGGER = 'Incremental';
const WATERMARK_OVERLAP_MS = 2 * 60 * 1000; // re-read a little before the last run: clock skew / in-flight edits
const WATERMARK_FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function parseCatalystUtc(value) {
  const parsed = new Date(`${String(value || '').replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Where the next modified-since sweep resumes. Derived from sync_logs (no new
 * table): the start time of the latest Incremental run that completed with no
 * failed record. A run with failures does not advance it, so those records
 * are re-read next time (re-processing is idempotent: unchanged rows are
 * skipped). With no prior run it starts 24h back, never before
 * LEAD_SYNC_SINCE.
 */
async function getIncrementalWatermark(catalystApp, now = new Date()) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM sync_logs WHERE sync_trigger = '${INCREMENTAL_TRIGGER}' ORDER BY CREATEDTIME DESC LIMIT 0, 20`
  );
  for (const wrapped of rows) {
    const log = wrapped.sync_logs;
    if (log.sync_type !== 'Lead_Sync') continue;
    if (!['Success', 'Partial'].includes(log.status)) continue;
    if (Number(log.records_failed || 0) !== 0) continue;
    const startedAt = parseCatalystUtc(log.start_time);
    if (startedAt) return new Date(startedAt.getTime() - WATERMARK_OVERLAP_MS);
  }
  const fallback = new Date(now.getTime() - WATERMARK_FALLBACK_LOOKBACK_MS);
  const since = getLeadSyncSince();
  return since && since > fallback ? since : fallback;
}

/**
 * Recovery / fallback entry point: syncs every OEM lead modified since the
 * watermark. Used by the cron sweep (missed or failed webhooks) and when a
 * notification arrives without record ids. Quiet periods cost one 304 call
 * and write no sync_logs row.
 */
async function syncModifiedLeads(catalystApp, {
  trigger = INCREMENTAL_TRIGGER,
  triggeredBy = 'System',
} = {}) {
  return runIncrementalSerially(async () => {
    const watermark = await getIncrementalWatermark(catalystApp);
    return runLeadSync(catalystApp, {
      trigger,
      triggeredBy,
      loadRecords: () => fetchOemLeadsModifiedSince(watermark),
      loadExisting: (records) => loadExistingLeadsByCrmIds(catalystApp, records.map((r) => r.id)),
      findDuplicate: (incoming, known) => findDuplicateWithTargetedLookup(catalystApp, incoming, known),
      removalPass: false,
      skipLogWhenEmpty: true,
    });
  });
}

module.exports = {
  syncLeads,
  syncLeadsByIds,
  syncModifiedLeads,
  _test: {
    mapCrmRecordToLeadRow,
    hasChanges,
    needsAssignedDateBackfill,
    findDeliveredBusinessDuplicate,
    loadExistingLeadsByCrmId,
    getIncrementalWatermark,
    loadDuplicateCandidates,
  },
};
