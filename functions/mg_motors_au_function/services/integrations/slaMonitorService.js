'use strict';

const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const oemCrmService = require('../zohoCrmService');
const crmIntegrationService = require('./crmIntegrationService');
const pathPolicy = require('./pathPolicyService');
const { guardSweep } = require('./sweepOverlapGuard');
const { tailWindow, countFrom } = require('./sweepWindow');
const outboundSyncClaimService = require('./outboundSyncClaimService');

const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const LEADS_TABLE = 'leads';
const MAX_CANDIDATES = 200;
// One sweep examines at most MAX_CANDIDATES overdue mappings: the oldest
// HEAD_SIZE always, plus a TAIL_SIZE slice that rotates through the rest (see
// sweepWindow.js) so rows stuck at the front can never starve the others.
const HEAD_SIZE = MAX_CANDIDATES / 2;
const TAIL_SIZE = MAX_CANDIDATES - HEAD_SIZE;

// Catalyst documents a 30-second limit for Advanced I/O functions. A breach is
// not cheap — an OEM CRM write (~0.3-0.8 s measured), two row writes and the
// Unhappy 10 record with its notifications — so 200 overdue rows handled one at
// a time can run for minutes. The sweep therefore stops STARTING new work once
// its time budget is spent (default 20 s, leaving headroom under the limit) and
// runs a few mappings at a time. Overdue rows it did not reach stay overdue and
// are taken first (oldest first) by the next sweep, so nothing is lost or
// reordered; each one is still handled exactly once.
const DEFAULT_TIME_BUDGET_MS = 20000;
const configuredBudget = Number(process.env.SLA_SWEEP_TIME_BUDGET_MS);
const SLA_TIME_BUDGET_MS = Number.isFinite(configuredBudget) && configuredBudget >= 1000
  ? configuredBudget
  : DEFAULT_TIME_BUDGET_MS;

const DEFAULT_CONCURRENCY = 3;
const configuredConcurrency = Number(process.env.SLA_SWEEP_CONCURRENCY);
const SLA_CONCURRENCY = Number.isFinite(configuredConcurrency) && configuredConcurrency >= 1
  ? Math.min(Math.floor(configuredConcurrency), 6)
  : DEFAULT_CONCURRENCY;
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

/**
 * The overdue mappings to examine this sweep.
 *
 * Only mappings whose dealer acknowledgement is OLDER than the SLA are read, in
 * the database: the old query read the oldest 200 SYNCED mappings of any age
 * and discarded the not-yet-due ones in JavaScript, and a mapping with no
 * last_synced_at (which sorts first) could never be rotated out of that window.
 * Within the overdue set the oldest HEAD_SIZE are always taken, then a rotating
 * TAIL_SIZE slice — so mappings that throw or otherwise cannot be processed
 * cannot occupy the whole window and starve those behind them. No row is
 * rewritten to achieve this: `last_synced_at` is the dealer-acknowledgement
 * time quoted as evidence in the Unhappy 10 record and must not be disturbed.
 */
async function selectOverdueMappings(catalystApp, now) {
  const cutoff = toCatalystDateTime(new Date(now.getTime() - SLA_MS));
  const where =
    `WHERE sync_status = 'SYNCED' AND last_synced_at IS NOT NULL AND last_synced_at < '${cutoff}'${
      SLA_DEALER_CODES.length
        ? ` AND dealer_code IN (${SLA_DEALER_CODES.map((code) => `'${safeQuoteForZcql(code)}'`).join(', ')})`
        : ''
    }`;
  const ordered = `${where} ORDER BY last_synced_at ASC, ROWID ASC`;
  // ZCQL's LIMIT offset is effectively 1-based; offset + 1 is a true 0-based offset.
  const slice = (offset, size) =>
    catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} ${ordered} LIMIT ${offset + 1}, ${size}`
    );

  const head = await slice(0, HEAD_SIZE);
  if (head.length < HEAD_SIZE) return { rows: head, overdue: head.length };

  const total = countFrom(
    await catalystApp.zcql().executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${LEAD_INTEGRATIONS_TABLE} ${where}`),
    LEAD_INTEGRATIONS_TABLE
  );
  const tail = tailWindow({ total, headSize: HEAD_SIZE, tailSize: TAIL_SIZE, now: now.getTime() });
  if (!tail) return { rows: head, overdue: Math.max(total, head.length) };

  const tailRows = await slice(tail.offset, TAIL_SIZE);
  const seen = new Set(head.map((r) => r[LEAD_INTEGRATIONS_TABLE].ROWID));
  return {
    rows: [...head, ...tailRows.filter((r) => !seen.has(r[LEAD_INTEGRATIONS_TABLE].ROWID))],
    overdue: total,
  };
}

/**
 * @param {object} catalystApp
 * @param {Date}   [now]      the moment SLA age is measured against (tests inject it)
 * @param {object} [options]
 * @param {number} [options.deadline]      epoch ms after which no new mapping is started
 *   (a caller that shares one HTTP request with other work passes its own);
 * @param {number} [options.timeBudgetMs]  budget from now when no deadline is given
 * @param {() => number} [options.clock]   time source (tests inject it)
 */
