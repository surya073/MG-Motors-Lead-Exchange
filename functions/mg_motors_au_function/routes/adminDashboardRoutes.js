'use strict';

const express = require('express');
const { requireAdminRole } = require('../middleware/requireAdminRole');
const { requireAdminOrViewRole } = require('../middleware/requireAdminOrViewRole');
const { requireSuperAdminRole } = require('../middleware/requireSuperAdminRole');
const {
  getAllDealersWithLeadCounts,
  getAllLeads,
  summarizeLeadsByStatus,
  getDealerPerformance,
  getSyncLogs,
  getDashboardSummary,
  getDealerInvitationStatus,
  getIntegrationLogs, // NEW
  getLeadExchangeHealth, // NEW
  findDuplicateLeadMappings, // NEW
} = require('../services/adminDashboardService');
const { fetchDealerMaster } = require('../services/zohoCrmService');
const { removeDealerUser } = require('../services/dealerInviteService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService'); // NEW
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const { withCrmApiLimit } = require('../services/integrations/crmApiConcurrencyLimiter');
const aiAssistantToolService = require('../services/aiAssistantToolService');
const logger = require('../utils/logger');

const router = express.Router();

// requireAdminRole is applied per-route below, NOT via router.use() —
// router.use(requireAdminRole) was found to leak into sibling routers
// mounted at the same '/' path (dealerLeadRoutes), incorrectly blocking
// Dealer-role requests to unrelated routes. This is documented Express
// behavior (see expressjs/express#5753) when multiple routers share a
// mount path — router.use() middleware isn't as isolated as it appears.

