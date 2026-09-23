'use strict';

const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const crmIntegrationService = require('./crmIntegrationService');
const crmAdapterFactory = require('./crmAdapterFactory');

const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const LEADS_TABLE = 'leads';
// Each mapping costs one dealer-CRM round trip, so the sweep is I/O bound:
// 51 mappings measured at ~20s against AU008. At 200 this exceeds Catalyst's
// applogic execution limit and the whole run is lost, taking the Unhappy 11
// detection with it. Mappings are ordered by last_attempted_at ASC and each
// one is touched as it is processed, so successive sweeps rotate through the
// full set rather than re-checking the same head every time. Overridable for
// environments with a larger budget.
const MAX_RECORDS_PER_SWEEP = (() => {
  const configured = Number(process.env.RECONCILE_MAX_PER_SWEEP);
  return Number.isFinite(configured) && configured > 0 ? configured : 40;
})();

// Optional dealer scope (comma-separated codes); unset = every dealer.
const RECONCILE_DEALER_CODES = String(process.env.RECONCILE_DEALERS || '')
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);

// Register Unhappy 11 edge case (b): a dealer CRM may create asynchronously
// and acknowledge later, so a missing record is only acted on after a
// grace period.
const RECONCILE_GRACE_MINUTES = (() => {
  const configured = Number(process.env.RECONCILE_GRACE_MINUTES);
  return Number.isFinite(configured) && configured >= 0 ? configured : 10;
})();

// Register Unhappy 11 step 4: unresolved mismatches need a named owner.
const RECONCILE_OWNER = process.env.RECONCILE_OWNER || 'FI Digital support (Lead Exchange)';

const MAX_NEVER_CREATED_PER_SWEEP = 20;

const MG_ONLY_WAITING_STATUSES = new Set(['Unattended Alert', 'Update Pending']);

// Catalyst system columns (CREATEDTIME) are in the project timezone —
// Asia/Kolkata for this project (Console > Settings > General).
const PROJECT_UTC_OFFSET = '+05:30';

function parseSystemTimestamp(value) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?::(\d{1,3}))?$/.exec(String(value || '').trim());
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}.${(match[3] || '0').padStart(3, '0')}${PROJECT_UTC_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
}

function dealerScopeClause(column) {
  if (!RECONCILE_DEALER_CODES.length) return '';
  return ` ${column} IN (${RECONCILE_DEALER_CODES.map((code) => `'${safeQuoteForZcql(code)}'`).join(', ')})`;
}

function isEnabled(value) {
  return !(
    value === false || value === 0 ||
    String(value).toLowerCase() === 'false' || String(value) === '0'
  );
}

/**
 * Daily pull reconciliation required by Happy 2 / Happy 5. It re-fetches
 * every linked dealer record and feeds it through the same mapping,
 * ownership and echo-suppression path as a webhook. Unchanged records are
 * no-ops; missed dealer changes are written back and audited.
 */
// Mapping states that are already parked on an open exception. Re-running
// the full inbound pipeline on them only re-logs the same Unhappy 4/6/8 each
// time; their releases are handled by webhooks and the inbound replay sweep.
const HELD_MAPPING_STATES = new Set(['HELD', 'CONSENT_HOLD']);

/**
 * @param {object} [options]
 * @param {boolean} [options.heldExistenceOnly=false] For held mappings, only
 *   verify the dealer record still exists (Unhappy 11) instead of
 *   reprocessing it. Used by the frequent fast-recovery pass; the daily
 *   /cron/reconcile-dealer-leads run keeps full reprocessing.
 */