async function runSlaSweepInternal(catalystApp, now = new Date(), options = {}) {
  const clock = options.clock || Date.now;
  const startedAt = clock();
  const deadline = options.deadline ?? (startedAt + (options.timeBudgetMs ?? SLA_TIME_BUDGET_MS));

  const { rows, overdue } = await selectOverdueMappings(catalystApp, now);
  const results = {
    candidates: rows.length,
    overdue,
    checked: 0,
    breached: 0,
    skippedNotDue: 0,
    skippedActioned: 0,
    skippedUnhealthy: 0,
    failed: 0,
    deferred: 0,
    skippedConcurrent: 0,
    skippedAlreadyHandled: 0,
  };

  const rotate = (mapping) =>
    // Rotate on last_synced_at only (this sweep's ordering key).
    // last_attempted_at is reconciliation's rotation key; touching it here every
    // run kept actioned leads permanently at the back of reconciliation's queue,
    // so a deleted dealer record on them was never checked (Unhappy 11 never raised).
    catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE).updateRow({
      ROWID: mapping.ROWID,
      last_synced_at: toCatalystDateTime(now),
    });

  const processOne = async (wrapped) => {
    const mapping = wrapped[LEAD_INTEGRATIONS_TABLE];
    const candidateAck = pathPolicy.parseTimestamp(mapping.last_synced_at);
    if (!candidateAck || now.getTime() - candidateAck.getTime() < SLA_MS) {
      results.skippedNotDue += 1;
      return;
    }

    try {
      // A mapping with no integration to check cannot be judged on dealer
      // action: rotate it out instead of failing on every sweep. (It can never
      // be breached, so no other instance competes for it.)
      if (!mapping.integration_id) {
        await rotate(mapping);
        results.skippedUnhealthy += 1;
        return;
      }

      // EVERY decision below — breach, rotate or skip — is taken under the claim
      // that every outbound sync and inbound dealer update of this
      // (integration, lead) takes, on rows read AFTER acquiring it. Overlapping
      // sweeps on different instances, or a dealer's update arriving at that
      // moment, therefore cannot both act; and a sweep that read its candidates
      // before another finished cannot breach the lead twice or re-stamp the
      // dealer-acknowledgement time of a mapping that was already breached.
      const claimed = await outboundSyncClaimService.withOutboundSyncClaim(
        catalystApp,
        mapping.integration_id,
        mapping.zoho_lead_id,
        'sla-sweep',
        async () => {
          const [mappingRows, integrationRows, leadRows] = await Promise.all([
            catalystApp.zcql().executeZCQLQuery(
              `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE ROWID = ${mapping.ROWID} LIMIT 1`
            ),
            catalystApp.zcql().executeZCQLQuery(
              `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE ROWID = ${mapping.integration_id} LIMIT 1`
            ),
            catalystApp.zcql().executeZCQLQuery(
              `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
            ),
          ]);
          const fresh = mappingRows[0]?.[LEAD_INTEGRATIONS_TABLE];
          const integration = integrationRows[0]?.[DEALER_INTEGRATIONS_TABLE];
          const leadRow = leadRows[0]?.[LEADS_TABLE];

          // Another sweep already breached it (or it left the SYNCED state): hands off.
          if (!fresh || fresh.sync_status !== 'SYNCED') {
            results.skippedAlreadyHandled += 1;
            return;
          }
          // Judge age on the CURRENT acknowledgement time (a concurrent sweep may
          // have rotated the row since the candidate list was read).
          const acknowledgedAt = pathPolicy.parseTimestamp(fresh.last_synced_at);
          if (!acknowledgedAt || now.getTime() - acknowledgedAt.getTime() < SLA_MS) {
            results.skippedAlreadyHandled += 1;
            return;
          }
          if (!isIntegrationHealthy(integration)) {
            await rotate(mapping);
            results.skippedUnhealthy += 1;
            return;
          }
          if (!leadRow || !pathPolicy.isWaitingForDealerActionStatus(leadRow.lead_status)) {
            // Already actioned (by the dealer): rotate out of the oldest-first window.
            await rotate(mapping);
            results.skippedActioned += 1;
            return;
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
        }
      );
      // Someone else holds this lead right now: leave it overdue for the next
      // sweep (nothing is rewritten, so its acknowledgement time is intact).
      if (claimed && claimed.skipped) results.skippedConcurrent += 1;
    } catch (err) {
      results.failed += 1;
      logger.error('slaMonitorService', `SLA check failed for mapping ${mapping.ROWID}`, err);
    }
  };

  // Oldest first, a few at a time, never starting a batch after the deadline.
  // Two mappings of the same lead are never in flight together.
  const pending = [...rows];
  while (pending.length > 0) {
    if (clock() >= deadline) {
      results.deferred = pending.length;
      break;
    }
    const batch = [];
    const leadsInBatch = new Set();
    for (let i = 0; i < pending.length && batch.length < SLA_CONCURRENCY;) {
      const leadId = pending[i][LEAD_INTEGRATIONS_TABLE].zoho_lead_id;
      if (leadsInBatch.has(leadId)) {
        i += 1;
        continue;
      }
      leadsInBatch.add(leadId);
      batch.push(pending.splice(i, 1)[0]);
    }
    await Promise.all(batch.map(processOne));
  }

  results.elapsedMs = clock() - startedAt;
  if (results.deferred > 0) {
    logger.info(
      'slaMonitorService',
      `Time budget reached: ${results.deferred} overdue mapping(s) deferred to the next sweep (oldest first)`
    );
  }
  logger.info('slaMonitorService', `Sweep complete: ${JSON.stringify(results)}`);
  return results;
}

// Guarded against re-entrant overlap on the same warm instance — see
// sweepOverlapGuard.js. Exported name/signature unchanged.
const runSlaSweep = guardSweep('slaSweep', runSlaSweepInternal);

module.exports = {
  runSlaSweep,
  SLA_MINUTES,
  _test: { isIntegrationHealthy, selectOverdueMappings, HEAD_SIZE, TAIL_SIZE, SLA_TIME_BUDGET_MS, SLA_CONCURRENCY },
};
