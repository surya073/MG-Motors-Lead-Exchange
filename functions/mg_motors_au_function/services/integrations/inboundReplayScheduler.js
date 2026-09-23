'use strict';

const logger = require('../../utils/logger');
const crmIntegrationService = require('./crmIntegrationService');

const INTEGRATION_LOGS_TABLE = 'integration_logs';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const STATUS_MAPPINGS_TABLE = 'integration_status_mappings';
const MAX_ROWS_TO_SCAN = 200;
const MAX_REPLAYS_PER_SWEEP = 20;

// Unhappy 7 retention: how long an out-of-order dealer update may wait for
// its MG enquiry before it is expired with a final alert. Default 24h;
// UNHAPPY_7_RETENTION_MINUTES shortens it for testing.
const DEFAULT_UNHAPPY_7_RETENTION_MINUTES = 24 * 60;
const configuredRetention = Number(process.env.UNHAPPY_7_RETENTION_MINUTES);
const UNHAPPY_7_RETENTION_MINUTES = Number.isFinite(configuredRetention) && configuredRetention > 0
  ? configuredRetention
  : DEFAULT_UNHAPPY_7_RETENTION_MINUTES;

// Catalyst system columns are written in the project timezone
// (Asia/Kolkata for this project — Console > Settings > General).
const PROJECT_UTC_OFFSET = '+05:30';

