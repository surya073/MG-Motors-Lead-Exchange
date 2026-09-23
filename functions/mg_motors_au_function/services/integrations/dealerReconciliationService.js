'use strict';

const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const crmIntegrationService = require('./crmIntegrationService');

const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const MAX_RECORDS_PER_SWEEP = 200;

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
  };

  for (const wrapped of mappingRows) {
    const mapping = wrapped[LEAD_INTEGRATIONS_TABLE];
    if (!mapping.integration_id || !mapping.external_crm_lead_id) {
      results.skipped += 1;
      continue;
    }

    try {
      let integration = integrations.get(String(mapping.integration_id));
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

module.exports = { runDealerReconciliation };
