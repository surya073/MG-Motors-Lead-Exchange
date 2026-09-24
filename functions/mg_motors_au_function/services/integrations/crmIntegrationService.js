'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const crmAdapterFactory = require('./crmAdapterFactory');
const leadMappingService = require('./leadMappingService');
const leadFingerprintService = require('./leadFingerprintService');
const pathPolicy = require('./pathPolicyService');
const integrationAlertService = require('./integrationAlertService');
const oemCrmService = require('../zohoCrmService');

const DEALERS_TABLE = 'dealers';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const FIELD_MAPPINGS_TABLE = 'integration_field_mappings';
const STATUS_MAPPINGS_TABLE = 'integration_status_mappings';
const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const INTEGRATION_LOGS_TABLE = 'integration_logs';
const WEBHOOK_EVENTS_TABLE = 'webhook_events';
const LEADS_TABLE = 'leads';

const CONSENT_MISMATCH_ERROR_CODE = 'CONSENT_MISMATCH';


// Unhappy 3 — Dealer Unavailable escalation window. A ZOHO_TO_EXTERNAL_CRM
// failure (Unhappy 1) that stays unresolved this long gets reclassified as
// Unhappy 3 / P1 on every subsequent failed attempt, without altering how
// or how often those attempts are retried (see recordOutboundFailureAndCheckEscalation).
//
// Configurable via the UNHAPPY_3_ESCALATION_WINDOW_MINUTES environment
// variable so it can be shortened for testing (e.g. set it to 5 in the
// Catalyst function's Environment Variables to see Unhappy 3 fire after
// 5 minutes instead of 24 hours) without touching this file. Remove the
// env var (or set it to 1440) to go back to the real 24h production window.
const DEFAULT_ESCALATION_WINDOW_MINUTES = 24 * 60; // 24 hours
const configuredEscalationMinutes = Number(process.env.UNHAPPY_3_ESCALATION_WINDOW_MINUTES);
const ESCALATION_WINDOW_MINUTES =
  Number.isFinite(configuredEscalationMinutes) && configuredEscalationMinutes > 0
    ? configuredEscalationMinutes
    : DEFAULT_ESCALATION_WINDOW_MINUTES;
const UNHAPPY_3_ESCALATION_WINDOW_MS = ESCALATION_WINDOW_MINUTES * 60 * 1000;

if (ESCALATION_WINDOW_MINUTES !== DEFAULT_ESCALATION_WINDOW_MINUTES) {
  logger.info(
    'crmIntegrationService',
    `Unhappy 3 escalation window overridden to ${ESCALATION_WINDOW_MINUTES} minute(s) via UNHAPPY_3_ESCALATION_WINDOW_MINUTES — remove this env var for the real 24h production window.`
  );
}
const DEALER_UNAVAILABLE_LEAD_STATUS = 'Dealer Unavailable';
const UNHAPPY_3_MESSAGE =
  'The dealer integration failure has remained unresolved for more than 24 hours. The affected enquiry has been routed for critical escalation and manual follow-up.';

// How far apart automatic retries are spaced while a lead is sitting in
// FAILED/FAILED_CRITICAL — read by outboundRetryScheduler.js's sweep via
// lead_integrations.next_retry_at. Same override pattern as the
// escalation window, for testing (OUTBOUND_RETRY_INTERVAL_MINUTES).
const DEFAULT_RETRY_INTERVAL_MINUTES = 15;
const configuredRetryMinutes = Number(process.env.OUTBOUND_RETRY_INTERVAL_MINUTES);
const RETRY_INTERVAL_MINUTES =
  Number.isFinite(configuredRetryMinutes) && configuredRetryMinutes > 0
    ? configuredRetryMinutes
    : DEFAULT_RETRY_INTERVAL_MINUTES;

if (RETRY_INTERVAL_MINUTES !== DEFAULT_RETRY_INTERVAL_MINUTES) {
  logger.info(
    'crmIntegrationService',
    `Outbound retry interval overridden to ${RETRY_INTERVAL_MINUTES} minute(s) via OUTBOUND_RETRY_INTERVAL_MINUTES.`
  );
}

/**
 * crmIntegrationService.js
 * -----------------------------------------------------------------------
 * Orchestration layer. Does not know HTTP specifics of any CRM (adapter's
 * job) or Zoho API specifics (zohoCrmService's job).
 *
 * IMPORTANT: everywhere below, "zohoLead" / "leadRow" refers to a row
 * shaped exactly like leadSyncService.js's `leads` table — i.e. fields
 * are dealer_code, customer_name, mobile_number, email_address,
 * vehicle_model, lead_source, lead_status, last_status_update,
 * crm_record_id, ROWID, plus the enquiry fields mapped in
 * leadSyncService. This is our
 * OWN internal naming (matches the Catalyst table), NOT Zoho's CRM API
 * field names (Dealer_Code, First_Name, Last_Name, etc — those only
 * exist at the zohoCrmService boundary). Admin-configured field mappings map
 * FROM these internal names TO the external CRM's field names.
 */

function safeQuoteForZcql(value) {
  // Defensive escaping for values interpolated into ZCQL string literals
  // below (dealer codes / lead ids are expected to be simple codes, but
  // this guards against a stray apostrophe breaking the query or,
  // worse, enabling injection).
  return String(value).replace(/'/g, "''");
}

function resolveConsentValue(rawValue) {
  return pathPolicy.resolveBoolean(rawValue);
}

function extractAffectedFieldNames(externalPayload, externalLeadId) {
  const raw = externalPayload.affected_fields;
  // Zoho legitimately sends [] for inserts and can omit change detail on
  // channels registered without return_affected_field_values. Treat an empty
  // list as "unknown/full record", not "zero fields changed"; the latter made
  // a fetched record produce FIELD_MAPPING_INVALID and dropped real updates.
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const flattened = [];
  raw.forEach((entry) => {
    if (typeof entry === 'string') {
      flattened.push(entry);
    } else if (entry && typeof entry === 'object') {
      Object.entries(entry).forEach(([id, fields]) => {
        if (Array.isArray(fields) && (!externalLeadId || id === externalLeadId)) {
          flattened.push(...fields);
        }
      });
    }
  });
  return flattened.length > 0 ? flattened : null;
}

async function findDealerByCode(catalystApp, dealerCode) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${DEALERS_TABLE} WHERE dealer_code = '${safeQuoteForZcql(dealerCode)}' LIMIT 1`
  );
  return rows.length > 0 ? rows[0][DEALERS_TABLE] : null;
}

async function getIntegrationByDealerCode(catalystApp, dealerCode) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE dealer_code = '${safeQuoteForZcql(dealerCode)}' LIMIT 1`
  );
  return rows.length > 0 ? rows[0][DEALER_INTEGRATIONS_TABLE] : null;
}

async function getFieldMappings(catalystApp, integrationId) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${FIELD_MAPPINGS_TABLE} WHERE integration_id = ${integrationId}`
  );
  return rows.map((r) => r[FIELD_MAPPINGS_TABLE]);
}

/**
 * Looks a lead_integrations row up scoped to BOTH the lead and the
 * integration. zoho_lead_id is not unique on that table, so the previous
 * unscoped `WHERE zoho_lead_id = ...  LIMIT 1` could hand back a
 * different dealer's mapping for the same MG lead.
 */
async function findLeadMappingForIntegration(catalystApp, integration, zohoLeadId) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE zoho_lead_id = '${safeQuoteForZcql(zohoLeadId)}' AND integration_id = ${integration.ROWID} LIMIT 1`
  );
  return rows.length > 0 ? rows[0][LEAD_INTEGRATIONS_TABLE] : null;
}

