'use strict';

const logger = require('../../utils/logger');

/**
 * sweepOverlapGuard.js
 * -----------------------------------------------------------------------
 * Added for the 200+ dealer concurrency audit: outboundRetryScheduler.js,
 * inboundReplayScheduler.js, dealerReconciliationService.js and
 * slaMonitorService.js previously had ZERO overlap protection — if the
 * same sweep function was invoked again before its previous run
 * finished, both runs read the same candidate rows and could both act on
 * them (most concretely: two overlapping outbound-retry sweeps both
 * seeing no external_crm_lead_id yet and both calling adapter.createLead
 * for the same lead — a confirmed duplicate-lead-creation path).
 *
 * This guard de-duplicates re-entrant calls to the SAME sweep within one
 * warm Catalyst function instance: if a sweep is already running, a
 * second call returns immediately with {skipped: true, reason:
 * 'SWEEP_ALREADY_RUNNING'} instead of re-running. This covers the most
 * common real-world overlap case documented on /cron/fast-recover itself
 * (intended to fire every couple of minutes — if a sweep takes longer
 * than that under load, consecutive invocations WILL overlap on the same
 * instance) and any case where a dedicated sweep cron (e.g.
 * /cron/retry-outbound-syncs) fires while /cron/fast-recover's call to
 * the same underlying function is still in flight.
 *
 * KNOWN LIMITATION, explicitly not solved here: this is in-memory only,
 * so it does NOT protect against two separate Catalyst function
 * instances both running the same sweep at the same moment. Fixing that
 * would need either a DB-enforced unique constraint on
 * lead_integrations(integration_id, zoho_lead_id) — which requires first
 * checking live production data for existing duplicates before adding
 * (not done here, see audit report) — or a conditional/compare-and-swap
 * UPDATE primitive. Neither is available: Catalyst's ZCQL
 * (executeZCQLQuery) is SELECT-only, and the Datastore API's
 * Table.updateRow() takes only a ROWID and fields, with no WHERE/version
 * condition — confirmed directly from the installed zcatalyst-sdk-node
 * type definitions, not assumed. A true cross-instance fix is blocked on
 * one of those two platform-level changes.
 */

const runningSweeps = new Map(); // sweepName -> in-flight Promise

function guardSweep(sweepName, fn) {
  return async (...args) => {
    const existing = runningSweeps.get(sweepName);
    if (existing) {
      logger.info('sweepOverlapGuard', `Skipped overlapping invocation of ${sweepName} (already running on this instance)`);
      return { skipped: true, reason: 'SWEEP_ALREADY_RUNNING', sweep: sweepName };
    }

    const runPromise = Promise.resolve()
      .then(() => fn(...args))
      .finally(() => {
        runningSweeps.delete(sweepName);
      });
    runningSweeps.set(sweepName, runPromise);
    return runPromise;
  };
}

/** Test-only: clears guard state between test runs. */
function _resetForTests() {
  runningSweeps.clear();
}

module.exports = { guardSweep, _resetForTests };