async function runDealerReconciliation(catalystApp, { heldExistenceOnly = false } = {}) {
  const mappingRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE}${
      RECONCILE_DEALER_CODES.length ? ` WHERE${dealerScopeClause('dealer_code')}` : ''
    } ORDER BY last_attempted_at ASC LIMIT 0, ${MAX_RECORDS_PER_SWEEP}`
  );
  const integrations = new Map();
  const results = {
    mappings: mappingRows.length,
    checked: 0,
    changed: 0,
    unchanged: 0,
    held: 0,
    skipped: 0,
    failed: 0,
    // Unhappy 11. The register requires reconciliation to be "visible to MG
    // as a count, so a silent gap cannot persist for weeks", and to
    // distinguish 'never created' from 'created then deleted'.
    missingAtDealer: 0,
    neverCreated: 0,
    reconciled: 0,
    unresolved: 0,
  };

  for (const wrapped of mappingRows) {
    const mapping = wrapped[LEAD_INTEGRATIONS_TABLE];
    if (!mapping.integration_id || !mapping.external_crm_lead_id) {
      results.skipped += 1;
      continue;
    }

    let integration = null;
    try {
      integration = integrations.get(String(mapping.integration_id));
      if (integration === undefined) {
        const rows = await catalystApp.zcql().executeZCQLQuery(
          `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE ROWID = ${mapping.integration_id} LIMIT 1`
        );
        integration = rows[0]?.[DEALER_INTEGRATIONS_TABLE] || null;
        integrations.set(String(mapping.integration_id), integration);
      }
      if (!integration || integration.integration_type !== 'EXTERNAL_CRM' || !isEnabled(integration.inbound_enabled)) {
        results.skipped += 1;
        continue;
      }

      results.checked += 1;
      if (heldExistenceOnly && HELD_MAPPING_STATES.has(mapping.sync_status)) {
        await assertDealerRecordExists(catalystApp, integration, mapping.external_crm_lead_id);
        await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
          ROWID: mapping.ROWID,
          last_attempted_at: toCatalystDateTime(),
        });
        results.held += 1;
        continue;
      }
      const outcome = await crmIntegrationService.replayInboundLead(
        catalystApp,
        integration,
        mapping.external_crm_lead_id
      );
      await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
        ROWID: mapping.ROWID,
        last_attempted_at: toCatalystDateTime(),
      });
      if (outcome?.held) results.held += 1;
      else if (outcome?.ok) results.changed += 1;
      else results.unchanged += 1;
    } catch (err) {
      if (err.code === 'DEALER_RECORD_NOT_FOUND') {
        // MG holds a dealer reference the dealer CRM cannot produce.
        // Neither side would otherwise notice, so this is raised as its
        // own P2 and counted, rather than logged and forgotten.
        results.missingAtDealer += 1;
        await reportMissingDealerRecord(catalystApp, integration, mapping, results);
        continue;
      }

      results.failed += 1;
      try {
        await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
          ROWID: mapping.ROWID,
          last_attempted_at: toCatalystDateTime(),
        });
      } catch (touchErr) {
        logger.error(
          'dealerReconciliationService',
          `Could not rotate failed reconciliation mapping ROWID=${mapping.ROWID}`,
          touchErr
        );
      }
      logger.error(
        'dealerReconciliationService',
        `Reconcile failed for lead_integrations ROWID=${mapping.ROWID}`,
        err
      );
    }
  }

  try {
    await reconcileNeverCreated(catalystApp, integrations, results);
  } catch (err) {
    results.failed += 1;
    logger.error('dealerReconciliationService', 'Never-created reconciliation pass failed', err);
  }

  logger.info('dealerReconciliationService', `Sweep complete: ${JSON.stringify(results)}`);
  return results;
}

/**
 * Unhappy 11, 'never created': Lead Exchange recorded a successful delivery
 * transaction (a SUCCESS create to the dealer) but holds no dealer record
 * reference for the lead — the register's "OEM records the enquiry, dealer
 * creation absent or cannot be verified". Evidence is the transaction log,
 * not the lead mirror's sync_status, which older portal-mode rows also carry.
 * After the grace period it is raised as Unhappy 11 and re-delivered through
 * the normal outbound path with the lead's idempotency key, so a record the
 * dealer did create (acknowledgement lost) is matched rather than duplicated.
 */
async function reconcileNeverCreated(catalystApp, integrations, results) {
  const graceCutoff = Date.now() - RECONCILE_GRACE_MINUTES * 60 * 1000;
  const deliveryRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT zoho_lead_id, integration_id, CREATEDTIME FROM integration_logs WHERE direction = 'ZOHO_TO_EXTERNAL_CRM' AND operation = 'CREATE_LEAD' AND status = 'SUCCESS' AND happy_unhappy_path_name IN ('Happy 1', 'Happy 4')${
      RECONCILE_DEALER_CODES.length ? ` AND${dealerScopeClause('dealer_code')}` : ''
    } ORDER BY CREATEDTIME DESC LIMIT 0, 300`
  );

  const seen = new Set();
  let processed = 0;
  for (const wrapped of deliveryRows) {
    if (processed >= MAX_NEVER_CREATED_PER_SWEEP) break;
    const log = wrapped.integration_logs;
    if (!log.zoho_lead_id || !log.integration_id) continue;
    const key = `${log.integration_id}:${log.zoho_lead_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const deliveredAt = parseSystemTimestamp(log.CREATEDTIME);
    if (!deliveredAt || deliveredAt.getTime() > graceCutoff) continue;

    const mappingRows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID, external_crm_lead_id FROM ${LEAD_INTEGRATIONS_TABLE} WHERE integration_id = ${log.integration_id} AND zoho_lead_id = '${safeQuoteForZcql(log.zoho_lead_id)}' LIMIT 1`
    );
    if (mappingRows.length && mappingRows[0][LEAD_INTEGRATIONS_TABLE].external_crm_lead_id) continue;

    let integration = integrations.get(String(log.integration_id));
    if (integration === undefined) {
      const rows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE ROWID = ${log.integration_id} LIMIT 1`
      );
      integration = rows[0]?.[DEALER_INTEGRATIONS_TABLE] || null;
      integrations.set(String(log.integration_id), integration);
    }
    if (!integration || integration.integration_type !== 'EXTERNAL_CRM') continue;

    const leadRows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(log.zoho_lead_id)}' LIMIT 1`
    );
    const leadRow = leadRows[0]?.[LEADS_TABLE];
    // Only an enquiry still routed to this dealer and not linked as a
    // duplicate (Happy 3) can be missing a dealer record it should have.
    if (!leadRow || leadRow.dealer_code !== integration.dealer_code) continue;
    if (['DUPLICATE_LINKED', 'Removed'].includes(leadRow.sync_status)) continue;

    processed += 1;
    results.neverCreated += 1;
    await crmIntegrationService.recordScenario(catalystApp, {
      scenarioCode: 'Unhappy 11',
      integrationId: integration.ROWID,
      dealerCode: integration.dealer_code,
      leadRow,
      direction: 'ZOHO_TO_EXTERNAL_CRM',
      operation: 'RECONCILE',
      status: 'FAILED',
      errorCode: 'DEALER_RECORD_NEVER_CREATED',
      notify: true,
      reason:
        'A delivery to the dealer was recorded but no dealer record reference exists (never created / not verified). ' +
        'Re-delivering with the idempotency key so an existing dealer record is matched, not duplicated. ' +
        `Owner: ${RECONCILE_OWNER}.`,
    });

    await resendForReconciliation(catalystApp, integration, leadRow, results, 'never created');
  }
}

