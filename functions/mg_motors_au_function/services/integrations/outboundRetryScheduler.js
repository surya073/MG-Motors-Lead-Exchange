'use strict';

const logger = require('../../utils/logger');
const crmIntegrationService = require('./crmIntegrationService');
const pathPolicy = require('./pathPolicyService');
const { guardSweep } = require('./sweepOverlapGuard');
const stats = require('../dashboardStatsService');
const { ROTATION_BUCKET_MS, tailWindow, countFrom } = require('./sweepWindow');

const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
const LEADS_TABLE = 'leads';
const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';

// Upper bound on how many failing leads one sweep run processes, so a
// single invocation can't run indefinitely if a lot of leads are stuck
// failing at once. Leads beyond this limit just get picked up on the
// next sweep.
const MAX_LEADS_PER_SWEEP = 50;
// Candidates are read as the oldest HEAD_ROWS failing rows plus a TAIL_ROWS slice
// that rotates over the rest (see sweepWindow.js), so at most this many rows are
// examined per sweep.
const HEAD_ROWS = 100;
const TAIL_ROWS = 100;

// Same proven pattern as dealerReconciliationService.js's
// RECONCILE_CONCURRENCY (identical formula/default/cap): each candidate
// costs one dealer-CRM round trip, and this sweep previously processed
// up to MAX_LEADS_PER_SWEEP of them fully SERIALLY — the one scheduler in
// this codebase with no concurrency bound at all. That file's own comment
// documents measuring 51 records at ~20s and that 200 "exceeds Catalyst's
// applogic execution limit and the whole run is lost"; outbound retry is
// actually more exposed to that same ceiling, since a slow/down dealer
// (exactly what populates this queue) can take up to the adapter's own
// 8-10s timeout per lead, not a healthy dealer's fast round trip. Bounding
// concurrency here — not shrinking MAX_LEADS_PER_SWEEP, which is already
// in the same safe ballpark as reconciliation's proven 40 — closes that
// gap the same way reconciliation already closed it.
const OUTBOUND_RETRY_CONCURRENCY = (() => {
  const configured = Number(process.env.OUTBOUND_RETRY_CONCURRENCY);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(configured, 10) : 6;
})();

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
/**
 * The failing rows to examine this sweep: the HEAD_ROWS oldest by next_retry_at
 * (priority unchanged) plus a TAIL_ROWS slice that rotates over the rest, so a
 * row that is examined but never leaves the set cannot starve the rows behind it.
 * Read-only: nothing is written to make the rotation work.
 */
async function selectRetryCandidates(catalystApp, now = Date.now()) {
  const where = `WHERE sync_status IN ('FAILED', 'FAILED_CRITICAL')`;
  // ZCQL's LIMIT offset is effectively 1-based; offset + 1 is a true 0-based offset.
  const slice = (offset, size) =>
    catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEAD_INTEGRATIONS_TABLE} ${where} ORDER BY next_retry_at ASC, ROWID ASC LIMIT ${offset + 1}, ${size}`
    );

  const head = await slice(0, HEAD_ROWS);
  if (head.length < HEAD_ROWS) return head;

  const total = countFrom(
    await catalystApp.zcql().executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${LEAD_INTEGRATIONS_TABLE} ${where}`),
    LEAD_INTEGRATIONS_TABLE
  );
  const tail = tailWindow({ total, headSize: HEAD_ROWS, tailSize: TAIL_ROWS, now });
  if (!tail) return head;

  const tailRows = await slice(tail.offset, TAIL_ROWS);
  const seen = new Set(head.map((r) => r[LEAD_INTEGRATIONS_TABLE].ROWID));
  return [...head, ...tailRows.filter((r) => !seen.has(r[LEAD_INTEGRATIONS_TABLE].ROWID))];
}

