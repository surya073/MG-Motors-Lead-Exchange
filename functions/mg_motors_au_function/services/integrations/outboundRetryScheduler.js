'use strict';

const logger = require('../../utils/logger');
const crmIntegrationService = require('./crmIntegrationService');
const pathPolicy = require('./pathPolicyService');

const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const LEADS_TABLE = 'leads';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';

// Upper bound on how many failing leads one sweep run processes, so a
// single invocation can't run indefinitely if a lot of leads are stuck
// failing at once. Leads beyond this limit just get picked up on the
// next sweep.
const MAX_LEADS_PER_SWEEP = 50;
const MAX_CANDIDATES_TO_SCAN = 200;

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * outboundRetryScheduler.js
 * -----------------------------------------------------------------------
 * This is the piece that was missing: lead_integrations already had
 * retry_count / next_retry_at / last_attempted_at / last_error /
 * failure_streak_started_at columns, but nothing in the codebase ever
 * read or wrote them, so a lead that failed to push out to a dealer's
 * CRM just sat there — it only got retried if an admin manually clicked
 * Retry, or incidentally if the source CRM record changed again later.
 *
 * runOutboundRetrySweep() finds every lead_integrations row currently
 * FAILED or FAILED_CRITICAL whose next_retry_at has passed (or was
 * never set), and re-runs crmIntegrationService.syncLeadToExternalCrm
 * for it — the exact same call a manual Retry click makes, so it goes
 * through the same Unhappy 1 → Unhappy 3 classification, updates the
 * same retry bookkeeping columns, and resets everything on success.
 * All bookkeeping is handled inside syncLeadToExternalCrm itself —
 * this function's only job is finding what's due and calling it.
 *
 * Intended to run on a schedule (Catalyst Job Scheduler / Cron Job) —
 * see the /system/retry-outbound-syncs route this is wired to.
 */
/**
 * @param {object} [options]
 * @param {boolean} [options.ignoreSchedule=false] Attempt every failing lead
 *   now, rather than only those whose next_retry_at has elapsed.
 *
 *   next_retry_at paces the ordinary sweep so a permanently broken dealer is
 *   not hammered. A fast recovery pass wants the opposite: the moment a
 *   dealer's connection is restored, the leads that failed during the outage
 *   should go out, not sit until their individual back-off expires. Default
 *   is false, so existing callers behave exactly as before.
 */
async function runOutboundRetrySweep(catalystApp, options) {
  const ignoreSchedule = Boolean(options && options.ignoreSchedule);
  const now = new Date();

  const dueRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} WHERE sync_status IN ('FAILED', 'FAILED_CRITICAL') ORDER BY next_retry_at ASC LIMIT 0, ${MAX_CANDIDATES_TO_SCAN}`
  );

  // `recovered` counts ONLY leads that actually reached the dealer CRM.
  // syncLeadToExternalCrm RETURNS {skipped:true, reason} for a validation
  // failure, a consent hold or a suppressed echo rather than throwing, so
  // counting every non-throwing call as a success reported held leads as
  // recovered — e.g. a sweep reporting "succeeded: 4" while those same 4
  // leads were logging Unhappy 2. The register requires MG to see leads
  // delivered on recovery and leads still failing as distinct numbers
  // (Happy 4), so they are counted separately here.
  const results = {
    totalCandidates: dueRows.length,
    attempted: 0,
    recovered: 0,
    heldByPolicy: 0,
    stillFailing: 0,
    skippedNotDue: 0,
    skippedNoIntegrationOrLead: 0,
    errored: 0,
    heldReasons: {},
  };

  const dueNow = dueRows
    .map((row) => row[LEAD_INTEGRATIONS_TABLE])
    .filter((mapping) => {
      if (ignoreSchedule) return true;
      const dueAt = pathPolicy.parseTimestamp(mapping.next_retry_at);
      const isDue = !dueAt || dueAt.getTime() <= now.getTime();
      if (!isDue) results.skippedNotDue += 1;
      return isDue;
    })
    .sort((left, right) => {
      const leftAt = pathPolicy.parseTimestamp(left.next_retry_at)?.getTime() || 0;
      const rightAt = pathPolicy.parseTimestamp(right.next_retry_at)?.getTime() || 0;
      return leftAt - rightAt;
    })
    .slice(0, MAX_LEADS_PER_SWEEP);

  for (const mapping of dueNow) {

    try {
      const integrationRows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE ROWID = ${mapping.integration_id} LIMIT 1`
      );
      const integration = integrationRows.length > 0 ? integrationRows[0][DEALER_INTEGRATIONS_TABLE] : null;

      const leadRows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
      );
      const leadRow = leadRows.length > 0 ? leadRows[0][LEADS_TABLE] : null;

      if (!integration || !leadRow) {
        // Dangling mapping row (integration removed, or lead soft-deleted
        // upstream) — nothing sensible to retry. Leave it as-is rather
        // than guessing; surfaces in results for visibility.
        results.skippedNoIntegrationOrLead += 1;
        continue;
      }

      results.attempted += 1;

      try {
        const outcome = await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
        if (outcome && outcome.ok) {
          // Genuinely delivered to the dealer CRM — this is the Happy 4
          // recovery the register asks MG to be able to count.
          results.recovered += 1;
        } else {
          // Returned without delivering: validation hold, consent hold,
          // suppressed echo, outbound disabled. Not a failure, but
          // emphatically not a recovery either.
          const reason = (outcome && outcome.reason) || 'UNKNOWN';
          results.heldByPolicy += 1;
          results.heldReasons[reason] = (results.heldReasons[reason] || 0) + 1;
        }
      } catch (syncErr) {
        // syncLeadToExternalCrm already logged this (Unhappy 1/3
        // classification, retry bookkeeping) internally — nothing more
        // to do here except count it and move to the next candidate.
        results.stillFailing += 1;
      }
    } catch (rowErr) {
      results.errored += 1;
      logger.error('outboundRetryScheduler', `Sweep errored on lead_integrations ROWID=${mapping.ROWID}`, rowErr);
    }
  }

  if (options && options.includeRoutingHolds) {
    results.routingHolds = await reprocessRoutingHolds(catalystApp);
  }

  logger.info('outboundRetryScheduler', `Sweep complete: ${JSON.stringify(results)}`);
  return results;
}

