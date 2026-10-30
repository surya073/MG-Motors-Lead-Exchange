'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { registerWatchChannels, registerDealerWatchChannel, isDealerWatchEligible } = require('../services/zohoWebhookService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler'); // NEW
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const dealerReconciliationService = require('../services/integrations/dealerReconciliationService');
const dailyErrorReportService = require('../services/integrations/dailyErrorReportService');
const webhookEventRetention = require('../services/integrations/webhookEventRetention');
const logger = require('../utils/logger');
const usageContext = require('../services/usageContext');
const integrationAlertService = require('../services/integrations/integrationAlertService');
const integrationAlertBatchService = require('../services/integrations/integrationAlertBatchService');
const alertContext = require('../services/integrations/alertContext');
const { syncModifiedLeads } = require('../services/leadSyncService');
const dealerSyncService = require('../services/dealerSyncService');
const dashboardStats = require('../services/dashboardStatsService');
const { getOutboundRetryConfig, getCronWorkBudgetMs } = require('../config/env');

// CRON_WORK_BUDGET_MS (Batch 8, S3): when set, sweeps start no new work after
// this moment; unset, no deadline (undefined), as before.
function workDeadline(startedAt) {
  const budget = getCronWorkBudgetMs();
  return budget ? startedAt + budget : undefined;
}

// The sweep option for that deadline: `{ deadline }`, or nothing at all.
function deadlineOption(deadline) {
  return deadline ? { deadline } : {};
}

// Background sweeps: alerts they raise are recorded but not emailed (see
// alertContext.js). The daily report and test alert are not wrapped.
function backgroundRun(req, res, next) {
  alertContext.runInBackground(next);
}

// Unhappy 11 edge case (c): "the reconciliation job itself fails → alert;
// a silent reconciliation failure hides every other gap."
async function alertReconciliationFailure(catalystApp, err) {
  try {
    await integrationAlertService.notifyScenario(catalystApp, {
      scenarioCode: 'Unhappy 11',
      scenarioMessage: 'Reconciliation job failed',
      priority: 'P2',
      reason: `The dealer reconciliation run did not complete: ${err.message}. Mismatches cannot be detected until it runs.`,
    });
  } catch (alertErr) {
    logger.error('cronRoutes', 'Could not send reconciliation-failure alert', alertErr);
  }
}

// Reconciliation is I/O heavy (one dealer round trip per record), so inside
// the 2-minute fast-recovery pass it runs once per RECONCILE_EVERY_MINUTES
// window rather than on every call. Default: once a day, the register's
// minimum. The cron fires every 2 minutes, so a window of <2 minutes past
// each interval boundary matches exactly one run.
// Floor of 60 minutes: every run reads each dealer record once, so a
// 2-minute window cost ~43k dealer API credits a day against a 53k quota.
const MIN_RECONCILE_EVERY_MINUTES = 60;
const RECONCILE_EVERY_MINUTES = (() => {
  const configured = Number(process.env.RECONCILE_EVERY_MINUTES);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(configured, MIN_RECONCILE_EVERY_MINUTES)
    : 24 * 60;
})();

function isReconciliationDue(now = new Date()) {
  const minutes = Math.floor(now.getTime() / 60000);
  return minutes % RECONCILE_EVERY_MINUTES < 2;
}

// Same formula/pattern as dealerReconciliationService.js's
// RECONCILE_CONCURRENCY and outboundRetryScheduler.js's
// OUTBOUND_RETRY_CONCURRENCY: each dealer webhook renewal costs a real
// Zoho API round trip (deregister + register), and /cron/renew-dealer-webhooks
// previously processed every ZOHO_CRM dealer fully serially — the same
// unbounded-execution-time risk those two schedulers were already fixed
// for, at a comparable (or larger) record count once there are 200+
// dealers. No record cap is added here — only concurrency — since,
// unlike a retry/reconciliation sweep where a leftover candidate is
// safely picked up next sweep, skipping a dealer's renewal here could
// mean its webhook channel silently expires with nothing left to retry
// it; every matching dealer must still be renewed on every run, just
// bounded in how many run at once.
const DEALER_WEBHOOK_RENEWAL_CONCURRENCY = (() => {
  const configured = Number(process.env.DEALER_WEBHOOK_RENEWAL_CONCURRENCY);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(configured, 10) : 6;
})();

