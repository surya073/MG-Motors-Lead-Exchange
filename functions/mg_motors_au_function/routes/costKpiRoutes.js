'use strict';

const express = require('express');
const costKpiService = require('../services/costKpiService');
const { requireSuperAdminRole } = require('../middleware/requireSuperAdminRole');
const logger = require('../utils/logger');

const router = express.Router();

// The cost_daily table is created in the Catalyst Console (see costKpiService.js).
// "No such Table with the given name exists." is what live Catalyst returned
// on 23 Oct 2026 (the other cost routes' tables always exist).
const TABLE_MISSING = /Unkn?own Table cost_daily|INVALID_TABLE cost_daily|cost_daily.*(not found|does not exist)|No such Table with the given name exists/i;

function fail(res, label, err) {
  if (TABLE_MISSING.test(String(err?.message))) {
    return res.status(503).json({
      success: false,
      error: 'The cost_daily table has not been created yet. Create it in the Catalyst Console (columns in costKpiService.js).',
      code: 'COST_TABLE_MISSING',
    });
  }
  if (err?.statusCode === 400 || err?.statusCode === 404) {
    return res.status(err.statusCode).json({ success: false, error: err.message });
  }
  logger.error('costKpiRoutes', `${label} failed`, err);
  return res.status(502).json({ success: false, error: err.message });
}

// GET /admin/cost-kpis?days=30
router.get('/admin/cost-kpis', requireSuperAdminRole, async (req, res) => {
  try {
    const kpis = await costKpiService.getCostKpis(res.locals.catalystApp, { days: req.query.days });
    res.status(200).json({ success: true, ...kpis });
  } catch (err) {
    fail(res, 'GET /admin/cost-kpis', err);
  }
});

// POST /admin/cost-kpis/usage  — body: the JSON from scripts/usageReport.js --json
router.post('/admin/cost-kpis/usage', requireSuperAdminRole, async (req, res) => {
  try {
    const result = await costKpiService.uploadUsage(res.locals.catalystApp, req.body);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    fail(res, 'POST /admin/cost-kpis/usage', err);
  }
});

// POST /admin/cost-kpis/billing  { snapshotAt, fetch, update, insert, delete }
router.post('/admin/cost-kpis/billing', requireSuperAdminRole, async (req, res) => {
  try {
    const result = await costKpiService.addBillingSnapshot(res.locals.catalystApp, req.body);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    fail(res, 'POST /admin/cost-kpis/billing', err);
  }
});

// DELETE /admin/cost-kpis/billing/:rowId
router.delete('/admin/cost-kpis/billing/:rowId', requireSuperAdminRole, async (req, res) => {
  try {
    const result = await costKpiService.deleteBillingSnapshot(res.locals.catalystApp, req.params.rowId);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    fail(res, 'DELETE /admin/cost-kpis/billing', err);
  }
});

module.exports = router;
