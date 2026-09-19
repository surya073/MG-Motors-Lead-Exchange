'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { registerWatchChannels, registerDealerWatchChannel } = require('../services/zohoWebhookService');
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


router.get('/debug/check-lead-status', async (req, res) => {
  try {
    const { getZohoConfig } = require('../config/env');
    const { getAccessToken } = require('../services/zohoAuthService');
    const axios = require('axios');

    const { apiDomain } = getZohoConfig();
    const accessToken = await getAccessToken();

    const response = await axios.get(`${apiDomain}/crm/v8/Leads/1378627000000780009`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      params: { fields: 'Lead_Status,Enquiry_Status' },
    });

    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

module.exports = router;