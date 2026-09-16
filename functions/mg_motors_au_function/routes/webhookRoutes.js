'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { getZohoConfig } = require('../config/env');
const { syncDealers } = require('../services/dealerSyncService');
const { syncLeads } = require('../services/leadSyncService');
const zohoCrmService = require('../services/zohoCrmService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const webhookVerificationService = require('../services/integrations/webhookVerificationService');
const logger = require('../utils/logger');

const router = express.Router();

router.post('/webhooks/crm-notify', express.json(), async (req, res) => {
  try {
    const { webhookToken } = getZohoConfig();
    const incomingToken = req.body?.token;

    if (!incomingToken || incomingToken !== webhookToken) {
      logger.error('webhookRoutes', 'Rejected webhook call with invalid/missing token');
      return res.status(401).json({ error: 'Invalid token' });
    }

    res.status(200).json({ received: true });

    const moduleName = req.body?.module;
    const catalystApp = catalyst.initialize(req);

    if (moduleName === 'Dealer_Master') {
      await syncDealers(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
    } else if (moduleName === 'Leads') {
      // FIX: Zoho's real CRM module API name is "Leads" (see
      // zohoCrmService.js / zohoWebhookService.js) — this previously
      // checked for "OEM_Leads", which is not a real module name, so
      // notifications for lead changes always fell through to the
      // "unhandled module" branch below and syncLeads() never ran.
      await syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
    } else {
      logger.info('webhookRoutes', `Notification for unhandled module: ${moduleName}`);
    }
  } catch (err) {
    logger.error('webhookRoutes', 'Webhook processing failed', err);
  }
});
/**
 * POST /webhooks/dealers/:dealerCode
 * -----------------------------------------------------------------------
 * Inbound from a dealer's own external CRM. Requires raw body (Buffer)
 * for exact-byte HMAC verification — express.raw() is scoped to just
 * this route so it doesn't interfere with express.json() used elsewhere
 * in index.js for the app's normal JSON routes.
 */
router.post('/webhooks/dealers/:dealerCode', express.raw({ type: 'application/json' }), async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  const rawBody = req.body; // Buffer

  try {
    const dealer = await crmIntegrationService.findDealerByCode(catalystApp, dealerCode);
    if (!dealer) return res.status(404).json({ error: 'DEALER_NOT_FOUND' });

    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration || integration.integration_type !== 'EXTERNAL_CRM') {
      return res.status(404).json({ error: 'INTEGRATION_NOT_CONFIGURED' });
    }

    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const authResult = await webhookVerificationService.verifyWebhook(catalystApp, integration, rawBody, headers);
    if (!authResult.ok) {
      logger.error('webhookRoutes', `Webhook auth failed for ${dealerCode}: ${authResult.reason}`);
      return res.status(401).json({ error: 'WEBHOOK_AUTH_FAILED' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'INVALID_CRM_CONFIGURATION' });
    }

    const eventId = payload.event_id || payload.id || null;
    const { isDuplicate, eventRowId } = await crmIntegrationService.checkAndRecordWebhookEvent(
      catalystApp, integration, rawBody, eventId
    );

    if (isDuplicate) {
      return res.status(200).json({ ok: true, status: 'DUPLICATE' });
    }

    try {
      const result = await crmIntegrationService.processInboundWebhook(catalystApp, integration, payload, zohoCrmService);
      await crmIntegrationService.markWebhookEventStatus(catalystApp, eventRowId, 'SUCCESS');
      res.status(200).json({ ok: true, result });
    } catch (err) {
      await crmIntegrationService.markWebhookEventStatus(catalystApp, eventRowId, 'FAILED', err.message);
      const status = ['LEAD_MAPPING_NOT_FOUND', 'FIELD_MAPPING_INVALID', 'STATUS_MAPPING_NOT_FOUND'].includes(err.code) ? 422 : 500;
      res.status(status).json({ error: err.code || 'INTERNAL_ERROR' });
    }
  } catch (err) {
    logger.error('webhookRoutes', `Dealer webhook failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;