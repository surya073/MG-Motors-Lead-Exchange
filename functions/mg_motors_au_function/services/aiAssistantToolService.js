'use strict';

const adminDashboardService = require('./adminDashboardService');
const crmIntegrationService = require('./integrations/crmIntegrationService');
const leadAccessService = require('./leadAccessService');
const pathPolicyService = require('./integrations/pathPolicyService');

/**
 * aiAssistantToolService.js
 * -----------------------------------------------------------------------
 * The AI assistant's data-access layer (used by routes/aiAssistantRoutes.js
 * as the "tools" Gemini can call). Every function here composes EXISTING
 * services — adminDashboardService (dealers/leads/health aggregation),
 * crmIntegrationService (lead sync timeline), leadAccessService (dealer
 * session scoping), pathPolicyService (canonical Happy/Unhappy scenario
 * definitions) — the same real data every dashboard page already reads.
 * Nothing here talks to a datastore table directly except
 * getOutOfOrderEvents, which mirrors adminDashboardRoutes.js's own
 * GET /admin/out-of-order-events grouping logic (moved here so the route
 * and this tool share one implementation) MINUS that route's live
 * dealer-CRM enrichment step, which stays in the route: it makes real
 * external CRM API calls per event, so it should not risk running
 * repeatedly inside a Gemini tool-calling loop.
 *
 * Every returned shape is deliberately business-level only (customer
 * name, status, dealer name, timestamps) — never raw table rows, never
 * credentials/tokens. Result lists are capped the same way the rest of
 * the dashboard already caps them, to keep Gemini's context bounded.
 */

const PROJECT_UTC_OFFSET_MINUTES = 5 * 60 + 30; // Asia/Kolkata — matches adminDashboardService.js's PROJECT_UTC_OFFSET

function projectDateNow() {
  return new Date(Date.now() + PROJECT_UTC_OFFSET_MINUTES * 60 * 1000);
}

function toDateOnlyString(d) {
  return d.toISOString().slice(0, 10);
}

function todayRange() {
  const today = toDateOnlyString(projectDateNow());
  return { fromDate: today, toDate: today };
}

function yesterdayRange() {
  const d = projectDateNow();
  d.setUTCDate(d.getUTCDate() - 1);
  const y = toDateOnlyString(d);
  return { fromDate: y, toDate: y };
}

