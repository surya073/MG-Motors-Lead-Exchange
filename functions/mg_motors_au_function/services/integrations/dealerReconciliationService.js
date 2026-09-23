'use strict';

const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const crmIntegrationService = require('./crmIntegrationService');

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

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
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
async function runDealerReconciliation(catalystApp) {
  const mappingRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} ORDER BY last_attempted_at ASC LIMIT 0, ${MAX_RECORDS_PER_SWEEP}`
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
        await reportMissingDealerRecord(catalystApp, integration, mapping);
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

  logger.info('dealerReconciliationService', `Sweep complete: ${JSON.stringify(results)}`);
  return results;
}

/**
 * Raises Unhappy 11 for a lead MG believes was delivered but which the
 * dealer CRM no longer has. Marks the mapping so the gap is visible in the
 * application rather than only in a sweep counter, and alerts, because the
 * register is explicit that this failure is invisible to both sides.
 */
async function reportMissingDealerRecord(catalystApp, integration, mapping) {
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
        '(created then deleted). Verify at the dealer before re-sending so reconciliation does not duplicate.',
    });
  } catch (err) {
    logger.error('dealerReconciliationService', `Could not record Unhappy 11 for ${mapping.zoho_lead_id}`, err);
  }
}

module.exports = { runDealerReconciliation };