// Time the fast-recover request aims to finish within (Catalyst documents 30 s
// for Advanced I/O functions). Every stage shares this start-based deadline.
const FAST_RECOVER_BUDGET_MS = 25000;

const router = express.Router();

// Protected by a shared secret (Catalyst env var CRON_SECRET), NOT user auth —
// Catalyst Cron calls this directly with no session/cookie, so it must be
// mounted BEFORE the currentUser auth middleware in app.js.
router.post('/cron/renew-webhook', async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const result = await registerWatchChannels(catalystApp);
    logger.info('cronRoutes', 'Webhook channel renewed via cron', result);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('cronRoutes', 'Cron webhook renewal failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Recovery for missed/failed Lead webhooks: re-reads only the OEM leads modified
// since the last clean run (Zoho If-Modified-Since). Schedule alongside the
// other sweeps; a quiet period costs one 304 call and writes no sync_logs row.
router.post('/cron/sync-modified-leads', async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const result = await syncModifiedLeads(catalystApp, { triggeredBy: 'Cron' });
    usageContext.annotateSweepOutcome(result);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('cronRoutes', 'Cron sync-modified-leads failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/cron/renew-dealer-webhooks', async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    // Read completely in ordered pages: a bare SELECT silently stops at 300
    // rows, which would leave any dealer beyond that without a webhook renewal.
    const integrations = await dashboardStats.selectEveryRow(
      catalystApp,
      'dealer_integrations',
      "WHERE integration_type = 'EXTERNAL_CRM' AND crm_type = 'ZOHO_CRM'",
      'ORDER BY ROWID ASC',
      5000
    );

    const results = [];
    const renewOne = async (integration) => {
      try {
        if (!isDealerWatchEligible(integration)) return;
        const dealer = await crmIntegrationService.findDealerByCode(catalystApp, integration.dealer_code);
        if (!dealer || dealer.sync_status === 'Removed') return;
        results.push(await registerDealerWatchChannel(catalystApp, integration));
      } catch (err) {
        logger.error('cronRoutes', `Dealer watch renewal failed for ${integration.dealer_code}`, err);
        results.push({ dealerCode: integration.dealer_code, error: err.message });
      }
    };

    // Bounded concurrency, same chunked-Promise.all shape already used by
    // dealerReconciliationService.js/outboundRetryScheduler.js: dealers
    // within one batch renew in parallel, the next batch only starts once
    // the current one fully settles — one slow/failing dealer can block
    // at most DEALER_WEBHOOK_RENEWAL_CONCURRENCY dealers, never the whole
    // run, and every dealer in `integrations` is still processed exactly
    // as before (same selection, same per-dealer logic, same error
    // handling) — only the execution shape changed.
    for (let index = 0; index < integrations.length; index += DEALER_WEBHOOK_RENEWAL_CONCURRENCY) {
      await Promise.all(integrations.slice(index, index + DEALER_WEBHOOK_RENEWAL_CONCURRENCY).map(renewOne));
    }

    res.status(200).json({ success: true, results });
  } catch (err) {
    logger.error('cronRoutes', 'Dealer webhook cron failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * NEW — re-attempts every lead currently stuck FAILED/FAILED_CRITICAL
 * in lead_integrations whose next_retry_at has passed. This is what
 * makes Unhappy 1 → Unhappy 3 escalation (and retries in general)
 * happen on a schedule instead of only when an admin clicks Retry.
 * See services/integrations/outboundRetryScheduler.js for the sweep
 * itself and crmIntegrationService.js for the classification/bookkeeping
 * it triggers on each lead it retries.
 */
router.post('/cron/retry-outbound-syncs', backgroundRun, async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const results = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp, deadlineOption(workDeadline(Date.now())));
    logger.info('cronRoutes', 'Outbound retry sweep completed via cron', results);
    usageContext.annotateSweepOutcome(results);
    res.status(200).json({ success: true, results });
  } catch (err) {
    logger.error('cronRoutes', 'Outbound retry sweep cron failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * Happy 4 fast recovery.
 *
 * Runs the same outbound sweep as /cron/retry-outbound-syncs but ignores
 * each lead's next_retry_at, so leads that failed during a dealer outage go
 * out as soon as the connection is back rather than waiting out their
 * individual back-off. Intended to be scheduled every couple of minutes,
 * alongside — not instead of — the ordinary paced sweep, which is left
 * exactly as it was.
 *
 * Safe to run often: a lead that is still broken simply fails again and is
 * re-counted, and one that is held by policy (validation, consent, echo) is
 * reported under heldByPolicy rather than being pushed.
 *
 * FAST_RECOVER_HONOUR_SCHEDULE=true (config/env.js) makes this sweep wait
 * for each lead's next_retry_at too, so the retry backoff applies even when
 * fast-recover is the only retry cron. A lead with no next_retry_at is due.
 */
router.post('/cron/fast-recover', backgroundRun, async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const fastRecoverStartedAt = Date.now();
    const deadline = Math.min(workDeadline(fastRecoverStartedAt) ?? Infinity,
      fastRecoverStartedAt + FAST_RECOVER_BUDGET_MS);
    const catalystApp = usageContext.initialize(catalyst, req);
    const results = {};
    // Due maintenance goes first because its narrow daily window may not be
    // present on the next invocation. It shares the same request deadline.
    if (isReconciliationDue()) {
      usageContext.setStage('reconciliation');
      try {
        results.reconciliation = await dealerReconciliationService.runDealerReconciliation(catalystApp, {
          heldExistenceOnly: true, deadline,
        });
      } catch (err) {
        logger.error('cronRoutes', 'Reconciliation within fast recovery failed', err);
        results.reconciliation = { error: err.message };
        await alertReconciliationFailure(catalystApp, err);
      }
    }
    if (Date.now() < deadline && webhookEventRetention.isRetentionDue()) {
      usageContext.setStage('webhookEventRetention');
      try {
        results.webhookEventRetention = await webhookEventRetention.purgeOldWebhookEvents(catalystApp);
      } catch (err) {
        logger.error('cronRoutes', 'Webhook event retention within fast recovery failed', err);
        results.webhookEventRetention = { error: err.message };
      }
    }
    // Trailing sync for Dealers notifications skipped during a burst (one
    // read when nothing is pending).
    if (Date.now() < deadline) {
      usageContext.setStage('dealerSync');
      try {
        results.dealerSync = await dealerSyncService.runPendingDealerSync(catalystApp);
      } catch (err) {
        logger.error('cronRoutes', 'Pending dealer sync within fast recovery failed', err);
        results.dealerSync = { error: err.message };
      }
    }

    const windowSequence = Math.floor(fastRecoverStartedAt / (2 * 60 * 1000 * 4));
    const stages = [
      async () => {
        usageContext.setStage('outbound');
        const outbound = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp, {
          ignoreSchedule: !getOutboundRetryConfig().fastRecoverHonourSchedule,
          includeRoutingHolds: true, deadline, windowSequence,
        });
        Object.assign(results, outbound);
        if (outbound.recovered > 0) logger.info('cronRoutes', `Fast recovery delivered ${outbound.recovered} lead(s)`);
      },
      async () => {
        usageContext.setStage('inboundReplay');
        try {
          results.inboundReplay = await inboundReplayScheduler.runInboundReplaySweep(catalystApp, { deadline, windowSequence });
        } catch (err) {
          logger.error('cronRoutes', 'Inbound replay within fast recovery failed', err);
          results.inboundReplay = { error: err.message };
        }
      },
      async () => {
        usageContext.setStage('slaCheck');
        try {
          results.slaCheck = await slaMonitorService.runSlaSweep(catalystApp, new Date(), { deadline, windowSequence });
        } catch (err) {
          logger.error('cronRoutes', 'SLA check within fast recovery failed', err);
          results.slaCheck = { error: err.message };
        }
      },
      async () => {
        usageContext.setStage('alertBatch');
        try {
          results.alertBatch = await integrationAlertBatchService.flushIfWindowElapsed(catalystApp, { deadline });
        } catch (err) {
          logger.error('cronRoutes', 'Alert batch flush within fast recovery failed', err);
          results.alertBatch = { error: err.message };
        }
      },
    ];
    // On the documented two-minute schedule each stage gets first use of the
    // budget once per four slots, consistently across function instances.
    // One sustained backlog cannot always monopolize the first position.
    const first = Math.floor(fastRecoverStartedAt / (2 * 60 * 1000)) % stages.length;
    for (let step = 0; step < stages.length; step += 1) {
      await stages[(first + step) % stages.length]();
    }
    usageContext.setStage(null);
    usageContext.annotateSweepOutcome(results);
    res.status(200).json({ success: true, mode: 'fast-recovery', results });
  } catch (err) {
    logger.error('cronRoutes', 'Fast recovery sweep failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/cron/replay-inbound-events', backgroundRun, async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const results = await inboundReplayScheduler.runInboundReplaySweep(catalystApp, deadlineOption(workDeadline(Date.now())));
    usageContext.annotateSweepOutcome(results);
    res.status(200).json({ success: true, results });
  } catch (err) {
    logger.error('cronRoutes', 'Inbound replay sweep failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/cron/check-lead-sla', backgroundRun, async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const results = await slaMonitorService.runSlaSweep(catalystApp);
    usageContext.annotateSweepOutcome(results);
    res.status(200).json({ success: true, results });
  } catch (err) {
    logger.error('cronRoutes', 'Lead SLA sweep failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/cron/reconcile-dealer-leads', backgroundRun, async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const results = await dealerReconciliationService.runDealerReconciliation(catalystApp, deadlineOption(workDeadline(Date.now())));
    usageContext.annotateSweepOutcome(results);
    res.status(200).json({ success: true, results });
  } catch (err) {
    logger.error('cronRoutes', 'Dealer reconciliation failed', err);
    await alertReconciliationFailure(usageContext.initialize(catalyst, req), err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/cron/daily-error-report', async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const report = await dailyErrorReportService.sendDailyErrorReport(catalystApp);
    let webhookEventRetentionResult;
    try {
      webhookEventRetentionResult = await webhookEventRetention.purgeOldWebhookEvents(catalystApp);
    } catch (retentionErr) {
      logger.error('cronRoutes', 'Webhook event retention within the daily report failed', retentionErr);
      webhookEventRetentionResult = { error: retentionErr.message };
    }
    res.status(200).json({ success: true, report, webhookEventRetention: webhookEventRetentionResult });
  } catch (err) {
    logger.error('cronRoutes', 'Daily error report cron failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});
/**
 * Sends a single test alert through the configured channel so email
 * delivery can be proven without waiting for a real Unhappy path to
 * occur. Protected by CRON_SECRET like the other operational routes.
 * The response reports which channel was used and whether the provider
 * accepted the message, so a silent misconfiguration is visible.
 */
router.post('/cron/test-alert', async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const integrationAlertService = require('../services/integrations/integrationAlertService');

    const result = await integrationAlertService.sendTestAlert(catalystApp);

    res.status(200).json({
      success: true,
      smtpConfigured: integrationAlertService.smtpConfigured(),
      recipientsConfigured: Boolean(process.env.INTEGRATION_ALERT_TO_EMAILS),
      senderConfigured: Boolean(process.env.INTEGRATION_ALERT_FROM_EMAIL || process.env.SMTP_USER),
      result,
    });
  } catch (err) {
    logger.error('cronRoutes', 'Test alert failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;
