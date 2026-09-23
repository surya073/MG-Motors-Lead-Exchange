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
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
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
 * GET /admin/out-of-order-events
 * -----------------------------------------------------------------------
 * Unhappy 7 visibility. A dealer update that arrives before its MG
 * enquiry is linked has no MG lead, so it can never appear in
 * /admin/leads. This lists those held dealer records (one row per dealer
 * record) with their state — Held, Expired or Released — so the Lead
 * Exchange screen can show them. Read-only; the dealer-side name and
 * status are fetched live for display and never stored.
 */
const OUT_OF_ORDER_DETAIL_LIMIT = 25;

router.get('/admin/out-of-order-events', requireAdminRole, async (req, res) => {
  const catalystApp = res.locals.catalystApp;
  try {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      "SELECT * FROM integration_logs WHERE happy_unhappy_path_name = 'Unhappy 7' ORDER BY CREATEDTIME DESC LIMIT 0, 200"
    );

    const groups = new Map();
    rows.forEach((wrapped) => {
      const log = wrapped.integration_logs;
      if (!log.external_lead_id) return;
      const key = `${log.integration_id || log.dealer_code}:${log.external_lead_id}`;
      if (!groups.has(key)) {
        groups.set(key, {
          dealerCode: log.dealer_code,
          integrationId: log.integration_id,
          externalLeadId: log.external_lead_id,
          zohoLeadId: log.zoho_lead_id || null,
          logs: [],
        });
      }
      groups.get(key).logs.push(log);
    });

    const events = [...groups.values()].map((group) => {
      const statuses = group.logs.map((log) => log.status);
      const held = group.logs.filter((log) => log.error_message === 'LEAD_MAPPING_NOT_FOUND');
      const expiry = group.logs.find((log) => String(log.error_message || '').startsWith('OUT_OF_ORDER_EXPIRED'));
      let state = 'HELD';
      if (statuses.includes('RECOVERED')) state = 'RELEASED';
      else if (expiry || statuses.includes('EXPIRED')) state = 'EXPIRED';
      const heldSince = held.map((log) => log.CREATEDTIME).sort()[0] || group.logs[group.logs.length - 1].CREATEDTIME;
      return {
        dealerCode: group.dealerCode,
        externalLeadId: group.externalLeadId,
        zohoLeadId: group.zohoLeadId,
        state,
        heldSince,
        expiredAt: expiry ? expiry.CREATEDTIME : null,
        heldEvents: held.length,
        reason: expiry
          ? String(expiry.error_message).replace(/^OUT_OF_ORDER_EXPIRED:\s*/, '')
          : 'Dealer update arrived before its MG enquiry was linked; held for replay.',
        integrationId: group.integrationId,
      };
    });

    // Live dealer-side context (name, status) for the most recent records.
    const integrations = new Map();
    await Promise.all(events.slice(0, OUT_OF_ORDER_DETAIL_LIMIT).map(async (event) => {
      try {
        if (!integrations.has(event.dealerCode)) {
          integrations.set(
            event.dealerCode,
            crmIntegrationService.getIntegrationByDealerCode(catalystApp, event.dealerCode)
          );
        }
        const integration = await integrations.get(event.dealerCode);
        if (!integration) return;
        const adapter = crmAdapterFactory.getAdapter(integration.crm_type);
        const fetched = await adapter.getLead(catalystApp, integration, event.externalLeadId);
        const raw = fetched && fetched.raw;
        const record = Array.isArray(raw && raw.data) ? raw.data[0] : raw;
        if (!record || typeof record !== 'object') return;
        event.customerName = record.Full_Name
          || [record.First_Name, record.Last_Name].filter(Boolean).join(' ')
          || record.name
          || null;
        event.dealerStatus = record.Lead_Status || record.status || null;
      } catch (detailErr) {
        event.dealerRecordMissing = true;
      }
    }));

    events.forEach((event) => { delete event.integrationId; });
    res.status(200).json({ success: true, count: events.length, events });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/out-of-order-events failed', err);
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