async function getStatusMappings(catalystApp, integrationId) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${STATUS_MAPPINGS_TABLE} WHERE integration_id = ${integrationId}`
  );
  return rows.map((r) => r[STATUS_MAPPINGS_TABLE]);
}

/**
 * Tracks how long an OUTBOUND (ZOHO_TO_EXTERNAL_CRM) sync has been
 * continuously failing for a given lead, using lead_integrations as the
 * source of truth — one row per zoho_lead_id, created here even if a
 * lead has never successfully synced out yet.
 *
 * Uses the failure_streak_started_at / retry_count / next_retry_at /
 * last_attempted_at / last_error columns that already existed in this
 * table (evidently provisioned for exactly this), rather than adding
 * new ones. next_retry_at is what outboundRetryScheduler.js's sweep
 * reads to decide when to try this lead again automatically — this is
 * the actual "keep retrying" mechanism; nothing else in the codebase
 * re-attempts a failed outbound sync on its own.
 *
 * - First failure in a streak (no failure_streak_started_at yet, or the
 *   row was previously SYNCED): stamps failure_streak_started_at,
 *   sync_status FAILED. This is exactly today's Unhappy 1 path.
 * - Same failure persisting, still inside the escalation window: leaves
 *   failure_streak_started_at untouched, still Unhappy 1.
 * - Same failure crossing the window: sync_status flips to
 *   FAILED_CRITICAL (once) and every call from here on returns
 *   escalate:true, so the caller logs Unhappy 3 on this and all
 *   subsequent failed retries until a success resets the row.
 *
 * Requires a 'FAILED_CRITICAL' value alongside 'FAILED'/'SYNCED'/
 * 'PENDING' on lead_integrations.sync_status.
 */
async function recordOutboundFailureAndCheckEscalation(catalystApp, integration, zohoLeadId, err) {
  const mappingTable = catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE);
  const now = new Date();
  const lastError = (err?.code || err?.message || 'EXTERNAL_CRM_ERROR').slice(0, 500);
  const nextRetryAtStr = toCatalystDateTime(new Date(now.getTime() + RETRY_INTERVAL_MINUTES * 60 * 1000));

  const existingMapping = await findLeadMappingForIntegration(catalystApp, integration, zohoLeadId);

  if (!existingMapping) {
    // No mapping row exists yet (e.g. the very first CREATE_LEAD attempt
    // for this lead failed before any row was ever written). Start the
    // failure clock now; external_crm_lead_id stays unset, so the
    // CREATE_LEAD vs UPDATE_LEAD branch in syncLeadToExternalCrm is
    // unaffected on the next retry.
    await mappingTable.insertRow({
      dealer_code: integration.dealer_code,
      zoho_lead_id: zohoLeadId,
      integration_id: integration.ROWID,
      sync_status: 'FAILED',
      failure_streak_started_at: toCatalystDateTime(now),
      retry_count: '1',
      next_retry_at: nextRetryAtStr,
      last_attempted_at: toCatalystDateTime(now),
      last_error: lastError,
    });
    return { escalate: false, firstFailure: true, newEscalation: false, existingMapping: null };
  }

  const isNewStreak = !existingMapping.failure_streak_started_at || existingMapping.sync_status === 'SYNCED';
  const streakStartedAt = isNewStreak ? toCatalystDateTime(now) : existingMapping.failure_streak_started_at;
  const retryCount = isNewStreak ? 1 : (parseInt(existingMapping.retry_count, 10) || 0) + 1;

  if (isNewStreak) {
    // New failure streak (row was healthy, or never failed before).
    await mappingTable.updateRow({
      ROWID: existingMapping.ROWID,
      sync_status: 'FAILED',
      failure_streak_started_at: streakStartedAt,
      retry_count: String(retryCount),
      next_retry_at: nextRetryAtStr,
      last_attempted_at: toCatalystDateTime(now),
      last_error: lastError,
    });
    return { escalate: false, firstFailure: true, newEscalation: false, existingMapping };
  }

  const streakStart = pathPolicy.parseTimestamp(existingMapping.failure_streak_started_at);
  const elapsedMs = streakStart ? now.getTime() - streakStart.getTime() : 0;
  const crossesEscalationWindow = elapsedMs >= UNHAPPY_3_ESCALATION_WINDOW_MS;
  const wasCritical = existingMapping.sync_status === 'FAILED_CRITICAL';

  await mappingTable.updateRow({
    ROWID: existingMapping.ROWID,
    sync_status: crossesEscalationWindow ? 'FAILED_CRITICAL' : 'FAILED',
    retry_count: String(retryCount),
    next_retry_at: nextRetryAtStr,
    last_attempted_at: toCatalystDateTime(now),
    last_error: lastError,
  });

  return {
    escalate: crossesEscalationWindow,
    firstFailure: false,
    newEscalation: crossesEscalationWindow && !wasCritical,
    existingMapping,
  };
}

/**
 * Builds the Unhappy 3 alert detail the register requires: dealer,
 * failure start, duration, affected lead count and IDs, retry count and
 * the last API error. Never throws — an alert with less detail is better
 * than no alert.
 */
async function describeEscalation(catalystApp, integration, escalation, err, reason) {
  const mapping = escalation.existingMapping || {};
  const streakStart = pathPolicy.parseTimestamp(mapping.failure_streak_started_at);
  const durationMinutes = streakStart
    ? Math.max(0, Math.round((Date.now() - streakStart.getTime()) / 60000))
    : null;
  const retryCount = (parseInt(mapping.retry_count, 10) || 0) + 1;
  const apiError = err.response?.status
    ? `HTTP ${err.response.status} ${reason}`
    : `${reason}${err.message && err.message !== reason ? ` (${err.message})` : ''}`;

  let affected = [];
  try {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT zoho_lead_id FROM ${LEAD_INTEGRATIONS_TABLE} WHERE integration_id = ${integration.ROWID} AND sync_status IN ('FAILED', 'FAILED_CRITICAL') LIMIT 0, 300`
    );
    affected = rows.map((row) => row[LEAD_INTEGRATIONS_TABLE].zoho_lead_id).filter(Boolean);
  } catch (lookupErr) {
    logger.error('crmIntegrationService', 'Failed to list affected leads for Unhappy 3 alert', lookupErr);
  }

  return [
    `Dealer ${integration.dealer_code} unavailable`,
    `failure started ${streakStart ? streakStart.toISOString() : 'unknown'}`,
    `duration ${durationMinutes ?? 'unknown'} min`,
    `affected leads ${affected.length}${affected.length ? ` (${affected.join(', ')})` : ''}`,
    `retry count ${retryCount}`,
    `last API error ${apiError}`,
  ].join('; ').slice(0, 1500);
}

/**
 * Parks a lead_integrations row in a HELD state so the
 * inbound event is neither lost nor applied. Released once MG approves
 * the mapping and the dealer's next update arrives, or via a replay.
 */
async function markMappingHeld(catalystApp, mappingRowId, reason) {
  try {
    await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
      ROWID: mappingRowId,
      sync_status: 'HELD',
      last_attempted_at: toCatalystDateTime(),
      last_error: String(reason).slice(0, 500),
    });
  } catch (err) {
    logger.error('crmIntegrationService', `Failed to mark mapping ${mappingRowId} HELD`, err);
  }
}

async function handleConsentMismatch(catalystApp, integration, leadRow, zohoLeadId, requestReference, side, consentValue) {
  const reasonDetail =
    consentValue === null
      ? 'accept_privacy_policy is missing'
      : consentValue === false
      ? 'accept_privacy_policy is false — sharing not permitted'
      : `accept_privacy_policy value "${leadRow?.accept_privacy_policy}" could not be safely translated to a boolean`;

  logger.error(
    'crmIntegrationService',
    `Consent/privacy mismatch for lead ${zohoLeadId} (dealer ${integration.dealer_code}, ${side}) — ${reasonDetail}. Enquiry held.`
  );

  if (leadRow?.ROWID) {
    try {
      await catalystApp.datastore().table(LEADS_TABLE).updateRow({
        ROWID: leadRow.ROWID,
        sync_status: 'CONSENT_HOLD',
      });
    } catch (err) {
      logger.error('crmIntegrationService', `Failed to set consent hold for lead ${zohoLeadId}`, err);
    }
  }

  let wasAlreadyHeld = false;
  try {
    const mappingTable = catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE);
    const existingMapping = await findLeadMappingForIntegration(catalystApp, integration, zohoLeadId);
    wasAlreadyHeld = existingMapping?.sync_status === 'CONSENT_HOLD';

    if (existingMapping) {
      await mappingTable.updateRow({
        ROWID: existingMapping.ROWID,
        sync_status: 'CONSENT_HOLD',
        last_attempted_at: toCatalystDateTime(),
        last_error: CONSENT_MISMATCH_ERROR_CODE,
      });
    } else {
      await mappingTable.insertRow({
        dealer_code: integration.dealer_code,
        zoho_lead_id: zohoLeadId,
        integration_id: integration.ROWID,
        sync_status: 'CONSENT_HOLD',
        last_attempted_at: toCatalystDateTime(),
        last_error: CONSENT_MISMATCH_ERROR_CODE,
      });
    }
  } catch (err) {
    logger.error('crmIntegrationService', `Failed to record CONSENT_HOLD mapping for lead ${zohoLeadId}`, err);
  }

  await writeLog(catalystApp, {
    integration_id: integration.ROWID,
    dealer_code: integration.dealer_code,
    direction: side === 'OUTBOUND' ? 'ZOHO_TO_EXTERNAL_CRM' : 'EXTERNAL_CRM_TO_ZOHO',
    operation: side === 'OUTBOUND' ? 'CREATE_LEAD' : 'UPDATE_LEAD',
    zoho_lead_id: zohoLeadId,
    status: 'FAILED',
    error_message: CONSENT_MISMATCH_ERROR_CODE,
    request_reference: requestReference,
  }, { scenarioCode: 'Unhappy 8', notify: !wasAlreadyHeld, leadRow, reason: reasonDetail });

  return { skipped: true, reason: 'CONSENT_HOLD', held: true, scenarioCode: 'Unhappy 8' };
}

/**
 * ============================================================
 * OUTBOUND: our `leads` row -> External CRM
 * ============================================================
 * Called from leadSyncService.js's syncLeads() loop — see the exact
 * patch to that file below. `leadRow` is the mappedRow (+ crm_record_id
 * and ROWID) already produced by mapCrmRecordToLeadRow there — we do
 * NOT re-fetch or re-shape anything here.
 */




function buildOutboundPayload(leadRow, fieldMappings, statusMappings) {
  // lead_status must be transformed exactly once, into the target field
  // selected by the admin. The previous implementation first copied the
  // raw value through the field map and then wrote the translated value to
  // a hard-coded `status` key, producing two contradictory fields.
  const normalizedLead = {
    ...leadRow,
    // The workbook calls this Inquiry ID. Some existing MG rows only
    // have Zoho's immutable record id, which is still a safe idempotency
    // key and must not make an otherwise valid enquiry disappear.
    enquiry_id: leadRow.enquiry_id || leadRow.crm_record_id,
  };
  const payload = leadMappingService.mapZohoLeadToExternal(
    normalizedLead,
    fieldMappings,
    { excludeSourceFields: ['lead_status'] }
  );
  const statusFieldMapping = fieldMappings.find((mapping) => mapping.source_field === 'lead_status');
  // Update Pending, Dealer Unavailable and Unattended Alert are MG-only
  // workflow states. The approved register gives them no dealer value, so
  // inventing one would either fail the dealer picklist or falsely imply a
  // dealer action. The configured status field is still required so inbound
  // dealer lifecycle values can be identified and translated.
  if (
    leadRow.lead_status &&
    statusFieldMapping &&
    !pathPolicy.isOemOnlyStatus(leadRow.lead_status)
  ) {
    payload[statusFieldMapping.target_field] = leadMappingService.mapStatus(
      leadRow.lead_status,
      statusMappings,
      'ZOHO_TO_EXTERNAL'
    );
  }
  return payload;
}

