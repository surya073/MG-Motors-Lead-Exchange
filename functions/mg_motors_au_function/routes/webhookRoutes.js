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

function isEnabled(value) {
  return !(
    value === false || value === 0 ||
    String(value).toLowerCase() === 'false' || String(value) === '0'
  );
}

router.post('/webhooks/crm-notify', express.json(), async (req, res) => {
  try {
    const { webhookToken } = getZohoConfig();
    const incomingToken = req.body?.token;

    if (!webhookVerificationService.verifyZohoWatchToken(incomingToken, webhookToken)) {
      logger.error('webhookRoutes', 'Rejected webhook call with invalid/missing token');
      return res.status(401).json({ error: 'Invalid token' });
    }

    const moduleName = req.body?.module;
    const catalystApp = catalyst.initialize(req);

    if (moduleName === 'Dealer_Master') {
      const result = await syncDealers(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
      return res.status(200).json({ received: true, result });
    } else if (moduleName === 'Leads') {
      const result = await syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
      return res.status(200).json({ received: true, result });
    }

    logger.info('webhookRoutes', `Notification for unhandled module: ${moduleName}`);
    return res.status(202).json({ received: true, ignored: true });
  } catch (err) {
    logger.error('webhookRoutes', 'Webhook processing failed', err);
    if (!res.headersSent) return res.status(502).json({ received: false, error: 'SYNC_FAILED' });
  }
});

router.post('/webhooks/dealers/:dealerCode', express.raw({ type: 'application/json' }), async (req, res) => {
  const catalystApp = catalyst.initialize(req);
  const { dealerCode } = req.params;
  const rawBody = req.body; // Buffer

  try {
    const dealer = await crmIntegrationService.findDealerByCode(catalystApp, dealerCode);
    if (!dealer) return res.status(404).json({ error: 'DEALER_NOT_FOUND' });

    const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, dealerCode);
    if (!integration || integration.integration_type !== 'EXTERNAL_CRM' || !isEnabled(integration.inbound_enabled)) {
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

    if (integration.crm_type === 'ZOHO_CRM' && payload.module !== 'Leads') {
      return res.status(422).json({ error: 'UNSUPPORTED_WEBHOOK_MODULE' });
    }

    // payload.id / payload.leadId identify the dealer RECORD, not this
    // webhook delivery. Using either as the dedupe key drops every later
    // status change for that lead. Prefer a real event id; when none exists,
    // process the delivery and let canonical state/no-change checks provide
    // idempotence (Zoho envelopes for two real changes can be byte-identical).
    const eventId =
      payload.event_id ||
      payload.eventId ||
      headers['x-event-id'] ||
      headers['x-webhook-id'] ||
      null;
    const { isDuplicate, eventRowId } = await crmIntegrationService.checkAndRecordWebhookEvent(
      catalystApp, integration, rawBody, eventId
    );

    if (isDuplicate) {
      return res.status(200).json({ ok: true, status: 'DUPLICATE' });
    }

    try {
      const result = await crmIntegrationService.processInboundWebhook(catalystApp, integration, payload, zohoCrmService);
      await crmIntegrationService.markWebhookEventStatus(
        catalystApp,
        eventRowId,
        result?.held ? 'PENDING' : 'SUCCESS',
        result?.held ? result.reason : undefined
      );
      res.status(result?.held ? 202 : 200).json({ ok: true, result });
    } catch (err) {
      const replayable = err.code === 'LEAD_MAPPING_NOT_FOUND';
      await crmIntegrationService.markWebhookEventStatus(
        catalystApp,
        eventRowId,
        replayable ? 'PENDING' : 'FAILED',
        err.message
      );
      const status = replayable
        ? 202
        : ([
            'FIELD_MAPPING_INVALID',
            'STATUS_MAPPING_NOT_FOUND',
            'STATUS_MAPPING_INVALID_TARGET',
            'STATUS_MAPPING_AMBIGUOUS',
          ].includes(err.code) ? 422 : 500);
      res.status(status).json({ error: err.code || 'INTERNAL_ERROR' });
    }
  } catch (err) {
    logger.error('webhookRoutes', `Dealer webhook failed for ${dealerCode}`, err);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