/**
 * The flow's "Re-attempt delivery with idempotency -> Dealer creation
 * succeeds?" step, shared by both Unhappy 11 cases. Delivery goes through
 * the normal outbound path (create with the lead's idempotency key), which
 * logs its own outcome. Success reconciles the MG enquiry (Happy 1); anything
 * else is flagged as an unresolved mismatch and alerted with its owner, and
 * a genuine delivery failure also stays in the Unhappy 1 retry queue.
 */
async function resendForReconciliation(catalystApp, integration, leadRow, results, mismatchKind) {
  // A re-created dealer record starts un-actioned, and a successful create
  // writes MG back to 'Not Contacted' (the acknowledgement). 'Unattended
  // Alert' (Unhappy 10) is an MG-only status with no dealer equivalent, so
  // sending it would be held as an unmapped status and leave the mismatch
  // unresolved; the re-delivery carries 'Not Contacted' instead.
  const deliveryRow = MG_ONLY_WAITING_STATUSES.has(leadRow.lead_status)
    ? { ...leadRow, lead_status: 'Not Contacted' }
    : leadRow;

  let outcome;
  try {
    outcome = await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, deliveryRow);
  } catch (err) {
    outcome = { ok: false, reason: err.code || err.message };
  }

  if (outcome && outcome.ok) {
    results.reconciled += 1;
    return;
  }

  results.unresolved += 1;
  await crmIntegrationService.recordScenario(catalystApp, {
    scenarioCode: 'Unhappy 11',
    integrationId: integration.ROWID,
    dealerCode: integration.dealer_code,
    leadRow,
    direction: 'ZOHO_TO_EXTERNAL_CRM',
    operation: 'RECONCILE',
    status: 'FAILED',
    errorCode: 'RECONCILE_UNRESOLVED',
    notify: true,
    reason:
      `Unresolved mismatch (${mismatchKind}): re-delivery did not create a dealer record ` +
      `(${(outcome && outcome.reason) || 'no dealer acknowledgement'}). Owner: ${RECONCILE_OWNER}.`,
  });
}