function validateIntegrationConfiguration(integration, fieldMappings, statusMappings, leadStatus) {
  const missingConfig = [];
  if (!integration?.base_url) missingConfig.push('base_url');
  if (!integration?.create_lead_endpoint) missingConfig.push('create_lead_endpoint');
  if (!integration?.update_lead_endpoint) missingConfig.push('update_lead_endpoint');

  const configuredSources = new Set(
    fieldMappings
      .filter((row) => row.source_field && row.target_field)
      .map((row) => row.source_field)
  );
  pathPolicy.REQUIRED_DELIVERY_MAPPING_FIELDS.forEach((field) => {
    if (!configuredSources.has(field)) missingConfig.push(`field:${field}`);
  });

  if (leadStatus && !pathPolicy.isOemOnlyStatus(leadStatus)) {
    try {
      leadMappingService.mapStatus(leadStatus, statusMappings, 'ZOHO_TO_EXTERNAL');
    } catch (_) {
      missingConfig.push(`status:${leadStatus}`);
    }
  }

  return { valid: missingConfig.length === 0, missingConfig };
}

async function setLeadSyncState(catalystApp, leadRow, syncStatus) {
  if (!leadRow?.ROWID) return;
  try {
    await catalystApp.datastore().table(LEADS_TABLE).updateRow({
      ROWID: leadRow.ROWID,
      sync_status: syncStatus,
      last_synced_at: toCatalystDateTime(),
    });
  } catch (err) {
    logger.error('crmIntegrationService', `Failed to set ${syncStatus} on lead ${leadRow.crm_record_id}`, err);
  }
}

async function holdOutboundLead(catalystApp, integration, leadRow, {
  scenarioCode,
  errorCode,
  reason,
  syncStatus,
  notify = true,
}) {
  const requestReference = crypto.randomUUID();
  await setLeadSyncState(catalystApp, leadRow, syncStatus);

  // A lead that once failed delivery keeps a FAILED/FAILED_CRITICAL
  // mapping row, which is exactly what the retry sweep selects. If the
  // retry now stops at a hold (bad data, consent, routing) instead of a
  // delivery failure, leaving that row FAILED made every sweep re-hold
  // it and re-send the same alert — every 2 minutes under the Happy 4
  // fast-recovery cron. Parking the row as HELD takes it out of the
  // retry queue; correcting the lead in MG re-syncs it normally.
  if (integration?.ROWID && leadRow.crm_record_id) {
    try {
      const mapping = await findLeadMappingForIntegration(catalystApp, integration, leadRow.crm_record_id);
      if (mapping && ['FAILED', 'FAILED_CRITICAL'].includes(mapping.sync_status)) {
        await markMappingHeld(catalystApp, mapping.ROWID, errorCode);
      }
    } catch (err) {
      logger.error('crmIntegrationService', `Failed to park retry row for ${leadRow.crm_record_id}`, err);
    }
  }

  // The caller already worked out WHICH field failed and WHY; logging only
  // the bare code threw that away, leaving the operator with
  // "LEAD_VALIDATION_FAILED" and no way to tell whether the problem was the
  // mobile, the postcode or something else. The register is explicit that
  // the error must name the field and that the operator must be able to see
  // the exact field, correct it and reprocess. error_message is what the
  // lead record's error panel and the Activity Log display, so the detail
  // belongs there and not only in the alert body.
  const detailedError = reason ? `${errorCode}: ${reason}` : errorCode;

  await writeLog(catalystApp, {
    integration_id: integration?.ROWID,
    dealer_code: leadRow.dealer_code || integration?.dealer_code,
    direction: 'ZOHO_TO_EXTERNAL_CRM',
    operation: 'CREATE_LEAD',
    zoho_lead_id: leadRow.crm_record_id,
    status: 'FAILED',
    error_message: detailedError.slice(0, 500),
    request_reference: requestReference,
  }, { scenarioCode, notify, leadRow, reason });
  return { skipped: true, held: true, reason: errorCode, scenarioCode };
}

function isEnabled(value) {
  return !(
    value === false || value === 0 ||
    String(value).toLowerCase() === 'false' || String(value) === '0'
  );
}