async function runOutboundRetrySweepInternal(catalystApp, options) {
  const ignoreSchedule = Boolean(options && options.ignoreSchedule);
  const now = new Date(Date.now());

  const dueRows = await selectRetryCandidates(catalystApp, now.getTime());

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
    });

  // Unchanged per-lead logic, only extracted into a named function so it
  // can be invoked from bounded concurrent batches below instead of a
  // strictly serial loop. Every existing behavior inside is identical:
  // same integration/lead lookup, same syncLeadToExternalCrm call (so
  // retry_count/backoff/escalation bookkeeping and the outbound claim are
  // entirely untouched — they live inside that function, not here), same
  // result counting, same error handling (one lead's failure/exception
  // never aborts the sweep).
  const integrationCache = new Map();
  const getIntegration = (integrationId) => {
    if (!integrationCache.has(integrationId)) {
      integrationCache.set(
        integrationId,
        catalystApp.zcql().executeZCQLQuery(
          `SELECT * FROM ${DEALER_INTEGRATIONS_TABLE} WHERE ROWID = ${integrationId} LIMIT 1`
        ).then((rows) => (rows.length > 0 ? rows[0][DEALER_INTEGRATIONS_TABLE] : null))
      );
    }
    return integrationCache.get(integrationId);
  };

  const processOne = async (mapping) => {
    try {
      const integration = await getIntegration(mapping.integration_id);

      const leadRows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT * FROM ${LEADS_TABLE} WHERE crm_record_id = '${safeQuoteForZcql(mapping.zoho_lead_id)}' LIMIT 1`
      );
      const leadRow = leadRows.length > 0 ? leadRows[0][LEADS_TABLE] : null;

      if (!integration || !leadRow) {
        // Dangling mapping row (integration removed, or lead soft-deleted
        // upstream) — nothing sensible to retry. Leave it as-is rather
        // than guessing; surfaces in results for visibility.
        results.skippedNoIntegrationOrLead += 1;
        return;
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
  };

  // Bounded concurrency, same chunked-Promise.all shape
  // dealerReconciliationService.js already uses: candidates within one
  // batch run in parallel (different dealers genuinely process
  // concurrently), but the NEXT batch only starts once the current one
  // fully settles — so one slow/down dealer can block at most
  // OUTBOUND_RETRY_CONCURRENCY leads, never the whole sweep. The
  // next_retry_at-ascending PRIORITY ORDER established above is preserved
  // at the batch granularity: the most-overdue leads are always in the
  // earliest batches, exactly mirroring reconciliation's own
  // last_attempted_at-ascending ordering through its identical pattern.
  //
  // Only rows that are actually ATTEMPTED count against MAX_LEADS_PER_SWEEP. A
  // dangling mapping (integration removed, lead gone) is deliberately left
  // as-is, but it is never delivered or rewritten, so it stays at the front of
  // the queue; if it used up the per-sweep allowance, a few dozen of them would
  // starve every valid retry behind them. They are examined (two cheap lookups)
  // and passed over, nothing is written to them, and the sweep carries on.
  for (let index = 0; index < dueNow.length && results.attempted < MAX_LEADS_PER_SWEEP;) {
    const size = Math.min(OUTBOUND_RETRY_CONCURRENCY, MAX_LEADS_PER_SWEEP - results.attempted);
    await Promise.all(dueNow.slice(index, index + size).map(processOne));
    index += size;
  }

  if (options && options.includeRoutingHolds) {
    results.routingHolds = await reprocessRoutingHolds(catalystApp);
  }

  logger.info('outboundRetryScheduler', `Sweep complete: ${JSON.stringify(results)}`);
  return results;
}

const MAX_ROUTING_HOLDS_PER_SWEEP = 20;
// Each routable dealer's share of one sweep's budget in the first pass (fairness).
const ROUTING_HOLDS_PER_DEALER_PER_SWEEP = 5;
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

  // The old version read the 20 OLDEST held leads and skipped any whose dealer
  // had not been fixed — without touching them. Those 20 therefore stayed the
  // oldest forever, and a held lead for a dealer that WAS fixed (but sat behind
  // them) was never looked at: with 147 held leads in the live data, most were
  // invisible to the sweep. Instead: find the dealers that have held leads
  // (one aggregate), keep only those whose integration is routable, and read
  // just the held leads that predate that dealer's last change. A lead that is
  // attempted either leaves the hold or is re-held (bumping its MODIFIEDTIME
  // past the integration's), so it drops out of the candidate set and the
  // budget moves on — nothing can sit at the front and block the rest.
  const holdsByDealer = await stats.countGrouped(
    catalystApp,
    LEADS_TABLE,
    ['dealer_code'],
    ["sync_status = 'ROUTING_HOLD'"]
  );
  const dealerCodes = holdsByDealer.map((row) => row.dealer_code).filter(Boolean);
  if (dealerCodes.length === 0) return summary;

  // One dealer's integration config is read once per sweep. Start the dealer
  // order at a rotating position so no dealer is always served first.
  const start = Math.floor(Date.now() / ROTATION_BUCKET_MS) % dealerCodes.length;
  const rotated = [...dealerCodes.slice(start), ...dealerCodes.slice(0, start)];

  const integrations = new Map();
  const exhausted = new Set(); // dealers with nothing (more) to attempt this sweep

  // Two passes over the dealers: first each routable dealer gets a small share
  // (so a dealer with 60 held leads cannot use the whole budget before a dealer
  // with 5 is looked at), then whatever budget is left goes to the dealers that
  // still have candidates.
  for (const perDealerCap of [ROUTING_HOLDS_PER_DEALER_PER_SWEEP, MAX_ROUTING_HOLDS_PER_SWEEP]) {
    for (const dealerCode of rotated) {
      const remaining = MAX_ROUTING_HOLDS_PER_SWEEP - summary.candidates;
      if (remaining <= 0) break;
      if (exhausted.has(dealerCode)) continue;
      try {
        if (!integrations.has(dealerCode)) {
          integrations.set(dealerCode, await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode));
        }
        const integration = integrations.get(dealerCode);
        const isRoutable = integration
          && integration.integration_type === 'EXTERNAL_CRM'
          && !UNROUTABLE_INTEGRATION_STATUSES.includes(integration.status);
        // Only leads held BEFORE the dealer's setup last changed can have been
        // fixed by that change.
        if (!isRoutable || !integration.MODIFIEDTIME) {
          exhausted.add(dealerCode);
          continue;
        }

        const limit = Math.min(perDealerCap, remaining);
        const held = await catalystApp.zcql().executeZCQLQuery(
          `SELECT * FROM ${LEADS_TABLE} WHERE sync_status = 'ROUTING_HOLD' AND dealer_code = '${safeQuoteForZcql(dealerCode)}' ` +
            `AND MODIFIEDTIME < '${safeQuoteForZcql(integration.MODIFIEDTIME)}' ` +
            `ORDER BY MODIFIEDTIME ASC, ROWID ASC LIMIT 1, ${limit}`
        );
        if (held.length < limit) exhausted.add(dealerCode);

        for (const row of held) {
          const leadRow = row[LEADS_TABLE];
          summary.candidates += 1;
          if (!leadRow.crm_record_id) continue;
          try {
            summary.attempted += 1;
            const outcome = await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
            if (outcome && outcome.ok) summary.delivered += 1;
            else summary.stillHeld += 1;
          } catch (err) {
            // syncLeadToExternalCrm already logged the Unhappy classification.
            summary.errored += 1;
          }
        }
      } catch (err) {
        summary.errored += 1;
        exhausted.add(dealerCode);
        logger.error('outboundRetryScheduler', `Routing-hold reprocess failed for dealer ${dealerCode}`, err);
      }
    }
  }
  return summary;
}

// Guarded against re-entrant overlap on the same warm instance — see
// sweepOverlapGuard.js for exactly what this does and does not protect
// against. Exported name/signature unchanged for every existing caller
// (cronRoutes.js).
const runOutboundRetrySweep = guardSweep('outboundRetrySweep', runOutboundRetrySweepInternal);

module.exports = { runOutboundRetrySweep, _test: { reprocessRoutingHolds, selectRetryCandidates, HEAD_ROWS, TAIL_ROWS } };
