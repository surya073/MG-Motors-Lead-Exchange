'use strict';

const express = require('express');
const { requireAdminRole } = require('../middleware/requireAdminRole');
const {
  getAllDealersWithLeadCounts,
  getAllLeads,
  summarizeLeadsByStatus,
  getDealerPerformance,
  getSyncLogs,
  getDashboardSummary,
  getDealerInvitationStatus,
} = require('../services/adminDashboardService');
const { fetchDealerMaster } = require('../services/zohoCrmService');
const { removeDealerUser } = require('../services/dealerInviteService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService'); // NEW
const logger = require('../utils/logger');

const router = express.Router();

// requireAdminRole is applied per-route below, NOT via router.use() —
// router.use(requireAdminRole) was found to leak into sibling routers
// mounted at the same '/' path (dealerLeadRoutes), incorrectly blocking
// Dealer-role requests to unrelated routes. This is documented Express
// behavior (see expressjs/express#5753) when multiple routers share a
// mount path — router.use() middleware isn't as isolated as it appears.

router.get('/admin/dealers', requireAdminRole, async (req, res) => {
  try {
    const dealers = await getAllDealersWithLeadCounts(res.locals.catalystApp);
    res.status(200).json({ success: true, count: dealers.length, dealers });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/dealers failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/leads', requireAdminRole, async (req, res) => {
  try {
    const { dealerCode, leadStatus } = req.query;
    const leads = await getAllLeads(res.locals.catalystApp, { dealerCode, leadStatus });
    res.status(200).json({ success: true, count: leads.length, leads });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/leads failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/leads/:crmRecordId/timeline
 * -----------------------------------------------------------------------
 * Chronological Happy/Unhappy activity history for one lead, sourced
 * from integration_logs (dealer-CRM sync events), keyed by the lead's
 * crm_record_id (== zoho_lead_id in integration_logs). Powers the
 * Activity Timeline on LeadDetailView.jsx. Placed ABOVE
 * /admin/leads/summary so Express's route matching doesn't need param
 * disambiguation, but since this is a distinct literal segment
 * (:crmRecordId/timeline vs. summary) either order is actually fine —
 * kept here for readability next to the sibling /admin/leads route.
 */
router.get('/admin/leads/:crmRecordId/timeline', requireAdminRole, async (req, res) => {
  try {
    const { crmRecordId } = req.params;
    const timeline = await crmIntegrationService.getLeadActivityTimeline(res.locals.catalystApp, crmRecordId);
    res.status(200).json({ success: true, count: timeline.length, timeline });
  } catch (err) {
    logger.error('adminDashboardRoutes', `GET /admin/leads/${req.params.crmRecordId}/timeline failed`, err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/leads/summary', requireAdminRole, async (req, res) => {
  try {
    const leads = await getAllLeads(res.locals.catalystApp);
    const summary = summarizeLeadsByStatus(leads);
    res.status(200).json({ success: true, summary });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/leads/summary failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/dealers/performance', requireAdminRole, async (req, res) => {
  try {
    const performance = await getDealerPerformance(res.locals.catalystApp);
    res.status(200).json({ success: true, count: performance.length, performance });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/dealers/performance failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/sync-logs', requireAdminRole, async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const logs = await getSyncLogs(res.locals.catalystApp, { limit });
    res.status(200).json({ success: true, count: logs.length, logs });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/sync-logs failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/dashboard-summary', requireAdminRole, async (req, res) => {
  try {
    const summary = await getDashboardSummary(res.locals.catalystApp);
    res.status(200).json({ success: true, ...summary });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/dashboard-summary failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/dealer-invitations', requireAdminRole, async (req, res) => {
  try {
    const syncedDealers = await getAllDealersWithLeadCounts(res.locals.catalystApp);
    const dealers = syncedDealers
      .filter((d) => d.sync_status !== 'Removed')
      .map((d) => ({
        crmRecordId: d.crm_record_id,
        dealer_code: d.dealer_code,
        dealer_name: d.dealer_name,
        email: d.email_address,
        region: d.region,
      }));

    const withStatus = await getDealerInvitationStatus(res.locals.catalystApp, dealers);
    res.status(200).json({ success: true, count: withStatus.length, dealers: withStatus });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/dealer-invitations failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.delete('/admin/dealers/:dealerCode', requireAdminRole, async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const result = await removeDealerUser(catalystApp, req.params.dealerCode);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'DELETE /admin/dealers/:dealerCode failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.post('/admin/register-webhook', requireAdminRole, async (req, res) => {
  try {
    const { registerWatchChannels } = require('../services/zohoWebhookService');
    const result = await registerWatchChannels(res.locals.catalystApp);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;