async function syncLeadToExternalCrm(catalystApp, integration, leadRow) {
  if (!isEnabled(integration.outbound_enabled)) {
    return holdOutboundLead(catalystApp, integration, leadRow, {
      scenarioCode: 'Unhappy 5',
      errorCode: 'OUTBOUND_DISABLED',
      reason: 'Outbound delivery is disabled for the assigned dealer integration.',
      syncStatus: 'ROUTING_HOLD',
    });
  }

  const requestReference = crypto.randomUUID();
  const zohoLeadId = leadRow.crm_record_id;
  const deliveryValidation = pathPolicy.validateLeadForDelivery(leadRow);

  if (deliveryValidation.routingIssue || integration.dealer_code !== leadRow.dealer_code) {
    return holdOutboundLead(catalystApp, integration, leadRow, {
      scenarioCode: 'Unhappy 5',
      errorCode: 'DEALER_ROUTING_INVALID',
      reason: deliveryValidation.routingIssue?.rule || 'The lead dealer does not match the selected integration.',
      syncStatus: 'ROUTING_HOLD',
    });
  }

  const consentValue = resolveConsentValue(leadRow.accept_privacy_policy);
  if (consentValue !== true) {
    return handleConsentMismatch(
      catalystApp,
      integration,
      leadRow,
      zohoLeadId,
      requestReference,
      'OUTBOUND',
      consentValue
    );
  }

  if (deliveryValidation.issues.length > 0) {
    // Include the rejected value, masked, so the operator can see what the
    // record actually holds without the error panel leaking full customer
    // data (register, Unhappy 2 edge case f).
    const reason = deliveryValidation.issues
      .map((issue) => {
        const shown = pathPolicy.maskSensitiveValue(issue.field, issue.value);
        const seen = shown === '' || shown === undefined || shown === null ? 'empty' : `"${shown}"`;
        return `${issue.field} is ${seen} — ${issue.rule}`;
      })
      .join('; ');

    return holdOutboundLead(catalystApp, integration, leadRow, {
      scenarioCode: 'Unhappy 2',
      errorCode: 'LEAD_VALIDATION_FAILED',
      reason,
      syncStatus: 'VALIDATION_HOLD',
    });
  }

  const dealer = await findDealerByCode(catalystApp, leadRow.dealer_code);
  // MG Dealer Master owns trading/renewal status. Lead Exchange only
  // verifies that the routed dealer still exists and has not been removed;
  // it must not silently reject statuses such as "Renewal Review".
  const dealerIsActive = dealer && dealer.sync_status !== 'Removed';
  if (!dealerIsActive || ['NOT_CONFIGURED', 'CONFIGURING', 'DISABLED'].includes(integration.status)) {
    return holdOutboundLead(catalystApp, integration, leadRow, {
      scenarioCode: 'Unhappy 5',
      errorCode: 'DEALER_CONFIGURATION_INVALID',
      reason: !dealerIsActive
        ? 'The assigned dealer is missing or inactive in Dealer Master.'
        : `The dealer integration is ${integration.status}.`,
      syncStatus: 'ROUTING_HOLD',
    });
  }

  let operation = 'CREATE_LEAD';
  let existingMapping = null;
  let attemptStartedAt = null;

  try {
    const [fieldMappings, statusMappings, currentMapping] = await Promise.all([
      getFieldMappings(catalystApp, integration.ROWID),
      getStatusMappings(catalystApp, integration.ROWID),
      findLeadMappingForIntegration(catalystApp, integration, zohoLeadId),
    ]);
    existingMapping = currentMapping;
    operation = existingMapping?.external_crm_lead_id ? 'UPDATE_LEAD' : 'CREATE_LEAD';
    const configuration = validateIntegrationConfiguration(
      integration,
      fieldMappings,
      statusMappings,
      leadRow.lead_status
    );
    if (!configuration.valid) {
      const configError = new Error(`Incomplete dealer integration: ${configuration.missingConfig.join(', ')}`);
      configError.code = 'INVALID_CRM_CONFIGURATION';
      throw configError;
    }
    const payload = buildOutboundPayload(leadRow, fieldMappings, statusMappings);
    const adapter = crmAdapterFactory.getAdapter(integration.crm_type);
    const enquiryIdFieldMapping = fieldMappings.find(
      (mapping) => mapping.source_field === 'enquiry_id' && mapping.target_field
    );

    const outboundFingerprint = leadFingerprintService.computeFingerprint(leadRow, fieldMappings);
    if (
      existingMapping &&
      existingMapping.last_sync_direction === 'EXTERNAL_CRM_TO_ZOHO' &&
      existingMapping.last_sync_source_hash === outboundFingerprint
    ) {
      logger.info(
        'crmIntegrationService',
        `Outbound echo suppressed for lead ${zohoLeadId} (dealer ${integration.dealer_code}).`
      );
      return { skipped: true, reason: 'ECHO_SUPPRESSED_OUTBOUND' };
    }

    let result;
    attemptStartedAt = new Date();
    if (existingMapping?.external_crm_lead_id) {
      operation = 'UPDATE_LEAD';
      result = await adapter.updateLead(
        catalystApp,
        integration,
        existingMapping.external_crm_lead_id,
        payload
      );
    } else {
      result = await adapter.createLead(
        catalystApp,
        integration,
        payload,
        {
          idempotencyKey: zohoLeadId,
          idempotencyField: enquiryIdFieldMapping?.target_field,
        }
      );
      if (!result.externalLeadId) {
        const acknowledgementError = new Error('Dealer accepted the request but returned no record ID');
        acknowledgementError.code = 'DEALER_ACK_MISSING_ID';
        throw acknowledgementError;
      }
    }

    const wasRecovery = Boolean(
      existingMapping && ['FAILED', 'FAILED_CRITICAL'].includes(existingMapping.sync_status)
    );
    const failureStartedAt = pathPolicy.parseTimestamp(existingMapping?.failure_streak_started_at);
    const previousAttempts = Number(existingMapping?.retry_count || 0);
    const externalLeadId = result.externalLeadId || existingMapping?.external_crm_lead_id;
    const mappingTable = catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE);
    const mappingUpdate = {
      dealer_code: integration.dealer_code,
      zoho_lead_id: zohoLeadId,
      external_crm_lead_id: externalLeadId,
      integration_id: integration.ROWID,
      sync_status: 'SYNCED',
      last_synced_at: toCatalystDateTime(),
      last_sync_direction: 'ZOHO_TO_EXTERNAL_CRM',
      last_sync_source_hash: outboundFingerprint,
      retry_count: '0',
      last_attempted_at: toCatalystDateTime(attemptStartedAt),
      last_error: '',
    };

    if (existingMapping) {
      await mappingTable.updateRow({ ROWID: existingMapping.ROWID, ...mappingUpdate });
    } else {
      await mappingTable.insertRow(mappingUpdate);
    }

    // Happy 1 is complete only after MG records the dealer acknowledgement.
    // Persist the dealer mapping first so a write-back failure can retry as
    // an UPDATE and can never create a second dealer record.
    const needsAcknowledgementWriteback =
      operation === 'CREATE_LEAD' || existingMapping?.last_error === 'ZOHO_ACK_UPDATE_FAILED';
    if (needsAcknowledgementWriteback) {
      try {
        await oemCrmService.updateOemLead(zohoLeadId, { Lead_Status: 'Not Contacted' });
        if (leadRow.ROWID) {
          await catalystApp.datastore().table(LEADS_TABLE).updateRow({
            ROWID: leadRow.ROWID,
            lead_status: 'Not Contacted',
            last_synced_at: toCatalystDateTime(),
          });
        }
      } catch (ackErr) {
        ackErr.code = 'ZOHO_ACK_UPDATE_FAILED';
        throw ackErr;
      }
    }

    await setLeadSyncState(catalystApp, leadRow, 'SYNCED');

    await catalystApp.datastore().table(DEALER_INTEGRATIONS_TABLE).updateRow({
      ROWID: integration.ROWID,
      last_sync_at: toCatalystDateTime(),
      status: 'ACTIVE',
    });

    const scenarioCode = wasRecovery ? 'Happy 4' : operation === 'CREATE_LEAD' ? 'Happy 1' : 'Happy 5';
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'ZOHO_TO_EXTERNAL_CRM',
      operation,
      zoho_lead_id: zohoLeadId,
      external_lead_id: externalLeadId,
      status: 'SUCCESS',
      http_status: result.httpStatus,
      request_reference: requestReference,
      field_changes: JSON.stringify([{
        field: 'delivery_timing',
        sent_at: attemptStartedAt.toISOString(),
        acknowledged_at: new Date().toISOString(),
        duration_ms: Date.now() - attemptStartedAt.getTime(),
      }]),
    }, { scenarioCode });

    // A recovery that CREATED the dealer record is also the enquiry's
    // first successful routing, so MG asked for it to read
    // Unhappy 1 → Happy 4 → Happy 1 on the timeline: Happy 4 records the
    // recovery, Happy 1 records that the enquiry now exists at the dealer
    // and was acknowledged. Written after Happy 4, so the lead's current
    // path becomes Happy 1 while the failure and recovery stay in its
    // history. Recoveries of an UPDATE (record already at the dealer)
    // stay Happy 4 only.
    if (wasRecovery && operation === 'CREATE_LEAD') {
      await writeLog(catalystApp, {
        integration_id: integration.ROWID,
        dealer_code: integration.dealer_code,
        direction: 'ZOHO_TO_EXTERNAL_CRM',
        operation,
        zoho_lead_id: zohoLeadId,
        external_lead_id: externalLeadId,
        status: 'SUCCESS',
        http_status: result.httpStatus,
        request_reference: requestReference,
      }, { scenarioCode: 'Happy 1' });
    }

    if (wasRecovery) {
      const durationMinutes = failureStartedAt
        ? Math.max(0, Math.round((Date.now() - failureStartedAt.getTime()) / 60000))
        : null;
      await integrationAlertService.notifyRecovery(catalystApp, {
        dealerCode: integration.dealer_code,
        leadId: zohoLeadId,
        customerName: leadRow.customer_name,
        durationMinutes,
        attemptCount: previousAttempts + 1,
      });
    }

    return { ok: true, externalLeadId, scenarioCode, recovered: wasRecovery };
  } catch (err) {
    const isInvalidLead = err.code === 'FIELD_MAPPING_INVALID';
    const isInvalidConfiguration = [
      'STATUS_MAPPING_NOT_FOUND',
      'STATUS_MAPPING_INVALID_TARGET',
      'STATUS_MAPPING_AMBIGUOUS',
      'INVALID_CRM_CONFIGURATION',
    ].includes(err.code);
    const isNonRetryableMappingError = isInvalidLead || isInvalidConfiguration;
    let escalation = { escalate: false, firstFailure: true, newEscalation: false };
    if (!isNonRetryableMappingError && err.code !== 'DEALER_ACK_MISSING_ID') {
      try {
        escalation = await recordOutboundFailureAndCheckEscalation(
          catalystApp,
          integration,
          zohoLeadId,
          err
        );
      } catch (trackingErr) {
        logger.error('crmIntegrationService', `Failure tracking errored for lead ${zohoLeadId}`, trackingErr);
      }
    }

    let scenarioCode = 'Unhappy 1';
    if (isInvalidLead) scenarioCode = 'Unhappy 2';
    if (isInvalidConfiguration) scenarioCode = 'Unhappy 5';
    if (err.code === 'ZOHO_ACK_UPDATE_FAILED') scenarioCode = 'Unhappy 4';
    if (err.code === 'DEALER_ACK_MISSING_ID') scenarioCode = 'Unhappy 11';
    if (escalation.escalate) scenarioCode = 'Unhappy 3';
    err.scenarioCode = scenarioCode;

    if (escalation.escalate) {
      try {
        if (leadRow.ROWID) {
          await catalystApp.datastore().table(LEADS_TABLE).updateRow({
            ROWID: leadRow.ROWID,
            lead_status: DEALER_UNAVAILABLE_LEAD_STATUS,
            sync_status: 'FAILED_CRITICAL',
          });
        }
        await oemCrmService.updateOemLead(zohoLeadId, { Lead_Status: DEALER_UNAVAILABLE_LEAD_STATUS });
      } catch (statusErr) {
        logger.error('crmIntegrationService', `Failed to set dealer-unavailable status for ${zohoLeadId}`, statusErr);
      }
    }

    if (isInvalidLead) {
      await setLeadSyncState(catalystApp, leadRow, 'VALIDATION_HOLD');
      if (existingMapping) await markMappingHeld(catalystApp, existingMapping.ROWID, 'LEAD_VALIDATION_FAILED');
    } else if (isInvalidConfiguration) {
      await setLeadSyncState(catalystApp, leadRow, 'ROUTING_HOLD');
      if (existingMapping) await markMappingHeld(catalystApp, existingMapping.ROWID, err.code);
    } else if (!escalation.escalate) {
      await setLeadSyncState(catalystApp, leadRow, 'DELIVERY_FAILED');
    }

    const reason = (err.code || err.message || 'EXTERNAL_CRM_ERROR').slice(0, 500);
    // The Unhappy 3 critical alert must carry the whole outage picture,
    // not just this one lead: dealer, failure start, duration, affected
    // lead count and IDs, retry count and last API error. Only the alert
    // text is enriched; the log row keeps the plain error code.
    let alertReason = reason;
    if (escalation.newEscalation) {
      alertReason = await describeEscalation(catalystApp, integration, escalation, err, reason);
    }
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'ZOHO_TO_EXTERNAL_CRM',
      operation,
      zoho_lead_id: zohoLeadId,
      external_lead_id: existingMapping?.external_crm_lead_id,
      status: 'FAILED',
      http_status: err.response?.status,
      error_message: reason,
      request_reference: requestReference,
      field_changes: attemptStartedAt ? JSON.stringify([{
        field: 'delivery_timing',
        sent_at: attemptStartedAt.toISOString(),
        failed_at: new Date().toISOString(),
        duration_ms: Date.now() - attemptStartedAt.getTime(),
      }]) : undefined,
    }, {
      scenarioCode,
      // An acknowledgement write-back failure re-marks the mapping SYNCED on
      // every attempt (the dealer record exists), so each retry looked like
      // a first failure and re-alerted. Alert it once per lead.
      notify: err.code === 'ZOHO_ACK_UPDATE_FAILED'
        ? existingMapping?.last_error !== 'ZOHO_ACK_UPDATE_FAILED'
        : (escalation.firstFailure || escalation.newEscalation || isNonRetryableMappingError),
      leadRow,
      reason: alertReason,
    });

    if (err.response?.status === 401 || err.response?.status === 403) {
      await catalystApp.datastore().table(DEALER_INTEGRATIONS_TABLE).updateRow({
        ROWID: integration.ROWID,
        status: 'ERROR',
      });
    }

    logger.error('crmIntegrationService', `syncLeadToExternalCrm failed for dealer ${integration.dealer_code}`, err);
    throw err;
  }
}

/**
 * Internal field name -> Zoho CRM API field name, for the ONE direction
 * that actually touches zohoCrmService.updateOemLead(). This is
 * separate from admin-configurable integration_field_mappings (which
 * maps internal <-> external dealer CRM) — this map is fixed, since our
 * own `leads` table shape and Zoho's OEM_Leads API field names are both
 * fixed by leadSyncService.js / zohoCrmService.js, not admin-configurable.
 */
const INTERNAL_FIELD_TO_ZOHO_API_FIELD = {
  dealer_code: 'Dealer_Code',
  // customer_name is deliberately ABSENT — it is a derived field, not a
  // real one. fetchOemLeads reads First_Name/Last_Name and
  // mapCrmRecordToLeadRow joins them; there is no Customer_Name field on
  // MG's Leads module, so the previous `customer_name: 'Customer_Name'`
  // entry wrote to a field that does not exist and is never read back.
  // toZohoApiFields() splits it into First_Name/Last_Name instead.
  mobile_number: 'Mobile',
  email_address: 'Email',
  vehicle_model: 'Enquiry_Model',
  lead_source: 'Enquiry_Source',
  lead_status: 'Lead_Status',
  // dealer_remarks is deliberately ABSENT — verified against live CRM
  // field metadata, MG's Leads module has no Dealer_Remarks field. Zoho
  // ignores unknown names on READ but REJECTS them on write, so the old
  // entry turned any dealer remarks update into a hard Unhappy 4.
  // Needs an MG mapping decision ('Description' is the natural home)
  // before it can be re-enabled.
  enquiry_status: 'Enquiry_Status',
  nature_of_enquiry: 'Nature_of_Enquiry',
  purchase_classification: 'Purchase_Classification',
  enquiry_outcome: 'Enquiry_Outcome',
  lead_department: 'Lead_Department',
  franchise: 'Franchise',
  enquiry_id: 'Enquiry_ID',
  customer_message: 'Customer_Message',
  accept_privacy_policy: 'Accept_Privacy_Policy',
  receive_marketing_updates: 'Receive_Marketing_Updates',
  postcode: 'Postcode',
  unit_suite: 'Unit_Suite',
  enquiry_model: 'Enquiry_Model',
  enquiry_variant: 'Enquiry_Variant',
  enquiry_powertrain: 'Enquiry_Powertrain',
  chat_transcript: 'Chat_Transcript',
};

