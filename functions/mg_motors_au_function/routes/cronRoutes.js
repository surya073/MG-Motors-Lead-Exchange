'use strict';

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { registerWatchChannels } = require('../services/zohoWebhookService');
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

module.exports = router;