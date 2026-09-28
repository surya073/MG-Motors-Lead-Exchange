'use strict';

const express = require('express');
const { requireAdminOrViewRole } = require('../middleware/requireAdminOrViewRole');
const { getDashboardSummary } = require('../services/adminDashboardService');
const { analyzeUploadedFile, askAssistant } = require('../services/onDemandAiService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * onDemandDashboardRoutes.js
 * -----------------------------------------------------------------------
 * Backs the frontend's On-Demand Dashboard (src/pages/OnDemandDashboard,
 * specifically services/aiService.js) and the AI assistant widget embedded
 * in Overview.jsx (services/api/aiAssistantService.js).
 *
 *   GET  /on-demand/summary       -> live app data, reuses getDashboardSummary
 *   POST /on-demand/analyze-file  -> AI analysis of an uploaded PDF/Excel/CSV
 *   POST /on-demand/chat          -> AI assistant, grounded in live + uploaded data
 *
 * All three use requireAdminOrViewRole (Admin/Super Admin/View User) —
 * none of them mutate any CRM/dealer/lead record, they only read and ask
 * questions about data already visible to whoever is asking, so View User
 * is allowed the same as every other /admin/* GET route. Still behind
 * auth (not open to Dealer or unauthenticated), since these hit the
 * Gemini API.
 */

router.get('/on-demand/summary', requireAdminOrViewRole, async (req, res) => {
  try {
    const summary = await getDashboardSummary(res.locals.catalystApp);
    res.status(200).json({ success: true, summary });
  } catch (err) {
    logger.error('onDemandDashboardRoutes', 'GET /on-demand/summary failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/on-demand/analyze-file', requireAdminOrViewRole, async (req, res) => {
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

router.post('/on-demand/chat', requireAdminOrViewRole, async (req, res) => {
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