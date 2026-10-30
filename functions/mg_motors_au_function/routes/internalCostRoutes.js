'use strict';

const crypto = require('node:crypto');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const { getCostDashboardKey } = require('../config/env');
const internalCostService = require('../services/internalCostService');
const usageContext = require('../services/usageContext');
const logger = require('../utils/logger');
const { COST_PAGE_HTML } = require('./internalCostPage');

const router = express.Router();

// Internal cost page: not part of the MG portal and not behind Catalyst user
// login (mounted before the auth middleware). The data endpoint needs the
// COST_DASHBOARD_KEY in an X-Internal-Key header; without that env var both
// routes answer 404, as if they did not exist.
const TABLE_MISSING = /cost_usage_hourly|No such Table with the given name exists/i;

function keyMatches(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function notFound(res) {
  return res.status(404).json({ error: 'Not found' });
}

router.get('/internal/cost', (req, res) => {
  if (!getCostDashboardKey()) return notFound(res);
  res.set({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex',
    'Referrer-Policy': 'no-referrer',
    'Content-Type': 'text/html; charset=utf-8',
  });
  return res.status(200).send(COST_PAGE_HTML);
});

router.get('/internal/cost/data', async (req, res) => {
  const expected = getCostDashboardKey();
  if (!expected) return notFound(res);
  res.set('Cache-Control', 'no-store');
  if (!keyMatches(req.get('X-Internal-Key'), expected)) {
    return res.status(401).json({ success: false, error: 'Invalid access key' });
  }
  try {
    const catalystApp = usageContext.initialize(catalyst, req);
    const usage = await internalCostService.getUsage(catalystApp, { hours: req.query.hours });
    return res.status(200).json({ success: true, ...usage });
  } catch (err) {
    if (TABLE_MISSING.test(String(err?.message))) {
      return res.status(503).json({ success: false, code: 'COST_TABLE_MISSING', error: 'The cost_usage_hourly table does not exist yet.' });
    }
    logger.error('internalCostRoutes', 'GET /internal/cost/data failed', err);
    return res.status(502).json({ success: false, error: 'Could not read usage' });
  }
});

module.exports = router;
module.exports._test = { keyMatches };
