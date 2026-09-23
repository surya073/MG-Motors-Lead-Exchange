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
router.post('/cron/retry-outbound-syncs', async (req, res) => {
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
router.post('/cron/fast-recover', async (req, res) => {
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
    res.status(200).json({ success: true, mode: 'fast-recovery', results });
  } catch (err) {
    logger.error('cronRoutes', 'Fast recovery sweep failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/cron/replay-inbound-events', async (req, res) => {
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

router.post('/cron/check-lead-sla', async (req, res) => {
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

router.post('/cron/reconcile-dealer-leads', async (req, res) => {
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

    const result = await integrationAlertService.sendConfiguredEmail(catalystApp, {
      subject: '[MG Lead Exchange] Test alert',
      content: [
        'This is a test of the Lead Exchange alert channel.',
        '',
        'If you are reading this, immediate Unhappy-path notifications (GR-04)',
        'will reach this inbox without anyone logging into the application.',
        `Sent (UTC): ${new Date().toISOString()}`,
      ].join('\n'),
      recipientEnv: 'INTEGRATION_ALERT_TO_EMAILS',
    });

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