/**
 * Existence check only, with the same not-found semantics as
 * replayInboundLead: throws DEALER_RECORD_NOT_FOUND so the caller's
 * Unhappy 11 handling is identical.
 */
async function assertDealerRecordExists(catalystApp, integration, externalLeadId) {
  const adapter = crmAdapterFactory.getAdapter(integration.crm_type);
  let fetched;
  try {
    fetched = await adapter.getLead(catalystApp, integration, externalLeadId);
  } catch (err) {
    if (err.response?.status === 404 || err.response?.status === 204) {
      const missing = new Error(`Dealer record ${externalLeadId} no longer exists at the dealer CRM`);
      missing.code = 'DEALER_RECORD_NOT_FOUND';
      throw missing;
    }
    throw err;
  }
  const raw = fetched && fetched.raw;
  const record = Array.isArray(raw?.data) ? raw.data[0] : (raw?.data && typeof raw.data === 'object' ? raw.data : raw);
  if (!record || typeof record !== 'object') {
    const missing = new Error(`Dealer record ${externalLeadId} no longer exists at the dealer CRM`);
    missing.code = 'DEALER_RECORD_NOT_FOUND';
    throw missing;
  }
}

/**
 * Raises Unhappy 11 for a lead MG believes was delivered but which the
 * dealer CRM no longer has. Marks the mapping so the gap is visible in the
 * application rather than only in a sweep counter, and alerts, because the
 * register is explicit that this failure is invisible to both sides.
 */
async function reportMissingDealerRecord(catalystApp, integration, mapping, results) {
  let leadRow = null;
  try {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
    );
    leadRow = rows[0]?.[LEADS_TABLE] || null;
  } catch (err) {
    logger.error('dealerReconciliationService', `Lead lookup failed for ${mapping.zoho_lead_id}`, err);
  }

  try {
    await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
      ROWID: mapping.ROWID,
      sync_status: 'RECONCILE_MISMATCH',
      last_attempted_at: toCatalystDateTime(),
      last_error: `DEALER_RECORD_NOT_FOUND:${mapping.external_crm_lead_id}`,
    });
  } catch (err) {
    logger.error('dealerReconciliationService', `Could not flag mapping ROWID=${mapping.ROWID}`, err);
  }

  try {
    await crmIntegrationService.recordScenario(catalystApp, {
      scenarioCode: 'Unhappy 11',
      dealerCode: integration.dealer_code,
      leadRow: leadRow || { crm_record_id: mapping.zoho_lead_id, dealer_code: integration.dealer_code },
      direction: 'ZOHO_TO_EXTERNAL_CRM',
      operation: 'RECONCILE',
      status: 'FAILED',
      errorCode: 'DEALER_RECORD_NOT_FOUND',
      externalLeadId: mapping.external_crm_lead_id,
      notify: true,
      reason:
        `MG holds dealer record ${mapping.external_crm_lead_id} but the dealer CRM no longer has it ` +
        '(created then deleted). Re-delivering with the idempotency key; if that fails it stays flagged. ' +
        `Owner: ${RECONCILE_OWNER}.`,
      integrationId: integration.ROWID,
    });
  } catch (err) {
    logger.error('dealerReconciliationService', `Could not record Unhappy 11 for ${mapping.zoho_lead_id}`, err);
  }

  // Re-deliver only an enquiry that had actually been delivered (the
  // transaction MG believes succeeded). A record that was already on hold
  // (consent, validation, mapping) stays flagged exactly as before.
  const wasDelivered = ['SYNCED', 'SLA_BREACH', 'RECONCILE_MISMATCH'].includes(mapping.sync_status);
  if (!leadRow || !wasDelivered || leadRow.dealer_code !== integration.dealer_code) {
    results.unresolved += 1;
    return;
  }

  // Drop the dead dealer reference so the re-send CREATES a new record
  // instead of updating one that no longer exists, and clear the echo
  // fingerprint so the create is not suppressed as a repeat of the last
  // state. The mapping keeps RECONCILE_MISMATCH until delivery succeeds.
  try {
    await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
      ROWID: mapping.ROWID,
      external_crm_lead_id: '',
      last_sync_source_hash: '',
    });
  } catch (err) {
    logger.error('dealerReconciliationService', `Could not clear dead dealer reference on ${mapping.ROWID}`, err);
    results.unresolved += 1;
    return;
  }

  await resendForReconciliation(catalystApp, integration, leadRow, results, 'created then deleted');
}

module.exports = { runDealerReconciliation };