const MAX_ROUTING_HOLDS_PER_SWEEP = 20;
const UNROUTABLE_INTEGRATION_STATUSES = ['NOT_CONFIGURED', 'CONFIGURING', 'DISABLED'];

/**
 * Unhappy 5 is "held as a routing exception until the mapping is corrected,
 * then reprocessed" — but a ROUTING_HOLD lead has no FAILED mapping row, so
 * the retry sweep above never sees it and it stayed held forever.
 *
 * A held lead is re-sent only when its dealer integration is routable again
 * AND was modified after the lead was held (i.e. someone changed the dealer
 * setup since). Catalyst system timestamps ("YYYY-MM-DD HH:MM:SS:mmm", both
 * in the project timezone) compare correctly as strings. The re-send goes
 * through syncLeadToExternalCrm, so every check runs again: a lead whose
 * problem is not actually fixed is simply re-held, which bumps its
 * MODIFIEDTIME so it is not retried again until the dealer changes again.
 * A fixed lead is delivered as Happy 1 — never Happy 4, since nothing
 * failed.
 */
async function reprocessRoutingHolds(catalystApp) {
  const summary = { candidates: 0, attempted: 0, delivered: 0, stillHeld: 0, errored: 0 };
  const heldRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${LEADS_TABLE} WHERE sync_status = 'ROUTING_HOLD' ORDER BY MODIFIEDTIME ASC LIMIT 0, ${MAX_ROUTING_HOLDS_PER_SWEEP}`
  );
  summary.candidates = heldRows.length;
  const integrationsByDealer = new Map();

  for (const row of heldRows) {
    const leadRow = row[LEADS_TABLE];
    if (!leadRow.dealer_code || !leadRow.crm_record_id) continue;
    try {
      if (!integrationsByDealer.has(leadRow.dealer_code)) {
        integrationsByDealer.set(
          leadRow.dealer_code,
          await crmIntegrationService.getIntegrationByDealerCode(catalystApp, leadRow.dealer_code)
        );
      }
      const integration = integrationsByDealer.get(leadRow.dealer_code);
      const isRoutable = integration
        && integration.integration_type === 'EXTERNAL_CRM'
        && !UNROUTABLE_INTEGRATION_STATUSES.includes(integration.status);
      const changedSinceHeld = integration
        && String(integration.MODIFIEDTIME || '') > String(leadRow.MODIFIEDTIME || '');
      if (!isRoutable || !changedSinceHeld) continue;

      summary.attempted += 1;
      const outcome = await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
      if (outcome && outcome.ok) summary.delivered += 1;
      else summary.stillHeld += 1;
    } catch (err) {
      // syncLeadToExternalCrm already logged the Unhappy classification.
      summary.errored += 1;
    }
  }
  return summary;
}

module.exports = { runOutboundRetrySweep };
