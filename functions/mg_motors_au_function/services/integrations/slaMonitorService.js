'use strict';

const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const oemCrmService = require('../zohoCrmService');
const crmIntegrationService = require('./crmIntegrationService');
const pathPolicy = require('./pathPolicyService');

const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const LEADS_TABLE = 'leads';
const MAX_CANDIDATES = 200;
const DEFAULT_SLA_MINUTES = 24 * 60;
const configuredSlaMinutes = Number(process.env.DEALER_ACTION_SLA_MINUTES);
const SLA_MINUTES = Number.isFinite(configuredSlaMinutes) && configuredSlaMinutes > 0
  ? configuredSlaMinutes
  : DEFAULT_SLA_MINUTES;
const SLA_MS = SLA_MINUTES * 60 * 1000;
const WAITING_STATUSES = new Set(['update pending', 'not contacted', 'received', 'acknowledged']);

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
}

function isIntegrationHealthy(integration) {
  const status = pathPolicy.normalizeStatus(integration?.status);
  return integration && !['error', 'disabled', 'not configured', 'configuring'].includes(status);
}

async function runSlaSweep(catalystApp, now = new Date()) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE sync_status = 'SYNCED' ORDER BY last_synced_at ASC LIMIT 0, ${MAX_CANDIDATES}`
  );
  const results = {
    candidates: rows.length,
    checked: 0,
    breached: 0,
    skippedNotDue: 0,
    skippedActioned: 0,
    skippedUnhealthy: 0,
    failed: 0,
  };

  for (const wrapped of rows) {
    const mapping = wrapped[LEAD_INTEGRATIONS_TABLE];
    const acknowledgedAt = pathPolicy.parseTimestamp(mapping.last_synced_at);
    if (!acknowledgedAt || now.getTime() - acknowledgedAt.getTime() < SLA_MS) {
      results.skippedNotDue += 1;
      continue;
    }

    try {
      const [integrationRows, leadRows] = await Promise.all([
        catalystApp.zcql().executeZCQLQuery(
          `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE ROWID = ${mapping.integration_id} LIMIT 1`
        ),
        catalystApp.zcql().executeZCQLQuery(
          `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
        ),
      ]);
      const integration = integrationRows[0]?.[DEALER_INTEGRATIONS_TABLE];
      const leadRow = leadRows[0]?.[LEADS_TABLE];
      if (!isIntegrationHealthy(integration)) {
        results.skippedUnhealthy += 1;
        continue;
      }
      if (!leadRow || !WAITING_STATUSES.has(pathPolicy.normalizeStatus(leadRow.lead_status))) {
        results.skippedActioned += 1;
        continue;
      }

      results.checked += 1;
      await oemCrmService.updateOemLead(mapping.zoho_lead_id, {
        Lead_Status: 'Unattended Alert',
      });
      await catalystApp.datastore().table(LEADS_TABLE).updateRow({
        ROWID: leadRow.ROWID,
        lead_status: 'Unattended Alert',
        sync_status: 'SLA_BREACH',
        last_synced_at: toCatalystDateTime(now),
      });
      await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
        ROWID: mapping.ROWID,
        sync_status: 'SLA_BREACH',
        last_attempted_at: toCatalystDateTime(now),
        last_error: 'DEALER_ACTION_SLA_BREACH',
      });
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode: 'Unhappy 10',
        dealerCode: mapping.dealer_code,
        leadRow,
        operation: 'SLA_CHECK',
        errorCode: 'DEALER_ACTION_SLA_BREACH',
        reason: `No dealer action was received within ${SLA_MINUTES} minutes while the integration remained healthy.`,
        notify: true,
      });
      results.breached += 1;
    } catch (err) {
      results.failed += 1;
      logger.error('slaMonitorService', `SLA check failed for mapping ${mapping.ROWID}`, err);
    }
  }

  logger.info('slaMonitorService', `Sweep complete: ${JSON.stringify(results)}`);
  return results;
}

module.exports = { runSlaSweep, SLA_MINUTES, _test: { isIntegrationHealthy } };
