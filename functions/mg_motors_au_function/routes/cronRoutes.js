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
module.exports = router;