function toZohoApiFields(internalFieldsObject) {
  const zohoFields = {};
  Object.entries(internalFieldsObject).forEach(([key, value]) => {
    if (key === 'customer_name') {
      // MG's Leads module stores the name as First_Name + Last_Name.
      // Last_Name is mandatory in Zoho, so a single-token name goes
      // there rather than into First_Name.
      const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return;
      if (parts.length === 1) {
        zohoFields.Last_Name = parts[0];
      } else {
        zohoFields.First_Name = parts[0];
        zohoFields.Last_Name = parts.slice(1).join(' ');
      }
      return;
    }
    const zohoKey = INTERNAL_FIELD_TO_ZOHO_API_FIELD[key];
    if (zohoKey) zohoFields[zohoKey] = value;
  });
  return zohoFields;
}

/**
 * Internal field names we can actually persist to MG's CRM. Anything
 * outside this set must NOT be written to our local `leads` mirror
 * either: a value that lives locally but not in Zoho makes the next
 * syncLeads() run see a phantom change, which re-pushes to the dealer
 * and restarts the echo loop this release exists to kill.
 */
function isZohoWritableInternalField(key) {
  return key === 'customer_name' || Boolean(INTERNAL_FIELD_TO_ZOHO_API_FIELD[key]);
}

const INVALID_DATA_ERROR_CODES = new Set(['FIELD_MAPPING_INVALID', 'LEAD_VALIDATION_FAILED']);

/**
 * Classifies a log entry into the happy/unhappy path taxonomy, so it's
 * persisted at write time instead of re-derived on every read.
 *
 * classificationHint.isStatusSync distinguishes Happy 2 (dealer status
 * change) from Happy 5 (other dealer-side field change) on inbound
 * success — both used to log identically as UPDATE_LEAD with no way to
 * tell them apart afterward.
 *
 * classificationHint.escalateToUnhappy3 is set by syncLeadToExternalCrm
 * once a ZOHO_TO_EXTERNAL_CRM failure (Unhappy 1) has been unresolved
 * for 24h+ (see recordOutboundFailureAndCheckEscalation) — it takes
 * priority over the plain Unhappy 1 fallback below, but nothing else
 * about Unhappy 1's own classification changes.
 *
 * NOTE: this now checks error_message codes even on the
 * EXTERNAL_CRM_TO_ZOHO direction. Previously that direction only ever
 * reached writeLog via the OEM-write-back catch block, so "any failure
 * here = Unhappy 4" was a safe shortcut. Now that the early
 * LEAD_MAPPING_NOT_FOUND / FIELD_MAPPING_INVALID / STATUS_MAPPING_NOT_FOUND
 * throws in processInboundWebhook are also logged (see that function),
 * that shortcut would misclassify them, so those exact codes are
 * checked first.
 */
function classifyLogScenario(
  { direction, operation, status, error_message },
  {
    isStatusSync,
    leadStatusValue,
    escalateToUnhappy3,
    rawDealerStatus,
    unmappedStatusValue,
    scenarioCode,
    scenarioMessage,
  } = {}
) {
  if (operation === 'TEST_CONNECTION') {
    return status === 'SUCCESS'
      ? { name: 'Connection Test', message: 'Connection test succeeded.' }
      : { name: 'Connection Test Failed', message: 'Connection test failed.' };
  }

  // Call sites that know the business outcome (recovery, consent hold,
  // ownership conflict, SLA breach, etc.) are authoritative. This keeps
  // transport details from overwriting an already-established scenario.
  if (scenarioCode) {
    return pathPolicy.scenario(
      scenarioCode,
      scenarioMessage ? { message: scenarioMessage } : {}
    );
  }

  if (status === 'SUCCESS') {
    if (direction === 'EXTERNAL_CRM_TO_ZOHO') {
      if (isStatusSync) {
        // Always classify the dealer's raw value first. "Lost", "Dropped"
        // and "Not Qualified" are valid Happy 2 outcomes; only the exact
        // spam/junk family is Unhappy 9.
        const statusScenario = pathPolicy.classifyDealerStatus(rawDealerStatus || leadStatusValue);
        if (statusScenario?.code === 'Unhappy 9') {
          return {
            ...statusScenario,
            message: `Dealer rejects enquiry — classified "${rawDealerStatus || leadStatusValue}"`,
          };
        }
        return pathPolicy.scenario('Happy 2');
      }
      return pathPolicy.scenario('Happy 5');
    }
    return pathPolicy.scenario('Happy 1');
  }

  // status === 'FAILED' from here down.
  const code = (error_message || '').trim();

  // The requested 15-path register assigns a failed dealer -> MG status
  // update (including an unmapped raw status held for review) to Unhappy 4.
  if (unmappedStatusValue || code.startsWith('STATUS_MAPPING_NOT_FOUND')) {
    return pathPolicy.scenario('Unhappy 4', {
      message: `Unmapped or invalid dealer status "${unmappedStatusValue || 'unknown'}" — held for mapping correction`,
    });
  }

  if (code === CONSENT_MISMATCH_ERROR_CODE) {
    return pathPolicy.scenario('Unhappy 8');
  }

  if (code === 'LEAD_MAPPING_NOT_FOUND') {
    return pathPolicy.scenario('Unhappy 7');
  }

  if (INVALID_DATA_ERROR_CODES.has(code)) {
    return pathPolicy.scenario('Unhappy 2');
  }

  if (direction === 'EXTERNAL_CRM_TO_ZOHO') {
    // Everything else on this direction is the OEM write-back call
    // itself failing (ZOHO_UPDATE_FAILED) — genuinely Unhappy 4.
    return pathPolicy.scenario('Unhappy 4');
  }

  // ZOHO_TO_EXTERNAL_CRM, anything else — connectivity/API failure.
  if (escalateToUnhappy3) {
    return pathPolicy.scenario('Unhappy 3', { message: UNHAPPY_3_MESSAGE });
  }

  return pathPolicy.scenario('Unhappy 1');
}

async function writeLog(catalystApp, entry, classificationHint) {
  const scenario = classifyLogScenario(entry, classificationHint);

  const logRow = Object.fromEntries(Object.entries({
    ...entry,
    happy_unhappy_path_name: scenario.code || scenario.name,
    happy_unhappy_path_message: scenario.message,
    ...(scenario.priority ? { happy_unhappy_path_priority: scenario.priority } : {}),
  }).filter(([, value]) => value !== undefined));

  try {
    await catalystApp.datastore().table(INTEGRATION_LOGS_TABLE).insertRow(logRow);
  } catch (err) {
    // The P1 paths (Unhappy 3, Unhappy 8) were completely invisible
    // because happy_unhappy_path_priority did not exist on this table:
    // Catalyst rejected the whole insert and this catch swallowed it, so
    // the escalation ran but left no evidence at all. The column now
    // exists; this retry keeps the log row even if a future environment
    // is missing it, rather than losing the entire entry over one field.
    if (scenario.priority) {
      logger.error('crmIntegrationService', 'Log insert failed with priority set — retrying without it', err);
      try {
        const { happy_unhappy_path_priority, ...withoutPriority } = logRow;
        await catalystApp.datastore().table(INTEGRATION_LOGS_TABLE).insertRow(withoutPriority);
      } catch (retryErr) {
        logger.error('crmIntegrationService', 'Failed to write integration log', retryErr);
      }
    } else {
      logger.error('crmIntegrationService', 'Failed to write integration log', err);
    }
  }

  // Mirror the same classification onto the lead row itself, so
  // LeadDetailView's hero badge can read a stored value instead of
  // re-guessing the scenario from lead_status/sync_status. Only
  // attempted when this log entry is actually tied to a known Zoho
  // lead (zoho_lead_id) — TEST_CONNECTION and early validation
  // failures (bad webhook payload, no lead mapping yet) have no
  // zoho_lead_id and are skipped here; they're still fully visible in
  // the dealer's raw Activity Log via integration_logs, just not
  // mirrored onto any specific lead.
  if (entry.zoho_lead_id) {
    try {
      const leadRows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT ROWID FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(entry.zoho_lead_id)}' LIMIT 1`
      );
      if (leadRows.length > 0) {
        const scenarioMirror = {
          ROWID: leadRows[0][LEADS_TABLE].ROWID,
          happy_unhappy_path_name: scenario.code || scenario.name,
          happy_unhappy_path_message: scenario.message,
          happy_unhappy_path_priority: scenario.priority || '',
        };
        try {
          await catalystApp.datastore().table(LEADS_TABLE).updateRow(scenarioMirror);
        } catch (mirrorErr) {
          // Preserve the path badge in environments that have not yet
          // provisioned the optional priority column.
          const { happy_unhappy_path_priority, ...withoutPriority } = scenarioMirror;
          await catalystApp.datastore().table(LEADS_TABLE).updateRow(withoutPriority);
        }
      }
    } catch (err) {
      logger.error('crmIntegrationService', `Failed to mirror scenario onto lead ${entry.zoho_lead_id}`, err);
    }
  }

  if (classificationHint?.notify && (scenario.code || scenario.name)?.startsWith('Unhappy')) {
    try {
      await integrationAlertService.notifyScenario(catalystApp, {
        scenarioCode: scenario.code || scenario.name,
        scenarioMessage: scenario.message,
        priority: scenario.priority,
        dealerCode: entry.dealer_code,
        leadId: entry.zoho_lead_id,
        customerName: classificationHint.leadRow?.customer_name,
        reason: classificationHint.reason || entry.error_message,
      });
    } catch (err) {
      logger.error('crmIntegrationService', `Failed to send ${scenario.code || scenario.name} alert`, err);
    }
  }
}