function parseSystemTimestamp(value) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?::(\d{1,3}))?$/.exec(String(value || '').trim());
  if (!match) return null;
  const ms = (match[3] || '0').padStart(3, '0');
  const parsed = new Date(`${match[1]}T${match[2]}.${ms}${PROJECT_UTC_OFFSET}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isOutOfOrderHold(logRow) {
  return logRow.happy_unhappy_path_name === 'Unhappy 7';
}

/**
 * Register Unhappy 7 step 4: a held out-of-order update must not sit
 * indefinitely. Closes every held row for the dealer record as EXPIRED
 * (no longer FAILED, so it leaves the replay queue) and records one final
 * Unhappy 7 entry that alerts, naming the pending event, the missing
 * prerequisite and how long it waited.
 */
async function expireOutOfOrderHold(catalystApp, integration, externalLeadId, logRows, waitedMinutes, prerequisite) {
  for (const logRow of logRows) {
    await catalystApp.datastore().table(INTEGRATION_LOGS_TABLE).updateRow({
      ROWID: logRow.ROWID,
      status: 'EXPIRED',
    });
  }
  await crmIntegrationService.recordScenario(catalystApp, {
    scenarioCode: 'Unhappy 7',
    integrationId: integration.ROWID,
    dealerCode: integration.dealer_code,
    direction: 'EXTERNAL_CRM_TO_ZOHO',
    operation: 'UPDATE_LEAD',
    status: 'EXPIRED',
    errorCode: 'OUT_OF_ORDER_EXPIRED',
    externalLeadId,
    reason:
      `Dealer update for record ${externalLeadId} expired after waiting ${waitedMinutes} min ` +
      `(retention ${UNHAPPY_7_RETENTION_MINUTES} min, ${logRows.length} held event(s)); ` +
      `missing prerequisite: ${prerequisite}. Not applied to MG.`,
    notify: true,
  });
}

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
}

function isMappingFailure(logRow) {
  return String(logRow.error_message || '').startsWith('STATUS_MAPPING_NOT_FOUND');
}

// Catalyst system timestamps ("YYYY-MM-DD HH:MM:SS:mmm", project timezone)
// order correctly as plain strings.
function latest(values) {
  return values.filter(Boolean).sort().pop() || '';
}

/**
 * Replays held inbound (dealer -> MG) updates: Unhappy 4, Unhappy 7 and
 * held Unhappy 9. The FAILED audit row is the durable queue reference
 * (integration + dealer record id); the source record is re-fetched from
 * the dealer so PII is not copied into a second raw-payload store, and
 * whatever the dealer holds NOW is what gets applied.
 *
 * Unhappy 4 per the register:
 *   - transport and validation failures are retried on every sweep;
 *   - mapping failures (an unmapped dealer status) are held until MG
 *     approves a mapping, so they are only re-tried once this dealer's
 *     status map has changed since the hold — or once the lead has synced
 *     successfully since (the dealer moved on to a mapped status);
 *   - a lead is replayed ONCE per sweep however many failed rows it has,
 *     and a success closes every one of them (RECOVERED), so the update is
 *     applied to MG exactly once;
 *   - a replay that is still failing is silent (no new log, no new alert);
 *     the original Unhappy 4 stays the single open record.
 */
async function runInboundReplaySweep(catalystApp) {
  const queuedRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${INTEGRATION_LOGS_TABLE} WHERE happy_unhappy_path_name IN ('Unhappy 4', 'Unhappy 7', 'Unhappy 9') AND status = 'FAILED' ORDER BY CREATEDTIME ASC LIMIT 0, ${MAX_ROWS_TO_SCAN}`
  );
  const results = {
    queued: queuedRows.length,
    leads: 0,
    attempted: 0,
    recovered: 0,
    closedRows: 0,
    stillWaiting: 0,
    awaitingMapping: 0,
    expired: 0,
    failed: 0,
  };

  // One group per dealer record, oldest first.
  const groups = new Map();
  for (const wrapped of queuedRows) {
    const logRow = wrapped[INTEGRATION_LOGS_TABLE];
    if (!logRow.integration_id || !logRow.external_lead_id) {
      results.stillWaiting += 1;
      continue;
    }
    const key = `${logRow.integration_id}:${logRow.external_lead_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(logRow);
  }
  results.leads = groups.size;

  const integrationCache = new Map();
  const statusMapChangedAt = new Map();

  async function getIntegration(integrationId) {
    if (!integrationCache.has(integrationId)) {
      const rows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE ROWID = ${integrationId} LIMIT 1`
      );
      integrationCache.set(integrationId, rows.length ? rows[0][DEALER_INTEGRATIONS_TABLE] : null);
    }
    return integrationCache.get(integrationId);
  }

  async function getStatusMapChangedAt(integrationId) {
    if (!statusMapChangedAt.has(integrationId)) {
      const rows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT MODIFIEDTIME FROM ${STATUS_MAPPINGS_TABLE} WHERE integration_id = ${integrationId} ORDER BY MODIFIEDTIME DESC LIMIT 1`
      );
      statusMapChangedAt.set(integrationId, rows.length ? rows[0][STATUS_MAPPINGS_TABLE].MODIFIEDTIME : '');
    }
    return statusMapChangedAt.get(integrationId);
  }

  for (const logRows of groups.values()) {
    if (results.attempted >= MAX_REPLAYS_PER_SWEEP) break;
    const { integration_id: integrationId, external_lead_id: externalLeadId } = logRows[0];

    // Unhappy 7 expiry applies only when EVERY held row for this dealer
    // record is an out-of-order hold; rows are oldest first, so logRows[0]
    // is when the wait began.
    const heldSinceAt = parseSystemTimestamp(logRows[0].CREATEDTIME);
    const waitedMinutes = heldSinceAt ? Math.floor((Date.now() - heldSinceAt.getTime()) / 60000) : 0;
    const retentionExceeded = logRows.every(isOutOfOrderHold)
      && Boolean(heldSinceAt)
      && waitedMinutes >= UNHAPPY_7_RETENTION_MINUTES;

    try {
      const mappingRows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT ROWID, last_error, MODIFIEDTIME FROM ${LEAD_INTEGRATIONS_TABLE} WHERE integration_id = ${integrationId} AND external_crm_lead_id = '${safeQuoteForZcql(externalLeadId)}' LIMIT 1`
      );
      if (mappingRows.length === 0) {
        const integrationForExpiry = retentionExceeded ? await getIntegration(integrationId) : null;
        if (integrationForExpiry) {
          await expireOutOfOrderHold(
            catalystApp, integrationForExpiry, externalLeadId, logRows, waitedMinutes,
            'no MG enquiry was ever linked to this dealer record'
          );
          results.expired += 1;
        } else {
          results.stillWaiting += 1;
        }
        continue;
      }
      const leadMapping = mappingRows[0][LEAD_INTEGRATIONS_TABLE];

      const integration = await getIntegration(integrationId);
      if (!integration) {
        results.stillWaiting += 1;
        continue;
      }

      if (logRows.every(isMappingFailure)) {
        const heldSince = latest(logRows.map((row) => row.CREATEDTIME));
        const mapChanged = (await getStatusMapChangedAt(integrationId)) > heldSince;
        const resolvedSince = !String(leadMapping.last_error || '').startsWith('UNMAPPED_STATUS')
          && String(leadMapping.MODIFIEDTIME || '') > heldSince;
        if (!mapChanged && !resolvedSince) {
          results.awaitingMapping += 1;
          continue;
        }
      }

      results.attempted += 1;
      const replay = await crmIntegrationService.replayInboundLead(
        catalystApp,
        integration,
        externalLeadId,
        undefined,
        { replay: true }
      );

      if (replay?.held) {
        results.stillWaiting += 1;
        continue;
      }

      for (const logRow of logRows) {
        await catalystApp.datastore().table(INTEGRATION_LOGS_TABLE).updateRow({
          ROWID: logRow.ROWID,
          status: 'RECOVERED',
        });
        results.closedRows += 1;
      }
      results.recovered += 1;
    } catch (err) {
      // A linked record whose MG lead mirror never became available is the
      // other Unhappy 7 shape; past retention it expires the same way.
      if (retentionExceeded) {
        try {
          const integrationForExpiry = await getIntegration(integrationId);
          if (integrationForExpiry) {
            await expireOutOfOrderHold(
              catalystApp, integrationForExpiry, externalLeadId, logRows, waitedMinutes,
              'the MG enquiry record was not available in Lead Exchange'
            );
            results.expired += 1;
            continue;
          }
        } catch (expiryErr) {
          logger.error('inboundReplayScheduler', `Failed to expire held record ${externalLeadId}`, expiryErr);
        }
      }
      // Still failing (e.g. MG CRM unreachable). The replay was silent, so
      // the original FAILED rows stay open and are retried next sweep.
      results.failed += 1;
      logger.error(
        'inboundReplayScheduler',
        `Replay failed for dealer record ${externalLeadId} (integration ${integrationId})`,
        err
      );
    }
  }

  logger.info('inboundReplayScheduler', `Sweep complete: ${JSON.stringify(results)}`);
  return results;
}

module.exports = { runInboundReplaySweep };
