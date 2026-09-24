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

// Optional dealer scope (comma-separated dealer codes). Unset = every
// dealer, which is the production behaviour. Used so a shortened test SLA
// only touches the dealer under test.
const SLA_DEALER_CODES = String(process.env.DEALER_ACTION_SLA_DEALERS || '')
  .split(',')
  .map((code) => code.trim())
  .filter(Boolean);

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
}

function isIntegrationHealthy(integration) {
  const status = pathPolicy.normalizeStatus(integration?.status);
  return integration && !['error', 'disabled', 'not configured', 'configuring'].includes(status);
}

async function runSlaSweep(catalystApp, now = new Date()) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE sync_status = 'SYNCED'${
      SLA_DEALER_CODES.length
        ? ` AND dealer_code IN (${SLA_DEALER_CODES.map((code) => `'${safeQuoteForZcql(code)}'`).join(', ')})`
        : ''
    } ORDER BY last_synced_at ASC LIMIT 0, ${MAX_CANDIDATES}`
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
        // Rotate on last_synced_at only (this sweep's ordering key).
        // last_attempted_at is reconciliation's rotation key; touching it
        // here every run kept actioned leads permanently at the back of
        // reconciliation's queue, so a deleted dealer record on them was
        // never checked (Unhappy 11 never raised).
        await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
          ROWID: mapping.ROWID,
          last_synced_at: toCatalystDateTime(now),
        });
        results.skippedUnhealthy += 1;
        continue;
      }
      if (!leadRow || !pathPolicy.isWaitingForDealerActionStatus(leadRow.lead_status)) {
        // Rotate already-actioned rows out of the oldest-first candidate
        // window (on last_synced_at only — see the note above).
        await catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
          ROWID: mapping.ROWID,
          last_synced_at: toCatalystDateTime(now),
        });
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
        // The register's evidence list for Unhappy 10: acknowledged time,
        // SLA age, integration-health result and the status left unactioned.
        reason:
          `No dealer action within the ${SLA_MINUTES}-minute SLA. ` +
          `Acknowledged by dealer ${acknowledgedAt.toISOString()}; ` +
          `SLA age ${Math.round((now.getTime() - acknowledgedAt.getTime()) / 60000)} min; ` +
          `integration health: ${integration.status || 'ACTIVE'} (no delivery error); ` +
          `MG status was "${leadRow.lead_status}", now "Unattended Alert".`,
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