// View User needs this only to populate the dealer picker on the
// (view-only) Dealer CRM Config page — every mutating admin route in this
// file stays on requireAdminRole, unchanged.
router.get('/admin/dealers', requireAdminOrViewRole, async (req, res) => {
  try {
    const dealers = await getAllDealersWithLeadCounts(res.locals.catalystApp);
    res.status(200).json({ success: true, count: dealers.length, dealers });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/dealers failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/leads', requireAdminOrViewRole, async (req, res) => {
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

// The panel refreshes every 30s; without a cache each refresh spent up to
// 25 dealer API credits. Dealer-side name/status are display-only, so a
// few minutes' staleness is fine.
const DEALER_DETAIL_TTL_MS = 10 * 60 * 1000;
const dealerDetailCache = new Map();

router.get('/admin/out-of-order-events', requireAdminOrViewRole, async (req, res) => {
  const catalystApp = res.locals.catalystApp;
  try {
    // Core grouping/classification lives in aiAssistantToolService.js so
    // the AI assistant's get_out_of_order_events tool and this route share
    // one implementation — everything below this call is enrichment
    // specific to this route (live dealer-CRM lookups), not duplicated
    // logic.
    const events = await aiAssistantToolService.getOutOfOrderEvents(catalystApp);

    // Live dealer-side context (name, status) for the most recent records.
    const integrations = new Map();
    for (const [key, entry] of dealerDetailCache) {
      if (Date.now() - entry.at >= DEALER_DETAIL_TTL_MS) dealerDetailCache.delete(key);
    }
    await Promise.all(events.slice(0, OUT_OF_ORDER_DETAIL_LIMIT).map(async (event) => {
      const cacheKey = `${event.dealerCode}:${event.externalLeadId}`;
      const cached = dealerDetailCache.get(cacheKey);
      if (cached && Date.now() - cached.at < DEALER_DETAIL_TTL_MS) {
        Object.assign(event, cached.detail);
        return;
      }
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
        const fetched = await withCrmApiLimit(integration.crm_type, () => adapter.getLead(catalystApp, integration, event.externalLeadId));
        const raw = fetched && fetched.raw;
        const record = Array.isArray(raw && raw.data) ? raw.data[0] : raw;
        if (!record || typeof record !== 'object') {
          dealerDetailCache.set(cacheKey, { at: Date.now(), detail: {} });
          return;
        }
        const detail = {
          customerName: record.Full_Name
            || [record.First_Name, record.Last_Name].filter(Boolean).join(' ')
            || record.name
            || null,
          dealerStatus: record.Lead_Status || record.status || null,
        };
        dealerDetailCache.set(cacheKey, { at: Date.now(), detail });
        Object.assign(event, detail);
      } catch (detailErr) {
        dealerDetailCache.set(cacheKey, { at: Date.now(), detail: { dealerRecordMissing: true } });
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
router.get('/admin/leads/:crmRecordId/timeline', requireAdminOrViewRole, async (req, res) => {
  try {
    const { crmRecordId } = req.params;
    const timeline = await crmIntegrationService.getLeadActivityTimeline(res.locals.catalystApp, crmRecordId);
    res.status(200).json({ success: true, count: timeline.length, timeline });
  } catch (err) {
    logger.error('adminDashboardRoutes', `GET /admin/leads/${req.params.crmRecordId}/timeline failed`, err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/leads/summary', requireAdminOrViewRole, async (req, res) => {
  try {
    const leads = await getAllLeads(res.locals.catalystApp);
    const summary = summarizeLeadsByStatus(leads);
    res.status(200).json({ success: true, summary });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/leads/summary failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/dealers/performance', requireAdminOrViewRole, async (req, res) => {
  try {
    const performance = await getDealerPerformance(res.locals.catalystApp);
    res.status(200).json({ success: true, count: performance.length, performance });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/dealers/performance failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/sync-logs', requireAdminOrViewRole, async (req, res) => {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const logs = await getSyncLogs(res.locals.catalystApp, { limit });
    res.status(200).json({ success: true, count: logs.length, logs });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/sync-logs failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/dashboard-summary', requireAdminOrViewRole, async (req, res) => {
  try {
    const summary = await getDashboardSummary(res.locals.catalystApp);
    res.status(200).json({ success: true, ...summary });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/dashboard-summary failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/integration-logs — NEW
 * -----------------------------------------------------------------------
 * Paginated, filterable Integration Error report. Backs the "Integration
 * Errors" table on the Lead Exchange Health dashboard. Query params:
 * fromDate, toDate (YYYY-MM-DD), dealerCode, scenarioCode
 * (happy_unhappy_path_name, e.g. "Unhappy 2"), status (SUCCESS/FAILED),
 * page, pageSize. All optional — with none supplied this returns the
 * most recent integration_logs rows, newest first.
 */
router.get('/admin/integration-logs', requireAdminOrViewRole, async (req, res) => {
  try {
    const { fromDate, toDate, dealerCode, scenarioCode, status, page, pageSize } = req.query;
    const result = await getIntegrationLogs(res.locals.catalystApp, {
      fromDate,
      toDate,
      dealerCode,
      scenarioCode,
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/integration-logs failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/lead-exchange-health — NEW
 * -----------------------------------------------------------------------
 * Single call backing the Happy/Unhappy Path cards, Duplicate Leads, SLA
 * monitoring, Dealer Health and the top health summary cards. Query
 * params: fromDate, toDate (YYYY-MM-DD), dealerCode — all optional; with
 * none supplied this reports across the full integration_logs history
 * (capped — see `truncated` in the response) and all dealers.
 */
router.get('/admin/lead-exchange-health', requireAdminOrViewRole, async (req, res) => {
  try {
    const { fromDate, toDate, dealerCode } = req.query;
    const health = await getLeadExchangeHealth(res.locals.catalystApp, { fromDate, toDate, dealerCode });
    res.status(200).json({ success: true, ...health });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/lead-exchange-health failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.get('/admin/dealer-invitations', requireAdminOrViewRole, async (req, res) => {
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

/**
 * Read-only diagnostic for the 200+ dealer concurrency work — see
 * adminDashboardService.findDuplicateLeadMappings for exactly what this
 * checks and why. Super Admin only: this surfaces internal row IDs and
 * sync bookkeeping, not something every Admin needs for daily work.
 */
router.get('/admin/diagnostics/duplicate-lead-mappings', requireSuperAdminRole, async (req, res) => {
  try {
    const result = await findDuplicateLeadMappings(res.locals.catalystApp);
    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('adminDashboardRoutes', 'GET /admin/diagnostics/duplicate-lead-mappings failed', err);
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