async function recordScenario(catalystApp, {
  scenarioCode,
  dealerCode,
  leadRow,
  direction = 'ZOHO_TO_EXTERNAL_CRM',
  operation = 'CREATE_LEAD',
  status,
  errorCode,
  reason,
  notify = false,
  externalLeadId,
  fieldChanges,
  integrationId,
}) {
  const scenario = pathPolicy.scenario(scenarioCode);

  // Same rule as holdOutboundLead: the caller has already worked out WHICH
  // field failed and why, so that detail belongs in error_message. This is
  // the field the lead's error panel and the Activity Log render, and
  // logging the bare code left the operator with "LEAD_VALIDATION_FAILED"
  // and no way to tell whether the problem was the mobile, the postcode or
  // something else. The register requires the error to name the field.
  const detailedError = errorCode && reason ? `${errorCode}: ${reason}` : (errorCode || undefined);

  return writeLog(catalystApp, {
    integration_id: integrationId,
    dealer_code: dealerCode || leadRow?.dealer_code,
    direction,
    operation,
    zoho_lead_id: leadRow?.crm_record_id,
    external_lead_id: externalLeadId,
    status: status || (scenario.type === 'happy' ? 'SUCCESS' : 'FAILED'),
    error_message: detailedError ? String(detailedError).slice(0, 500) : undefined,
    request_reference: crypto.randomUUID(),
    field_changes: fieldChanges ? JSON.stringify(fieldChanges) : undefined,
  }, { scenarioCode, notify, leadRow, reason });
}

/**
 * ============================================================
 * INBOUND: External CRM webhook -> Zoho (via zohoCrmService.updateOemLead)
 * ============================================================
 */
/**
 * ============================================================
 * INBOUND: External CRM webhook -> Zoho (via zohoCrmService.updateOemLead)
 * ============================================================
 * Dispatches to a Zoho-notification-shaped handler when the dealer's
 * own CRM is itself Zoho CRM — that payload shape (`ids` + `affected_fields`,
 * no actual values) is fundamentally different from a generic REST CRM's
 * webhook (flat object with real field values), so it can't share the
 * single-record resolution logic below. Everything AFTER a record is
 * resolved (mapping, status sync, write-back, logging) is identical
 * for both, and lives in processResolvedInboundLead().
 */
async function processInboundWebhook(catalystApp, integration, externalPayload, zohoCrmService) {
  if (integration.crm_type === 'ZOHO_CRM') {
    return processInboundWebhookForZohoCrm(catalystApp, integration, externalPayload, zohoCrmService);
  }

  const requestReference = crypto.randomUUID();
  const fieldMappings = await getFieldMappings(catalystApp, integration.ROWID);
  const statusMappings = await getStatusMappings(catalystApp, integration.ROWID);

  const externalLeadId = externalPayload.id || externalPayload.leadId;
  if (!externalLeadId) {
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      status: 'FAILED',
      error_message: 'FIELD_MAPPING_INVALID',
      request_reference: requestReference,
    });
    const err = new Error('Webhook payload missing external lead id');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  return processResolvedInboundLead(
    catalystApp, integration, externalLeadId, externalPayload,
    fieldMappings, statusMappings, requestReference, zohoCrmService
  );
}

/**
 * Zoho-as-dealer-CRM path. A single Zoho notification can carry
 * multiple changed record ids (Zoho batches these), and — unlike a
 * generic REST webhook — carries no field values at all, only which
 * ids/fields changed. Each id must be fetched individually from the
 * dealer's Zoho org via getLead() before it can be mapped.
 *
 * Each id is processed independently: one id's failure (bad mapping,
 * transient Zoho error, etc.) must not prevent the others in the same
 * notification from syncing. Per-id outcomes are still written to
 * integration_logs exactly as before — this only changes how
 * externalLeadId/externalRecord get resolved, and how multiple ids in
 * one call are handled. The whole call is only reported as FAILED
 * (bubbled up to mark the webhook_events row) if every id in the batch
 * failed; markWebhookEventStatus/the HTTP response otherwise reflects
 * success even if some ids in the batch failed, since those failures
 * are already visible per-row in the Activity Log.
 */
async function processInboundWebhookForZohoCrm(catalystApp, integration, externalPayload, zohoCrmService) {
  const fieldMappings = await getFieldMappings(catalystApp, integration.ROWID);
  const statusMappings = await getStatusMappings(catalystApp, integration.ROWID);
  const adapter = crmAdapterFactory.getAdapter(integration.crm_type);

  const ids = Array.isArray(externalPayload.ids) ? externalPayload.ids : [];
  if (ids.length === 0) {
    const requestReference = crypto.randomUUID();
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      status: 'FAILED',
      error_message: 'FIELD_MAPPING_INVALID',
      request_reference: requestReference,
    });
    const err = new Error('Zoho notification payload missing ids');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  const results = [];
  let lastError = null;

  for (const externalLeadId of ids) {
    const requestReference = crypto.randomUUID();
    try {
      const fetched = await adapter.getLead(catalystApp, integration, externalLeadId);
      const zohoRecord = fetched.raw?.data?.[0];

      if (!zohoRecord) {
        await writeLog(catalystApp, {
          integration_id: integration.ROWID,
          dealer_code: integration.dealer_code,
          direction: 'EXTERNAL_CRM_TO_ZOHO',
          operation: 'UPDATE_LEAD',
          external_lead_id: externalLeadId,
          status: 'FAILED',
          error_message: 'FIELD_MAPPING_INVALID',
          request_reference: requestReference,
        });
        throw Object.assign(new Error(`Could not fetch external lead ${externalLeadId} from dealer's Zoho org`), { code: 'FIELD_MAPPING_INVALID' });
      }

      const affectedFields = extractAffectedFieldNames(externalPayload, externalLeadId); 

      const result = await processResolvedInboundLead(
        catalystApp, integration, externalLeadId, zohoRecord,
        fieldMappings, statusMappings, requestReference, zohoCrmService,affectedFields 
      );
      results.push({ externalLeadId, ...result });
    } catch (err) {
      lastError = err;
      results.push({
        externalLeadId,
        ok: false,
        held: err.code === 'LEAD_MAPPING_NOT_FOUND',
        error: err.code || err.message,
      });
    }
  }

  const anySucceeded = results.some((r) => r.ok);
  if (!anySucceeded && lastError) throw lastError;

  return { ok: true, held: results.some((r) => r.held), results };
}

async function replayInboundLead(
  catalystApp, integration, externalLeadId, zohoCrmService = oemCrmService, { replay = false } = {}
) {
  const [fieldMappings, statusMappings] = await Promise.all([
    getFieldMappings(catalystApp, integration.ROWID),
    getStatusMappings(catalystApp, integration.ROWID),
  ]);
  const adapter = crmAdapterFactory.getAdapter(integration.crm_type);

  // A dealer record we hold a reference for but which the dealer CRM can no
  // longer produce is Unhappy 11 (partial transaction), NOT a mapping fault:
  // MG believes the lead was delivered and the dealer has nothing. The
  // register calls this the most damaging failure precisely because neither
  // side sees it, so it gets its own code rather than being folded into
  // FIELD_MAPPING_INVALID.
  let fetched;
  try {
    fetched = await adapter.getLead(catalystApp, integration, externalLeadId);
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 204) {
      const missing = new Error(`Dealer record ${externalLeadId} no longer exists at the dealer CRM`);
      missing.code = 'DEALER_RECORD_NOT_FOUND';
      missing.externalLeadId = externalLeadId;
      throw missing;
    }
    throw err;
  }

  const raw = fetched.raw;
  const externalRecord = Array.isArray(raw?.data)
    ? raw.data[0]
    : (raw?.data && typeof raw.data === 'object' ? raw.data : raw);
  if (!externalRecord || typeof externalRecord !== 'object') {
    const err = new Error(`Dealer record ${externalLeadId} no longer exists at the dealer CRM`);
    err.code = 'DEALER_RECORD_NOT_FOUND';
    err.externalLeadId = externalLeadId;
    throw err;
  }
  return processResolvedInboundLead(
    catalystApp,
    integration,
    externalLeadId,
    externalRecord,
    fieldMappings,
    statusMappings,
    crypto.randomUUID(),
    zohoCrmService,
    null,
    { replay }
  );
}

/**
 * Shared tail end of the inbound flow, once a single external lead id
 * and its flat field-value record are in hand — identical for a
 * generic REST dealer CRM (externalRecord = the raw webhook payload)
 * and a Zoho-dealer-CRM lead (externalRecord = the record fetched via
 * getLead()). This is the unchanged body that used to live directly
 * inside processInboundWebhook, from the lead-mapping lookup onward.
 */
