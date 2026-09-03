'use strict';

const express = require('express');
const { requireAdminRole } = require('../middleware/requireAdminRole');
const { getDashboardSummary } = require('../services/adminDashboardService');
const { analyzeUploadedFile, askAssistant } = require('../services/onDemandAiService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * onDemandDashboardRoutes.js
 * -----------------------------------------------------------------------
 * Backs the frontend's On-Demand Dashboard (src/pages/OnDemandDashboard,
 * specifically services/aiService.js).
 *
 *   GET  /on-demand/summary       -> live app data, reuses getDashboardSummary
 *   POST /on-demand/analyze-file  -> AI analysis of an uploaded PDF/Excel/CSV
 *   POST /on-demand/chat          -> AI assistant, grounded in live + uploaded data
 *
 * All three currently require requireAdminRole, matching every other
 * /admin/* route in this function. If Dealer-role users should also be
 * able to use the On-Demand Dashboard, swap this for whatever
 * authenticated-but-not-admin-only middleware fits your role model —
 * don't just remove it, since these routes hit the Gemini API and
 * should stay behind some form of auth.
 */

router.get('/on-demand/summary', requireAdminRole, async (req, res) => {
  try {
    const summary = await getDashboardSummary(res.locals.catalystApp);
    res.status(200).json({ success: true, summary });
  } catch (err) {
    logger.error('onDemandDashboardRoutes', 'GET /on-demand/summary failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/on-demand/analyze-file', requireAdminRole, async (req, res) => {
  try {
    const { fileData, fileName } = req.body;
    if (!fileData || !fileName) {
      return res.status(400).json({ success: false, error: 'fileData and fileName are required' });
    }
    const result = await analyzeUploadedFile(fileData, fileName);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('onDemandDashboardRoutes', 'POST /on-demand/analyze-file failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/on-demand/chat', requireAdminRole, async (req, res) => {
  try {
    const { question, appDataSummary, uploadedFileSummary, history } = req.body;
    if (!question) {
      return res.status(400).json({ success: false, error: 'question is required' });
    }

    // If the frontend didn't already have a live-data summary to send
    // (e.g. the person opened the chat before generating a dashboard),
    // fetch a fresh one so the assistant always has real numbers.
    const summary = appDataSummary || (await getDashboardSummary(res.locals.catalystApp));
    const reply = await askAssistant(question, { appDataSummary: summary, uploadedFileSummary, history });

    res.status(200).json({ success: true, reply });
  } catch (err) {
    logger.error('onDemandDashboardRoutes', 'POST /on-demand/chat failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;