function thisWeekRange() {
  const now = projectDateNow();
  const start = new Date(now);
  start.setUTCDate(now.getUTCDate() - now.getUTCDay()); // week starts Sunday
  return { fromDate: toDateOnlyString(start), toDate: toDateOnlyString(now) };
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function monthRange(monthName, year) {
  const idx = MONTH_NAMES.indexOf(String(monthName || '').toLowerCase());
  if (idx === -1) return null;
  const y = year || projectDateNow().getUTCFullYear();
  const lastDay = new Date(Date.UTC(y, idx + 1, 0)).getUTCDate();
  return {
    fromDate: `${y}-${String(idx + 1).padStart(2, '0')}-01`,
    toDate: `${y}-${String(idx + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Resolves free-text like "today" / "yesterday" / "this week" / "September" into a {fromDate, toDate} range, or null if not a recognized date phrase. */
function resolveWhen(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'today') return todayRange();
  if (t === 'yesterday') return yesterdayRange();
  if (t === 'this week' || t === 'week') return thisWeekRange();
  const monthMatch = MONTH_NAMES.find((m) => t.includes(m));
  return monthMatch ? monthRange(monthMatch) : null;
}

/** Normalizes "unhappy7" / "Unhappy 7" / "UNHAPPY-7" to the canonical "Unhappy 7" and validates it against the real scenario register — never lets Gemini invent a scenario code. */
function resolveScenarioCode(text) {
  const match = /^(happy|unhappy)\s*-?\s*(\d+)$/i.exec(String(text || '').trim());
  if (!match) return null;
  const code = `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${Number(match[2])}`;
  const configured = pathPolicyService.SCENARIOS[code];
  return configured ? { code, ...configured } : null;
}

function toCompactLead(lead) {
  return {
    leadId: lead.ROWID,
    customerName: lead.customer_name,
    dealerCode: lead.dealer_code,
    dealerName: lead.dealer_name || null,
    leadStatus: lead.lead_status,
    syncStatus: lead.sync_status,
    scenario: lead.happy_unhappy_path_name || null,
    vehicleModel: lead.vehicle_model || null,
    leadSource: lead.lead_source || null,
    createdAt: lead.CREATEDTIME,
    lastSyncedAt: lead.last_synced_at || null,
  };
}

/** Case-insensitive match against the real dealers table by name OR code. Returns {dealer, candidates} — dealer is set on a unique match, candidates lists ambiguous matches (never guesses between them). */
async function resolveDealerByNameOrCode(catalystApp, text) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return { dealer: null, candidates: [] };

  const dealers = await adminDashboardService.getAllDealersWithLeadCounts(catalystApp);
  const exactCode = dealers.find((d) => (d.dealer_code || '').toLowerCase() === needle);
  if (exactCode) return { dealer: exactCode, candidates: [] };

  const matches = dealers.filter((d) =>
    (d.dealer_name || '').toLowerCase().includes(needle) || (d.dealer_code || '').toLowerCase().includes(needle)
  );
  if (matches.length === 1) return { dealer: matches[0], candidates: [] };
  if (matches.length > 1) return { dealer: null, candidates: matches.slice(0, 10) };
  return { dealer: null, candidates: [] };
}

function ambiguousDealerError(text, candidates) {
  return { error: `Multiple dealers match "${text}": ${candidates.map((d) => `${d.dealer_name} (${d.dealer_code})`).join(', ')}. Which one did you mean?` };
}

async function getDashboardSummary(catalystApp) {
  return adminDashboardService.getDashboardSummary(catalystApp);
}

async function getDealers(catalystApp, search = '') {
  const dealers = await adminDashboardService.getAllDealersWithLeadCounts(catalystApp);
  const q = String(search || '').trim().toLowerCase();
  const filtered = q
    ? dealers.filter((d) => [d.dealer_name, d.region, d.status, d.dealer_code].filter(Boolean).some((f) => String(f).toLowerCase().includes(q)))
    : dealers;
  // Gemini's function_response field must be a JSON object, never a bare
  // array — wrapping in { dealers: [...] } instead of returning the array
  // directly.
  return {
    count: filtered.length,
    dealers: filtered.slice(0, 25).map((d) => ({
      dealerCode: d.dealer_code,
      dealerName: d.dealer_name,
      region: d.region,
      status: d.status,
      leadCount: d.lead_count,
      integrationStatus: d.integration_status,
      lastSyncAt: d.integration_last_sync_at,
    })),
  };
}

async function getDealerDetail(catalystApp, dealerNameOrCode) {
  const { dealer, candidates } = await resolveDealerByNameOrCode(catalystApp, dealerNameOrCode);
  if (!dealer) return candidates.length ? ambiguousDealerError(dealerNameOrCode, candidates) : { error: `No dealer found matching "${dealerNameOrCode}".` };

  const leads = await adminDashboardService.getAllLeads(catalystApp, { dealerCode: dealer.dealer_code });
  return {
    dealerCode: dealer.dealer_code,
    dealerName: dealer.dealer_name,
    region: dealer.region,
    status: dealer.status,
    integrationStatus: dealer.integration_status,
    lastSyncAt: dealer.integration_last_sync_at,
    leadCount: leads.length,
    statusBreakdown: adminDashboardService.summarizeLeadsByRealStatus(leads),
  };
}

async function getDealerLeads(catalystApp, dealerNameOrCode, { leadStatus } = {}) {
  const { dealer, candidates } = await resolveDealerByNameOrCode(catalystApp, dealerNameOrCode);
  if (!dealer) return candidates.length ? ambiguousDealerError(dealerNameOrCode, candidates) : { error: `No dealer found matching "${dealerNameOrCode}".` };

  const leads = await adminDashboardService.getAllLeads(catalystApp, { dealerCode: dealer.dealer_code, leadStatus });
  return { dealerCode: dealer.dealer_code, dealerName: dealer.dealer_name, count: leads.length, leads: leads.slice(0, 30).map(toCompactLead) };
}

/**
 * The single richest tool: wraps adminDashboardService.getLeadExchangeHealth
 * (already aggregates Happy/Unhappy counts, duplicates, SLA, and dealer
 * health from real integration_logs). Accepts a dealer by name OR code, and
 * either explicit fromDate/toDate or a free-text `when` ("today",
 * "yesterday", "this week", a month name). If scenarioCode is given, narrows
 * the response to that one scenario's count/detail instead of the full
 * breakdown.
 */
async function getHappyUnhappySummary(catalystApp, { fromDate, toDate, dealerCode, dealerName, when, scenarioCode } = {}) {
  let resolvedDealerCode = dealerCode || null;
  if (!resolvedDealerCode && dealerName) {
    const { dealer, candidates } = await resolveDealerByNameOrCode(catalystApp, dealerName);
    if (!dealer) return candidates.length ? ambiguousDealerError(dealerName, candidates) : { error: `No dealer found matching "${dealerName}".` };
    resolvedDealerCode = dealer.dealer_code;
  }

  let range = { fromDate, toDate };
  if (!fromDate && !toDate && when) {
    range = resolveWhen(when) || range;
  }

  const health = await adminDashboardService.getLeadExchangeHealth(catalystApp, { ...range, dealerCode: resolvedDealerCode });

  if (!scenarioCode) return health;

  const normalized = resolveScenarioCode(scenarioCode);
  if (!normalized) return { error: `"${scenarioCode}" isn't a recognized Happy/Unhappy path.` };
  const match = [...health.happyPaths, ...health.unhappyPaths].find((s) => s.name === normalized.code);
  return {
    range: health.range,
    scenario: match || { name: normalized.code, type: normalized.type, message: normalized.message, count: 0, dealersAffected: 0, lastOccurrence: null },
  };
}

async function getDuplicateLeads(catalystApp, filters = {}) {
  const health = await getHappyUnhappySummary(catalystApp, filters);
  return health.error ? health : health.duplicates;
}

/** Live leads currently sitting in SLA_BREACH state — complements getHappyUnhappySummary's .sla, which is historical breach EVENTS, not current state. */
async function getLiveSlaBreachLeads(catalystApp, dealerCode = null) {
  const leads = await adminDashboardService.getAllLeads(catalystApp, dealerCode ? { dealerCode } : {});
  const breached = leads.filter((l) => l.sync_status === 'SLA_BREACH');
  return { count: breached.length, leads: breached.slice(0, 30).map(toCompactLead) };
}

async function getSlaBreaches(catalystApp, filters = {}) {
  const health = await getHappyUnhappySummary(catalystApp, filters);
  if (health.error) return health;
  const currentlyBreached = await getLiveSlaBreachLeads(catalystApp, health.range?.dealerCode || filters.dealerCode || null);
  return { historical: health.sla, currentlyBreached };
}

async function getIntegrationLogs(catalystApp, filters = {}) {
  return adminDashboardService.getIntegrationLogs(catalystApp, filters);
}

/**
 * Unhappy 7 (out-of-order events), grouped identically to
 * adminDashboardRoutes.js's GET /admin/out-of-order-events — kept in sync
 * with that route by having it call this same function, then layer its
 * own live dealer-CRM enrichment on top (not duplicated here; see file
 * header).
 */
async function getOutOfOrderEvents(catalystApp, { limit = 200 } = {}) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM integration_logs WHERE happy_unhappy_path_name = 'Unhappy 7' ORDER BY CREATEDTIME DESC LIMIT 0, ${Number(limit) || 200}`
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

  return [...groups.values()].map((group) => {
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
}

/**
 * Finds one lead by ROWID, crm_record_id, or a customer-name substring
 * (optionally scoped to one dealer, for the dealer role), then merges in
 * its sync/integration timeline. No dedicated single-lead endpoint exists
 * elsewhere — this composes the same two pieces LeadDetailView.jsx uses
 * separately (a leads-list row + getLeadActivityTimeline).
 */
async function getLeadDetailByIdentifier(catalystApp, identifier, { dealerCodeScope } = {}) {
  const needle = String(identifier || '').trim();
  if (!needle) return { error: 'No lead identifier given.' };

  const leads = await adminDashboardService.getAllLeads(catalystApp, dealerCodeScope ? { dealerCode: dealerCodeScope } : {});

  let lead = leads.find((l) => String(l.ROWID) === needle || l.crm_record_id === needle);
  if (!lead) {
    const lowerNeedle = needle.toLowerCase();
    const matches = leads.filter((l) => (l.customer_name || '').toLowerCase().includes(lowerNeedle));
    if (matches.length === 1) lead = matches[0];
    else if (matches.length > 1) {
      return { error: `Multiple leads match "${identifier}": ${matches.slice(0, 10).map((l) => `${l.customer_name} (${l.dealer_name})`).join(', ')}. Can you be more specific?` };
    }
  }

  if (!lead) return { error: `No lead found matching "${identifier}".` };
  if (dealerCodeScope && lead.dealer_code !== dealerCodeScope) {
    return { error: 'That lead does not belong to your dealership.' };
  }

  const timeline = lead.crm_record_id ? await crmIntegrationService.getLeadActivityTimeline(catalystApp, lead.crm_record_id) : [];

  return {
    ...toCompactLead(lead),
    dealerRemarks: lead.dealer_remarks || null,
    nextFollowupDate: lead.next_followup_date || null,
    timeline: timeline.slice(-15).map((t) => ({
      date: t.created_at,
      direction: t.direction || null,
      operation: t.operation || null,
      status: t.status || null,
      scenario: t.happy_unhappy_path_name || null,
      message: t.happy_unhappy_path_message || null,
      error: t.error_message || null,
    })),
  };
}

async function resolveDealerCodeForUser(catalystApp, catalystUserId) {
  return leadAccessService.resolveDealerCodeForUser(catalystApp, catalystUserId);
}

async function getMyLeads(catalystApp, dealerCode, { leadStatus } = {}) {
  // One page of 30 plus an exact total, both restricted to this dealer in the
  // database — not "every lead, then filter" (which also stopped at 100 rows).
  const { leads, pagination } = await leadAccessService.getDealerLeadsPage(catalystApp, dealerCode, {
    status: leadStatus,
    page: 1,
    pageSize: 30,
  });
  return { count: pagination.total, leads: leads.map(toCompactLead) };
}

module.exports = {
  // pure helpers — exported for unit testing
  todayRange,
  yesterdayRange,
  thisWeekRange,
  monthRange,
  resolveWhen,
  resolveScenarioCode,

  // tool functions
  getDashboardSummary,
  getDealers,
  getDealerDetail,
  resolveDealerByNameOrCode,
  getDealerLeads,
  getHappyUnhappySummary,
  getDuplicateLeads,
  getSlaBreaches,
  getLiveSlaBreachLeads,
  getIntegrationLogs,
  getOutOfOrderEvents,
  getLeadDetailByIdentifier,
  resolveDealerCodeForUser,
  getMyLeads,
};