async function processResolvedInboundLead(
  catalystApp, integration, externalLeadId, externalRecord,
  fieldMappings, statusMappings, requestReference, zohoCrmService,
  affectedFields = null,
  { replay = false } = {}
) {
  // replay: this is the Unhappy 4 replay sweep re-checking an update that
  // is already held with an open FAILED log. A still-failing replay must
  // not add a second timeline entry or a second alert — the original
  // Unhappy 4 stays the single open record until it is resolved.
  const mappingRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE integration_id = ${integration.ROWID} AND dealer_code = '${safeQuoteForZcql(integration.dealer_code)}' AND external_crm_lead_id = '${safeQuoteForZcql(externalLeadId)}' LIMIT 1`
  );

  if (mappingRows.length === 0) {
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      external_lead_id: externalLeadId,
      status: 'FAILED',
      error_message: 'LEAD_MAPPING_NOT_FOUND',
      request_reference: requestReference,
    }, {
      scenarioCode: 'Unhappy 7',
      notify: true,
      reason: `Dealer update ${externalLeadId} arrived before its lead mapping existed; queued for replay.`,
    });
    const err = new Error(`No lead mapping found for external lead ${externalLeadId}`);
    err.code = 'LEAD_MAPPING_NOT_FOUND';
    throw err;
  }

  const mapping = mappingRows[0][LEAD_INTEGRATIONS_TABLE];

  // NOTE: the echo check that used to sit here hashed `externalRecord`
  // (the dealer CRM's whole record) and compared it against a hash of
  // our mapped OUTBOUND payload. Those two objects never match, so it
  // never fired. It now happens after mapping, against a canonical
  // internal-state fingerprint — see the ECHO GUARD below.

  // Snapshot BEFORE update — the only chance to capture "from" values.
  const existingLeadRowsBefore = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
  );
  const existingLeadRow = existingLeadRowsBefore.length > 0 ? existingLeadRowsBefore[0][LEADS_TABLE] : null;

  if (!existingLeadRow) {
    if (!replay) await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      zoho_lead_id: mapping.zoho_lead_id,
      external_lead_id: externalLeadId,
      status: 'FAILED',
      error_message: 'LEAD_MAPPING_NOT_FOUND',
      request_reference: requestReference,
    }, {
      scenarioCode: 'Unhappy 7',
      notify: mapping.last_error !== 'LEAD_MAPPING_NOT_FOUND',
      reason: 'Dealer update arrived before the corresponding MG lead mirror was available.',
    });
    await markMappingHeld(catalystApp, mapping.ROWID, 'LEAD_MAPPING_NOT_FOUND');
    const err = new Error(`MG lead ${mapping.zoho_lead_id} is not available yet; update held for replay`);
    err.code = 'LEAD_MAPPING_NOT_FOUND';
    throw err;
  }

  const consentFieldMapping = fieldMappings.find((m) => m.source_field === 'accept_privacy_policy');
  if (consentFieldMapping) {
    const consentWasSent = Object.prototype.hasOwnProperty.call(
      externalRecord,
      consentFieldMapping.target_field
    );
    const rawIncomingConsent = consentWasSent
      ? externalRecord[consentFieldMapping.target_field]
      : existingLeadRow.accept_privacy_policy;
    const incomingConsentValue = resolveConsentValue(rawIncomingConsent);
    if (consentWasSent && incomingConsentValue !== true) {
      return handleConsentMismatch(
        catalystApp, integration, existingLeadRow, mapping.zoho_lead_id,
        requestReference, 'INBOUND', incomingConsentValue
      );
    }
  }

  // Status and privacy are governed separately: status must pass through
  // the approved status map, and MG is authoritative for privacy consent.
  // Copying either raw value through the generic mapper is what previously
  // allowed an unmapped dealer status or privacy edit to leak into MG.
  const effectiveFieldMappings = affectedFields
    ? fieldMappings.filter((mappingRow) => affectedFields.includes(mappingRow.target_field))
    : fieldMappings;
  const mappedUpdate = leadMappingService.mapExternalLeadToZoho(
    externalRecord,
    effectiveFieldMappings,
    { excludeSourceFields: ['lead_status', 'accept_privacy_policy'] }
  );

  const statusFieldMapping = fieldMappings.find((m) => m.source_field === 'lead_status');
  const statusTargetField = statusFieldMapping ? statusFieldMapping.target_field : 'status';
  const incomingStatusValue = externalRecord[statusTargetField];

  let isStatusSync = affectedFields
    ? affectedFields.includes(statusTargetField)
    : Object.prototype.hasOwnProperty.call(externalRecord, statusTargetField);

  // Unhappy 9 is decided on the dealer's RAW value, before the status
  // map can erase the distinction. Captured here so it survives into
  // the log classification below.
  const rawDealerStatus = incomingStatusValue;

  if (isStatusSync) {
    try {
      mappedUpdate.lead_status = leadMappingService.mapStatus(
        incomingStatusValue,
        statusMappings,
        'EXTERNAL_TO_ZOHO',
        { validDestinationValues: pathPolicy.getMgLeadStatusSet() }
      );
    } catch (err) {
      const rawStatusScenario = pathPolicy.classifyDealerStatus(incomingStatusValue);
      const heldScenarioCode = rawStatusScenario?.code === 'Unhappy 9'
        ? 'Unhappy 9'
        : 'Unhappy 4';
      // Hold the raw value for review. Never write a blank or unapproved
      // status and never continue with a misleading success log. Spam/junk
      // remains Unhappy 9 while a missing or invalid map is corrected.
      logger.error(
        'crmIntegrationService',
        `Unmapped dealer status "${incomingStatusValue}" for dealer ${integration.dealer_code} — held pending an MG mapping decision`,
        err
      );
      if (!replay) {
        await writeLog(catalystApp, {
          integration_id: integration.ROWID,
          dealer_code: integration.dealer_code,
          direction: 'EXTERNAL_CRM_TO_ZOHO',
          operation: 'UPDATE_LEAD',
          zoho_lead_id: mapping.zoho_lead_id,
          external_lead_id: externalLeadId,
          status: 'FAILED',
          error_message: `STATUS_MAPPING_NOT_FOUND: dealer sent "${incomingStatusValue}"`,
          request_reference: requestReference,
        }, {
          scenarioCode: heldScenarioCode,
          unmappedStatusValue: incomingStatusValue,
          ...(heldScenarioCode === 'Unhappy 4' ? {
            scenarioMessage: `Mapping failure — dealer status "${incomingStatusValue}" is not in the approved map; held for an MG mapping decision`,
          } : {}),
          notify: mapping.last_error !== `UNMAPPED_STATUS:${incomingStatusValue}`,
          leadRow: existingLeadRow,
          reason: `Mapping failure: unmapped dealer status "${incomingStatusValue}" was held and not written to MG.`,
        });
      }

      await markMappingHeld(catalystApp, mapping.ROWID, `UNMAPPED_STATUS:${incomingStatusValue}`);
      return {
        skipped: true,
        held: true,
        reason: 'STATUS_MAPPING_NOT_FOUND',
        heldValue: incomingStatusValue,
        scenarioCode: heldScenarioCode,
      };
    }
  }

  // Once Unhappy 10 has raised Unattended Alert, a repeated dealer
  // acknowledgement / Not Contacted snapshot is still "no action". Daily
  // reconciliation must not roll MG backwards to Not Contacted and erase the
  // breach. A genuinely progressed status (Follow-up, Contacted, outcome,
  // etc.) is allowed through and clears the held mapping on success.
  if (
    mapping.sync_status === 'SLA_BREACH' &&
    mappedUpdate.lead_status !== undefined &&
    pathPolicy.isWaitingForDealerActionStatus(mappedUpdate.lead_status)
  ) {
    delete mappedUpdate.lead_status;
    isStatusSync = false;
    if (Object.keys(mappedUpdate).length === 0) {
      return { skipped: true, reason: 'SLA_BREACH_STILL_UNACTIONED' };
    }
  }

  if (Object.keys(mappedUpdate).length === 0) {
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      zoho_lead_id: mapping.zoho_lead_id,
      external_lead_id: externalLeadId,
      status: 'FAILED',
      error_message: 'FIELD_MAPPING_INVALID',
      request_reference: requestReference,
    });
    const err = new Error('Webhook payload produced no mapped fields to update');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  // Never persist locally what MG's CRM cannot store. A field that lives
  // in our `leads` mirror but not in Zoho reads as a change on the next
  // syncLeads() run, which re-pushes to the dealer and restarts the loop.
  const unwritableFields = Object.keys(mappedUpdate).filter((k) => !isZohoWritableInternalField(k));
  if (unwritableFields.length > 0) {
    logger.info(
      'crmIntegrationService',
      `Dropping dealer field(s) with no MG CRM destination for lead ${mapping.zoho_lead_id}: ${unwritableFields.join(', ')}`
    );
    unwritableFields.forEach((k) => { delete mappedUpdate[k]; });
  }

  if (Object.keys(mappedUpdate).length === 0) {
    return { skipped: true, reason: 'NO_WRITABLE_FIELDS' };
  }

  const { allowed: ownedUpdate, conflicts } = pathPolicy.partitionInboundByOwnership(
    mappedUpdate,
    existingLeadRow
  );

  // Keep only true changes. This is important for generic full-record
  // webhooks: a no-op write to MG would trigger its watch channel and
  // recreate the loop even though the values did not change.
  const internalUpdate = Object.fromEntries(
    Object.entries(ownedUpdate).filter(([key, value]) =>
      String(existingLeadRow[key] ?? '') !== String(value ?? '')
    )
  );

  const fieldChanges = Object.keys(internalUpdate)
    .map((key) => ({
      field: key,
      from: existingLeadRow ? (existingLeadRow[key] ?? '') : '',
      to: internalUpdate[key] ?? '',
      ...(key === 'lead_status' ? {
        raw_dealer_value: rawDealerStatus,
        dealer_changed_at: externalRecord.Modified_Time || externalRecord.modified_at || null,
        received_at: new Date().toISOString(),
      } : {}),
    }))
    .filter((change) => String(change.from) !== String(change.to));

  if (conflicts.length > 0) {
    const safeConflicts = conflicts.map(({ field, mgValue, dealerValue }) => ({
      field,
      from: pathPolicy.maskSensitiveValue(field, mgValue),
      to: pathPolicy.maskSensitiveValue(field, dealerValue),
      decision: 'MG value retained; dealer value held by ownership policy',
    }));
    await writeLog(catalystApp, {
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      direction: 'EXTERNAL_CRM_TO_ZOHO',
      operation: 'UPDATE_LEAD',
      zoho_lead_id: mapping.zoho_lead_id,
      external_lead_id: externalLeadId,
      status: 'FAILED',
      error_message: 'OWNERSHIP_CONFLICT',
      request_reference: requestReference,
      field_changes: JSON.stringify(safeConflicts),
    }, {
      scenarioCode: 'Unhappy 6',
      notify: mapping.last_error !== 'OWNERSHIP_CONFLICT',
      leadRow: existingLeadRow,
      reason: `Dealer attempted to change MG-owned field(s): ${conflicts.map((item) => item.field).join(', ')}`,
    });
  }

  if (Object.keys(internalUpdate).length === 0) {
    if (conflicts.length > 0) {
      await markMappingHeld(catalystApp, mapping.ROWID, 'OWNERSHIP_CONFLICT');
      return { skipped: true, held: true, reason: 'OWNERSHIP_CONFLICT', scenarioCode: 'Unhappy 6' };
    }
    return { skipped: true, reason: 'NO_CHANGES' };
  }

  // ECHO GUARD (inbound). Compare the post-update internal business
  // state—not the dealer's transport envelope—with the last outbound
  // fingerprint. Both directions now hash the same field names/values.
  const projectedFingerprint = leadFingerprintService.computeProjectedInboundFingerprint(
    existingLeadRow,
    internalUpdate,
    fieldMappings
  );
  if (
    mapping.last_sync_direction === 'ZOHO_TO_EXTERNAL_CRM' &&
    mapping.last_sync_source_hash === projectedFingerprint
  ) {
    logger.info(
      'crmIntegrationService',
      `Inbound echo suppressed for lead ${mapping.zoho_lead_id} (dealer ${integration.dealer_code}) — identical to the state we just pushed.`
    );
    return { skipped: true, reason: 'ECHO_SUPPRESSED_INBOUND' };
  }

  const zohoApiFields = toZohoApiFields(internalUpdate);

  try {
    await zohoCrmService.updateOemLead(mapping.zoho_lead_id, zohoApiFields);

    const localLeadRows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
    );
    if (localLeadRows.length > 0) {
      await catalystApp.datastore().table(LEADS_TABLE).updateRow({
        ROWID: localLeadRows[0][LEADS_TABLE].ROWID,
        ...internalUpdate,
        last_synced_at: toCatalystDateTime(),
      });
    }

    await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
      ROWID: mapping.ROWID,
      // The accepted fields were applied, so the record is in sync. A held
      // protected field (Unhappy 6) is recorded in last_error so its alert
      // is not repeated, without marking the whole record as held.
      sync_status: 'SYNCED',
      last_synced_at: toCatalystDateTime(),
      last_sync_direction: 'EXTERNAL_CRM_TO_ZOHO',
      // Same canonical internal-state fingerprint the outbound side
      // computes, so the outbound echo guard can recognise this state.
      last_sync_source_hash: leadFingerprintService.computeProjectedInboundFingerprint(
        existingLeadRow, internalUpdate, fieldMappings
      ),
      last_error: conflicts.length > 0 ? 'OWNERSHIP_CONFLICT' : '',
    });

    // Always record what WAS applied (Happy 2 / Happy 5), even when the same
    // dealer edit also touched a protected field — that part is its own
    // Unhappy 6 entry above. Previously a mixed edit logged only the
    // Unhappy 6, so the synchronised fields never reached the timeline.
    {
      await writeLog(catalystApp, {
        integration_id: integration.ROWID,
        dealer_code: integration.dealer_code,
        direction: 'EXTERNAL_CRM_TO_ZOHO',
        operation: 'UPDATE_LEAD',
        zoho_lead_id: mapping.zoho_lead_id,
        external_lead_id: externalLeadId,
        status: 'SUCCESS',
        request_reference: requestReference,
        field_changes: fieldChanges.length > 0 ? JSON.stringify(fieldChanges) : null,
      }, {
        isStatusSync,
        leadStatusValue: internalUpdate.lead_status,
        rawDealerStatus,
        notify: pathPolicy.classifyDealerStatus(rawDealerStatus)?.code === 'Unhappy 9',
        leadRow: existingLeadRow,
        reason: pathPolicy.classifyDealerStatus(rawDealerStatus)?.code === 'Unhappy 9'
          ? `Dealer classified the enquiry as "${rawDealerStatus}".`
          : undefined,
      });
    }

    return {
      ok: true,
      zohoLeadId: mapping.zoho_lead_id,
      scenarioCode: isStatusSync ? (pathPolicy.classifyDealerStatus(rawDealerStatus)?.code || 'Happy 2') : 'Happy 5',
      conflicts,
    };
  } catch (err) {
    // Transport (MG unreachable, token, rate limit, 5xx) is retried by
    // the replay sweep; validation (MG refused the values) is held for
    // correction. The register requires the reason to say which.
    const category = err.writeBackCategory === 'VALIDATION' ? 'VALIDATION' : 'TRANSPORT';
    const failureKey = `MG_WRITE_BACK_FAILED:${category}`;
    if (!replay) {
      const dealerValues = Object.entries(internalUpdate)
        .map(([key, value]) => `${key}="${pathPolicy.maskSensitiveValue(key, value)}"`)
        .join(', ');
      await writeLog(catalystApp, {
        integration_id: integration.ROWID,
        dealer_code: integration.dealer_code,
        direction: 'EXTERNAL_CRM_TO_ZOHO',
        operation: 'UPDATE_LEAD',
        zoho_lead_id: mapping.zoho_lead_id,
        external_lead_id: externalLeadId,
        status: 'FAILED',
        error_message: `${failureKey}: ${err.message || 'ZOHO_UPDATE_FAILED'}`.slice(0, 500),
        request_reference: requestReference,
        field_changes: fieldChanges.length > 0 ? JSON.stringify(fieldChanges) : null,
      }, {
        scenarioCode: 'Unhappy 4',
        scenarioMessage: category === 'VALIDATION'
          ? 'Validation failure at MG — dealer update refused by MG CRM; held for correction'
          : 'Transport failure — MG CRM could not be updated; retrying automatically',
        notify: mapping.last_error !== failureKey,
        leadRow: existingLeadRow,
        reason: `${category === 'VALIDATION' ? 'Validation' : 'Transport'} failure writing dealer update to MG (${dealerValues}): ${err.message || 'MG CRM write-back failed.'}`,
      });
      try {
        await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
          ROWID: mapping.ROWID,
          last_error: failureKey,
          last_attempted_at: toCatalystDateTime(),
        });
      } catch (markErr) {
        logger.error('crmIntegrationService', `Failed to record write-back failure on mapping ${mapping.ROWID}`, markErr);
      }
    }
    const wrapped = new Error(err.message);
    wrapped.code = 'ZOHO_UPDATE_FAILED';
    wrapped.writeBackCategory = category;
    throw wrapped;
  }
}


async function checkAndRecordWebhookEvent(catalystApp, integration, rawBody, eventId) {
  const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');

  // Only a provider-issued event id is safe for event-level dedupe. Zoho
  // notifications can contain only record id + affected field names, so
  // two legitimate status changes seconds apart have byte-identical bodies.
  // Hashing those bodies as a permanent key dropped the later change. When
  // no event id exists, process the event and rely on state fingerprints /
  // no-change detection for idempotency rather than risk data loss.
  const dedupeKey = `${integration.ROWID}:${eventId || crypto.randomUUID()}`;

  try {
    const inserted = await catalystApp.datastore().table(WEBHOOK_EVENTS_TABLE).insertRow({
      integration_id: integration.ROWID,
      dealer_code: integration.dealer_code,
      event_id: eventId || null,
      payload_hash: payloadHash,
      dedupe_key: dedupeKey, // NEW — the column with the unique constraint
      processing_status: 'RECEIVED',
      received_at: toCatalystDateTime(),
    });
    return { isDuplicate: false, eventRowId: inserted.ROWID };
  } catch (err) {
    const message = (err.message || '').toLowerCase();
    const isDuplicateConstraintError =
      message.includes('unique') || message.includes('duplicate') || err.code === 'DUPLICATE_DATA';

    if (isDuplicateConstraintError) {
      logger.info('crmIntegrationService', `Duplicate webhook event detected (dedupe_key=${dedupeKey})`);
      return { isDuplicate: true };
    }

    throw err;
  }
}

async function markWebhookEventStatus(catalystApp, eventRowId, status, errorMessage) {
  const update = {
    ROWID: eventRowId,
    processing_status: status,
    processed_at: toCatalystDateTime(),
  };
  if (errorMessage) update.error_message = String(errorMessage).slice(0, 500);
  await catalystApp.datastore().table(WEBHOOK_EVENTS_TABLE).updateRow(update);
}

async function testConnection(catalystApp, integration) {
  const adapter = crmAdapterFactory.getAdapter(integration.crm_type);
  const result = await adapter.testConnection(catalystApp, integration);

  await catalystApp.datastore().table(DEALER_INTEGRATIONS_TABLE).updateRow({
    ROWID: integration.ROWID,
    last_tested_at: toCatalystDateTime(),
    status: result.ok ? 'CONNECTED' : 'ERROR',
  });

  await writeLog(catalystApp, {
    integration_id: integration.ROWID,
    dealer_code: integration.dealer_code,
    direction: 'ZOHO_TO_EXTERNAL_CRM',
    operation: 'TEST_CONNECTION',
    status: result.ok ? 'SUCCESS' : 'FAILED',
    http_status: result.httpStatus,
  });

  return result;
}

async function getLeadActivityTimeline(catalystApp, crmRecordId) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${INTEGRATION_LOGS_TABLE} WHERE zoho_lead_id = '${safeQuoteForZcql(crmRecordId)}' ORDER BY CREATEDTIME ASC`
  );
  return rows.map((r) => {
    const log = r[INTEGRATION_LOGS_TABLE];
    return { ...log, created_at: log.CREATEDTIME };
  });
}

module.exports = {
  findDealerByCode,
  getIntegrationByDealerCode,
  getFieldMappings,
  getStatusMappings,
  syncLeadToExternalCrm,
  processInboundWebhook,
  replayInboundLead,
  checkAndRecordWebhookEvent,
  markWebhookEventStatus,
  testConnection,
  getLeadActivityTimeline,
  recordScenario,
  RETRY_INTERVAL_MINUTES, // read by outboundRetryScheduler.js for logging only
  _test: {
    buildOutboundPayload,
    classifyLogScenario,
    toZohoApiFields,
    validateIntegrationConfiguration,
    extractAffectedFieldNames,
  },
};
