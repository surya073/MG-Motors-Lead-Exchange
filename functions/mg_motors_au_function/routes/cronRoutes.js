'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { registerWatchChannels, registerDealerWatchChannel } = require('../services/zohoWebhookService');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler'); // NEW
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const dealerReconciliationService = require('../services/integrations/dealerReconciliationService');
const dailyErrorReportService = require('../services/integrations/dailyErrorReportService');
const logger = require('../utils/logger');
const integrationAlertService = require('../services/integrations/integrationAlertService');
const alertContext = require('../services/integrations/alertContext');

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
    const catalystApp = catalyst.initialize(req);
    const result = await registerWatchChannels(catalystApp);
    logger.info('cronRoutes', 'Webhook channel renewed via cron', result);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('cronRoutes', 'Cron webhook renewal failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/cron/renew-dealer-webhooks', async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const catalystApp = catalyst.initialize(req);
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM dealer_integrations WHERE integration_type = 'EXTERNAL_CRM' AND crm_type = 'ZOHO_CRM'`
    );
    const integrations = rows.map((r) => r.dealer_integrations);

    const results = [];
    for (const integration of integrations) {
      try {
        results.push(await registerDealerWatchChannel(catalystApp, integration));
      } catch (err) {
        logger.error('cronRoutes', `Dealer watch renewal failed for ${integration.dealer_code}`, err);
        results.push({ dealerCode: integration.dealer_code, error: err.message });
      }
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
    const catalystApp = catalyst.initialize(req);
    const results = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp);
    logger.info('cronRoutes', 'Outbound retry sweep completed via cron', results);
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
 */
router.post('/cron/fast-recover', backgroundRun, async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  try {
    const catalystApp = catalyst.initialize(req);
    const results = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp, {
      ignoreSchedule: true,
      includeRoutingHolds: true,
    });
    if (results.recovered > 0) {
      logger.info('cronRoutes', `Fast recovery delivered ${results.recovered} lead(s)`);
    }
    // Same pass, other direction: held dealer -> MG updates (Unhappy 4/7/9)
    // are released as soon as they can be applied. Its own failure must not
    // hide the outbound results above.
    try {
      results.inboundReplay = await inboundReplayScheduler.runInboundReplaySweep(catalystApp);
    } catch (replayErr) {
      logger.error('cronRoutes', 'Inbound replay within fast recovery failed', replayErr);
      results.inboundReplay = { error: replayErr.message };
    }
    // Unhappy 10 SLA check in the same pass (window and dealer scope come
    // from DEALER_ACTION_SLA_MINUTES / DEALER_ACTION_SLA_DEALERS).
    try {
      results.slaCheck = await slaMonitorService.runSlaSweep(catalystApp);
    } catch (slaErr) {
      logger.error('cronRoutes', 'SLA check within fast recovery failed', slaErr);
      results.slaCheck = { error: slaErr.message };
    }
    // Unhappy 11 reconciliation, throttled (see RECONCILE_EVERY_MINUTES).
    if (isReconciliationDue()) {
      try {
        results.reconciliation = await dealerReconciliationService.runDealerReconciliation(catalystApp, {
          heldExistenceOnly: true,
        });
      } catch (reconcileErr) {
        logger.error('cronRoutes', 'Reconciliation within fast recovery failed', reconcileErr);
        results.reconciliation = { error: reconcileErr.message };
        await alertReconciliationFailure(catalystApp, reconcileErr);
      }
    }
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
    const catalystApp = catalyst.initialize(req);
    const results = await inboundReplayScheduler.runInboundReplaySweep(catalystApp);
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
    const catalystApp = catalyst.initialize(req);
    const results = await slaMonitorService.runSlaSweep(catalystApp);
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
    const catalystApp = catalyst.initialize(req);
    const results = await dealerReconciliationService.runDealerReconciliation(catalystApp);
    res.status(200).json({ success: true, results });
  } catch (err) {
    logger.error('cronRoutes', 'Dealer reconciliation failed', err);
    await alertReconciliationFailure(catalyst.initialize(req), err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/cron/daily-error-report', async (req, res) => {
  const providedSecret = req.headers['x-cron-secret'];
  if (!providedSecret || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const catalystApp = catalyst.initialize(req);
    const report = await dailyErrorReportService.sendDailyErrorReport(catalystApp);
    res.status(200).json({ success: true, report });
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
    const catalystApp = catalyst.initialize(req);
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
