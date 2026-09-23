'use strict';

const logger = require('../../utils/logger');
const crmIntegrationService = require('./crmIntegrationService');

const INTEGRATION_LOGS_TABLE = 'integration_logs';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const MAX_REPLAYS_PER_SWEEP = 50;

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Replays Unhappy 7, recoverable Unhappy 4, and held Unhappy 9 events after their lead
 * mapping exists. The failed
 * audit row is the durable queue reference (integration + external record id),
 * while the source record is re-fetched from the dealer so PII is not copied
 * into a second raw-payload store.
 */
async function runInboundReplaySweep(catalystApp) {
  const queuedRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${INTEGRATION_LOGS_TABLE} WHERE happy_unhappy_path_name IN ('Unhappy 4', 'Unhappy 7', 'Unhappy 9') AND status = 'FAILED' ORDER BY CREATEDTIME ASC LIMIT 0, ${MAX_REPLAYS_PER_SWEEP}`
  );
  const results = {
    queued: queuedRows.length,
    attempted: 0,
    recovered: 0,
    stillWaiting: 0,
    failed: 0,
  };

  for (const wrapped of queuedRows) {
    const logRow = wrapped[INTEGRATION_LOGS_TABLE];
    if (!logRow.integration_id || !logRow.external_lead_id) {
      results.stillWaiting += 1;
      continue;
    }

    try {
      const mappingRows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT ROWID FROM ${LEAD_INTEGRATIONS_TABLE} WHERE integration_id = ${logRow.integration_id} AND external_crm_lead_id = '${safeQuoteForZcql(logRow.external_lead_id)}' LIMIT 1`
      );
      if (mappingRows.length === 0) {
        results.stillWaiting += 1;
        continue;
      }

      const integrationRows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE ROWID = ${logRow.integration_id} LIMIT 1`
      );
      if (integrationRows.length === 0) {
        results.stillWaiting += 1;
        continue;
      }

      results.attempted += 1;
      const integration = integrationRows[0][DEALER_INTEGRATIONS_TABLE];
      const replay = await crmIntegrationService.replayInboundLead(
        catalystApp,
        integration,
        logRow.external_lead_id
      );

      if (replay?.held) {
        results.stillWaiting += 1;
        continue;
      }

      await catalystApp.datastore().table(INTEGRATION_LOGS_TABLE).updateRow({
        ROWID: logRow.ROWID,
        status: 'RECOVERED',
      });
      results.recovered += 1;
    } catch (err) {
      results.failed += 1;
      logger.error(
        'inboundReplayScheduler',
        `Replay failed for integration_logs ROWID=${logRow.ROWID}`,
        err
      );
    }
  }

  logger.info('inboundReplayScheduler', `Sweep complete: ${JSON.stringify(results)}`);
  return results;
}

module.exports = { runInboundReplaySweep };
