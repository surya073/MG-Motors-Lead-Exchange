'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { getZohoConfig } = require('../config/env');
const { syncDealers } = require('../services/dealerSyncService');
const { syncLeads } = require('../services/leadSyncService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * POST /webhooks/crm-notify
 * -----------------------------------------------------------------------
 * Called directly by Zoho CRM (Notifications API), not by a logged-in
 * user — deliberately NOT behind the app's normal getCurrentUser()
 * middleware, since CRM has no Catalyst session. Authenticity is
 * verified via the shared token instead.
 *
 * Payload doesn't include full record fields — only identifies which
 * module/record changed. Simplest, most reliable response: re-run the
 * relevant full sync (already idempotent, upsert-based) rather than
 * trying to parse/patch a single record from a partial payload.
 */
router.post('/webhooks/crm-notify', async (req, res) => {
  try {
    const { webhookToken } = getZohoConfig();
    const incomingToken = req.body?.token;

    if (!incomingToken || incomingToken !== webhookToken) {
      logger.error('webhookRoutes', 'Rejected webhook call with invalid/missing token');
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Respond immediately — Zoho expects a fast 200 and doesn't need to
    // wait for our sync to finish. Run the actual sync after responding.
    res.status(200).json({ received: true });

    const moduleName = req.body?.module;
    const catalystApp = catalyst.initialize(req);

    if (moduleName === 'Dealer_Master') {
      await syncDealers(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
    } else if (moduleName === 'OEM_Leads') {
      await syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
    } else {
      logger.info('webhookRoutes', `Notification for unhandled module: ${moduleName}`);
    }
  } catch (err) {
    logger.error('webhookRoutes', 'Webhook processing failed', err);
    // Response likely already sent above; nothing further to do here.
  }
});

module.exports = router;