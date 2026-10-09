'use strict';

const logger = require('../utils/logger');
const { toCatalystDateTime } = require('../utils/dateFormat');

const DEALERS_TABLE = 'dealers';
const stats = require('./dashboardStatsService');
const { mapWithConcurrency } = require('../utils/concurrency');

const INVITE_SYNC_CONCURRENCY = 5;

const LEADS_TABLE = 'leads';
const SYNC_LOGS_TABLE = 'sync_logs';
const MAPPING_TABLE = 'dealer_user_mapping';
const INTEGRATION_LOGS_TABLE = 'integration_logs'; // NEW — used by getIntegrationLogs / getLeadExchangeHealth below

const ZCQL_PAGE_SIZE = 200; // Catalyst ZCQL's max rows per LIMIT clause

/**
 * adminDashboardService.js
 * -----------------------------------------------------------------------
 * Read-only aggregation layer for Admin/Super Admin views. Queries our
 * own synced Catalyst tables (dealers, leads, sync_logs, integration_logs)
 * — never hits Zoho CRM directly, since that's what /crm/dealers and
 * /sync/* are for. This service is purely about presenting already-synced
 * data.
 *
 * Exception: getDealerInvitationStatus also touches Catalyst's
 * userManagement() to confirm whether an invited dealer has actually
 * completed signup, since dealer_user_mapping alone can't tell us that
 * without checking Catalyst directly.
 */

/**
 * Fetches ALL rows from a Catalyst table via ZCQL, paging with LIMIT
 * offset,count until a page returns fewer rows than requested. A bare
 * `SELECT * FROM table` with no LIMIT silently caps at 100 rows — this
 * previously made every dashboard view (leads, dealers, sync logs, all
 * of them, since they all route through this function) truncate at 100
 * regardless of how many rows the sync itself had correctly inserted.
 */
async function getAllRows(catalystApp, tableName) {
  const allRows = [];
  let offset = 0;

  while (true) {
    // ZCQL's LIMIT offset is effectively 1-based (`LIMIT 0,n` and `LIMIT 1,n`
    // return the same rows), so a plain 0-based offset re-reads the last row of
    // page 1 and makes any table over one page over-count by one. offset + 1 is
    // a true 0-based offset.
    // ORDER BY ROWID gives the pages a stable total order to walk.
    const query = `SELECT * FROM ${tableName} ORDER BY ROWID ASC LIMIT ${offset + 1}, ${ZCQL_PAGE_SIZE}`;
    const result = await catalystApp.zcql().executeZCQLQuery(query);
    const rows = result.map((row) => row[tableName]);
    allRows.push(...rows);

    if (rows.length < ZCQL_PAGE_SIZE) break;
    offset += ZCQL_PAGE_SIZE;
  }

  return allRows;
}

const DEALER_INTEGRATIONS_TABLE = 'dealer_integrations';
const LEAD_INTEGRATIONS_TABLE = 'lead_integrations'; // NEW — used by findDuplicateLeadMappings below

/** Total leads per dealer_code, from the database (COUNT … GROUP BY) — no lead rows are read. */
async function leadCountsByDealerCode(catalystApp) {
  const rows = await stats.leadCountsByDealerAndStatus(catalystApp);
  const totals = {};
  rows.forEach((row) => {
    totals[row.dealer_code] = (totals[row.dealer_code] || 0) + row.count;
  });
  return totals;
}

async function getAllDealersWithLeadCounts(catalystApp) {
  const [dealers, leadCountByDealerCode, integrations] = await Promise.all([
    getAllRows(catalystApp, DEALERS_TABLE),
    leadCountsByDealerCode(catalystApp),
    getAllRows(catalystApp, DEALER_INTEGRATIONS_TABLE),
  ]);

  // dealer_integrations.status carries the real CRM connection state
  // (ACTIVE/CONNECTED/CONFIGURING/ERROR/NOT_CONFIGURED) — separate from
  // dealers.status, which is the Zoho-sync active/inactive/pending flag
  // and always blank for these rows. Exposed as integration_status so
  // the two never collide on the same field name.
  const integrationStatusByDealerCode = {};
  // NEW — dealer_integrations.last_sync_at, so the frontend can show
  // "dealers with no recent successful sync" without a second endpoint.
  const integrationLastSyncByDealerCode = {};
  integrations.forEach((i) => {
    integrationStatusByDealerCode[i.dealer_code] = i.status;
    integrationLastSyncByDealerCode[i.dealer_code] = i.last_sync_at || null;
  });

  return dealers.map((dealer) => ({
    ...dealer,
    lead_count: leadCountByDealerCode[dealer.dealer_code] || 0,
    integration_status: integrationStatusByDealerCode[dealer.dealer_code] || null,
    integration_last_sync_at: integrationLastSyncByDealerCode[dealer.dealer_code] || null, // NEW
  }));
}

async function getAllLeads(catalystApp, { dealerCode, leadStatus } = {}) {
  const leads = await getAllRows(catalystApp, LEADS_TABLE);
  const dealers = await getAllRows(catalystApp, DEALERS_TABLE);

  const dealerNameByCode = {};
  dealers.forEach((d) => { dealerNameByCode[d.dealer_code] = d.dealer_name; });

  // dealer_crm_record_id lives directly on the leads row (mirrored there by
  // crmIntegrationService once the outbound push succeeds, and cleared by
  // dealerReconciliationService if the dealer no longer has the record), so
  // it passes through via the spread below with no join needed.
  let filtered = leads.map((lead) => ({
    ...lead,
    dealer_name: dealerNameByCode[lead.dealer_code] || 'Unknown',
  }));

  if (dealerCode) {
    filtered = filtered.filter((l) => l.dealer_code === dealerCode);
  }
  if (leadStatus) {
    filtered = filtered.filter((l) => l.lead_status === leadStatus);
  }

  return filtered;
}

const LEAD_STATUS_KEYS = {
  'New': 'new',
  'Contacted': 'contacted',
  'Test Drive': 'test_drive',
  'Quotation': 'quotation',
  'Delivered': 'delivered',
  'Lost': 'lost',
};

function summarizeLeadsByStatus(leads) {
  const summary = { total: leads.length, new: 0, contacted: 0, test_drive: 0, quotation: 0, delivered: 0, lost: 0 };
  leads.forEach((lead) => {
    const key = LEAD_STATUS_KEYS[lead.lead_status];
    if (key) summary[key] += 1;
  });
  return summary;
}

/**
 * summarizeLeadsByStatus() for pre-aggregated counts: [{ lead_status, count }].
 * Same result shape, computed from COUNT … GROUP BY output instead of rows.
 */
function summarizeStatusCounts(statusCounts) {
  const summary = { total: 0, new: 0, contacted: 0, test_drive: 0, quotation: 0, delivered: 0, lost: 0 };
  statusCounts.forEach(({ lead_status: status, count }) => {
    summary.total += count;
    const key = LEAD_STATUS_KEYS[status];
    if (key) summary[key] += count;
  });
  return summary;
}

/**
 * Groups leads by their ACTUAL current MG Lead_Status value (see
 * VERIFIED-CRM-FACTS.md / pathPolicyService.js's MG_LEAD_STATUS_VALUES),
 * for the Overview dashboard's "Lead status distribution" donut.
 *
 * Deliberately a SEPARATE function from summarizeLeadsByStatus above —
 * that one's New/Contacted/Test Drive/Quotation/Delivered/Lost buckets
 * are not values Zoho's Lead_Status picklist has ever returned (this
 * register has no "Delivered"/"Test Drive" outcome at all; it tracks
 * enquiry-handling stage, not sale/delivery), so every real lead landed
 * in none of them and the donut rendered as if there were no leads.
 * summarizeLeadsByStatus itself is left untouched: getTopDealers/
 * getDealerPerformance's conversion-rate math, the dealer-side leads
 * summary (dealerLeadRoutes.js), and the AI assistant's dashboard
 * summary prompt (onDemandAiService.js) all depend on its exact shape.
 */
const REAL_STATUS_GROUPS = [
  { key: 'not_contacted', label: 'Not Contacted', statuses: ['Update Pending', 'Not Contacted'] },
  {
    key: 'in_progress',
    label: 'In Progress',
    statuses: ['Follow-up 1', 'Follow-up 2', 'Contacted', 'Attempted to Contact', 'Contact in Future', 'Pre-Qualified'],
  },
  { key: 'not_qualified', label: 'Not Qualified', statuses: ['Not Qualified', 'Dropped'] },
  { key: 'lost', label: 'Lost', statuses: ['Lost', 'Lost Lead'] },
  { key: 'junk', label: 'Junk / Spam', statuses: ['Junk Lead'] },
  { key: 'needs_attention', label: 'Needs Attention', statuses: ['Dealer Unavailable', 'Unattended Alert'] },
];

const REAL_STATUS_KEY_BY_VALUE = REAL_STATUS_GROUPS.reduce((acc, group) => {
  group.statuses.forEach((status) => { acc[status] = group.key; });
  return acc;
}, {});

/**
 * Excludes soft-deleted (sync_status = 'Removed') leads — those aren't
 * part of an active network pipeline view. Every remaining lead lands
 * somewhere: an unrecognised or blank lead_status falls into 'other'
 * rather than being silently dropped, so segment counts always sum to
 * `total` and the donut/legend never quietly under-report.
 */
function summarizeLeadsByRealStatus(leads) {
  const active = leads.filter((lead) => lead.sync_status !== 'Removed');
  const summary = { total: active.length, other: 0 };
  REAL_STATUS_GROUPS.forEach((group) => { summary[group.key] = 0; });

  active.forEach((lead) => {
    const key = REAL_STATUS_KEY_BY_VALUE[lead.lead_status];
    if (key) summary[key] += 1;
    else summary.other += 1;
  });

  return summary;
}

/**
 * summarizeLeadsByRealStatus() for pre-aggregated counts of NON-removed leads:
 * [{ lead_status, count }]. Every lead lands somewhere (unrecognised or blank
 * statuses go to 'other'), so the segments always sum to `total`.
 */
function summarizeRealStatusCounts(activeStatusCounts) {
  const summary = { total: 0, other: 0 };
  REAL_STATUS_GROUPS.forEach((group) => { summary[group.key] = 0; });
  activeStatusCounts.forEach(({ lead_status: status, count }) => {
    summary.total += count;
    const key = REAL_STATUS_KEY_BY_VALUE[status];
    if (key) summary[key] += count;
    else summary.other += count;
  });
  return summary;
}

/** { dealer_code: [{ lead_status, count }] } from dealer × status counts. */
function groupCountsByDealer(dealerStatusCounts) {
  const byDealer = new Map();
  dealerStatusCounts.forEach((row) => {
    if (!byDealer.has(row.dealer_code)) byDealer.set(row.dealer_code, []);
    byDealer.get(row.dealer_code).push({ lead_status: row.lead_status, count: row.count });
  });
  return byDealer;
}

/**
 * Splits dealers by their CRM-synced status field. sync_status
 * 'Removed' means CRM no longer returns this dealer (see
 * dealerSyncService.js's soft-delete pass) — kept separate from the
 * active/inactive/pending status field since a dealer can in principle
 * be 'active' in CRM but already soft-deleted here if the two updates
 * land in different sync runs.
 */
function summarizeDealerStatus(dealers) {
  const summary = { active: 0, inactive: 0, pending: 0, removed: 0, other: 0 };
  dealers.forEach((d) => {
    if (d.sync_status === 'Removed') { summary.removed += 1; return; }
    const status = (d.status || '').toLowerCase();
    if (status === 'active') summary.active += 1;
    else if (status === 'inactive') summary.inactive += 1;
    else if (status === 'pending') summary.pending += 1;
    else summary.other += 1;
  });
  return summary;
}

async function getDealerPerformance(catalystApp) {
  const [dealers, dealerStatusCounts] = await Promise.all([
    getAllRows(catalystApp, DEALERS_TABLE),
    stats.leadCountsByDealerAndStatus(catalystApp),
  ]);
  const countsByDealer = groupCountsByDealer(dealerStatusCounts);

  return dealers.map((dealer) => ({
    dealer_code: dealer.dealer_code,
    dealer_name: dealer.dealer_name,
    region: dealer.region,
    ...summarizeStatusCounts(countsByDealer.get(dealer.dealer_code) || []),
  }));
}

/**
 * Ranks synced (non-removed) dealers by lead volume, tie-broken by
 * delivered-lead conversion rate. No invented "score" — every field
 * here comes straight from summarizeLeadsByStatus on real leads rows.
 * Dealers with zero leads are excluded since there's nothing to rank
 * them on.
 */
function getTopDealers(dealers, leads, limit = 5) {
  const syncedDealers = dealers.filter((d) => d.sync_status !== 'Removed');

  const ranked = syncedDealers.map((dealer) => {
    const dealerLeads = leads.filter((l) => l.dealer_code === dealer.dealer_code);
    const statusSummary = summarizeLeadsByStatus(dealerLeads);
    const conversionRate = statusSummary.total > 0
      ? Math.round((statusSummary.delivered / statusSummary.total) * 100)
      : 0;

    return {
      dealer_code: dealer.dealer_code,
      name: dealer.dealer_name,
      region: dealer.region,
      total_leads: statusSummary.total,
      delivered: statusSummary.delivered,
      conversion_rate: conversionRate,
    };
  });

  return ranked
    .filter((d) => d.total_leads > 0)
    .sort((a, b) => b.total_leads - a.total_leads || b.conversion_rate - a.conversion_rate)
    .slice(0, limit);
}

/**
 * getTopDealers() computed from pre-aggregated dealer × status counts instead
 * of lead rows. Identical ranking and output: synced (non-removed) dealers,
 * most leads first, delivered-lead conversion rate as the tie-break, dealers
 * with no leads excluded.
 */
function getTopDealersFromCounts(dealers, dealerStatusCounts, limit = 5) {
  const countsByDealer = groupCountsByDealer(dealerStatusCounts);

  return dealers
    .filter((d) => d.sync_status !== 'Removed')
    .map((dealer) => {
      const statusSummary = summarizeStatusCounts(countsByDealer.get(dealer.dealer_code) || []);
      return {
        dealer_code: dealer.dealer_code,
        name: dealer.dealer_name,
        region: dealer.region,
        total_leads: statusSummary.total,
        delivered: statusSummary.delivered,
        conversion_rate: statusSummary.total > 0 ? Math.round((statusSummary.delivered / statusSummary.total) * 100) : 0,
      };
    })
    .filter((d) => d.total_leads > 0)
    .sort((a, b) => b.total_leads - a.total_leads || b.conversion_rate - a.conversion_rate)
    .slice(0, limit);
}

/**
 * Real activity feed built only from sync_logs. Deliberately does NOT
 * synthesize lead-status-change events ("lead marked delivered", "new
 * dealer onboarded") — the leads/dealers tables have no updated_at or
 * status-history column, so there's no truthful way to reconstruct
 * when those actually happened. If per-lead/per-dealer event history
 * is wanted later, that needs an audit column or trigger on those
 * tables; don't extend this function to guess timestamps in the
 * meantime.
 */
function buildActivityTimeline(syncLogs, limit = 8) {
  return [...syncLogs]
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    .slice(0, limit)
    .map((log) => ({
      icon: log.sync_type?.toLowerCase().includes('dealer') ? 'building' : 'car',
      tone: log.status === 'Success' ? 'success' : log.status === 'Partial' ? 'warning' : 'danger',
      title: `${log.sync_type || 'Sync'} — ${log.status}`,
      meta: `${log.sync_trigger || 'System'} · ${log.total_records_fetched || 0} fetched, ${log.records_failed || 0} failed`,
      time: log.start_time,
    }));
}

async function getSyncLogs(catalystApp, { limit = 50 } = {}) {
  // Newest-first by start_time, read as a bounded page — never the whole table.
  return stats.recentSyncLogs(catalystApp, limit);
}

/** Overall lead counts by status bucket — backs GET /admin/leads/summary. */
async function getLeadStatusSummary(catalystApp) {
  return summarizeStatusCounts(await stats.leadCountsByStatus(catalystApp));
}

const ACTIVITY_TIMELINE_LIMIT = 8;
const RECENT_SYNC_LOG_LIMIT = 5;

async function getDashboardSummary(catalystApp) {
  // Every figure below is a database-side COUNT / GROUP BY (or a bounded
  // "newest N" read), so this costs the same at 1,000 leads or 1,000,000.
  const [dealers, dealerStatusCounts, activeStatusCounts, syncLogs] = await Promise.all([
    getAllRows(catalystApp, DEALERS_TABLE),
    stats.leadCountsByDealerAndStatus(catalystApp),
    stats.leadCountsByStatus(catalystApp, { excludeRemoved: true }),
    stats.recentSyncLogs(catalystApp, Math.max(ACTIVITY_TIMELINE_LIMIT, RECENT_SYNC_LOG_LIMIT)),
  ]);

  // All leads by status, summed across dealers (a lead with no dealer is still a lead).
  const statusTotals = new Map();
  dealerStatusCounts.forEach(({ lead_status: status, count }) => {
    statusTotals.set(status, (statusTotals.get(status) || 0) + count);
  });
  const leadStatusSummary = summarizeStatusCounts(
    [...statusTotals.entries()].map(([lead_status, count]) => ({ lead_status, count }))
  );

  const recentSyncLogs = [...syncLogs]
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    .slice(0, RECENT_SYNC_LOG_LIMIT);

  return {
    totalDealers: dealers.length,
    totalLeads: leadStatusSummary.total,
    leadStatusSummary,
    leadStatusBreakdown: summarizeRealStatusCounts(activeStatusCounts), // NEW — backs the Overview donut
    dealerStatusSummary: summarizeDealerStatus(dealers),
    topDealers: getTopDealersFromCounts(dealers, dealerStatusCounts),
    activityTimeline: buildActivityTimeline(syncLogs, ACTIVITY_TIMELINE_LIMIT),
    recentSyncLogs,
  };
}

/**
 * Checks a single 'Invited' mapping row against Catalyst's own user
 * record and flips it to 'Active' in dealer_user_mapping once the user
 * has actually completed signup. Mutates nothing if the row isn't
 * 'Invited' or the user still hasn't signed up.
 *
 * Two things confirmed against the current Catalyst Node SDK docs
 * (docs.catalyst.zoho.com — Authentication → Get User Details) that
 * were previously wrong here:
 *
 * 1. getUserDetails()'s resolved object is FLAT — status, is_confirmed,
 *    email_id, user_id etc. sit directly on the response. There is no
 *    nested `user_details` key on this call (that nesting only exists
 *    on registerUser()'s response shape). Reading
 *    `userDetails.user_details.status` was therefore always undefined.
 *
 * 2. `status` is not the right field anyway — Catalyst's own sample
 *    response shows a freshly-invited, still-UNCONFIRMED user already
 *    has `status: "ACTIVE"` alongside `is_confirmed: false`. `status`
 *    tracks account enablement, not signup completion. The field that
 *    matches the Console's "Confirm: Yes/No" column — and what we
 *    actually want here — is `is_confirmed`.
 */
async function syncInviteStatus(catalystApp, mappingRow) {
  if (mappingRow.invite_status !== 'Invited') return mappingRow;

  try {
    const userManagement = catalystApp.userManagement();
    const userDetails = await userManagement.getUserDetails(mappingRow.catalyst_user_id);
    const isActive = userDetails?.is_confirmed === true;

    if (isActive) {
      const table = catalystApp.datastore().table(MAPPING_TABLE);
      const updated = await table.updateRow({
        ROWID: mappingRow.ROWID,
        invite_status: 'Active',
        activated_at: toCatalystDateTime(),
      });
      return { ...mappingRow, ...updated };
    }
  } catch (err) {
    // Don't fail the whole invitations list over one stale mapping —
    // log it and keep reporting the row as 'Invited'.
    logger.error('adminDashboardService', `syncInviteStatus failed for ${mappingRow.dealer_code}`, err);
  }

  return mappingRow;
}

/**
 * Cross-references CRM's Dealer_Master list against our
 * dealer_user_mapping table, syncing each 'Invited' row's real signup
 * status against Catalyst first. Returns a tri-state invite_status per
 * dealer for the frontend: 'not_invited' | 'invited' | 'active'.
 */
async function getDealerInvitationStatus(catalystApp, crmDealers) {
  const mappingRows = await getAllRows(catalystApp, MAPPING_TABLE);

  // One Catalyst user lookup per invited dealer: a few at a time, not hundreds at once.
  const syncedRows = await mapWithConcurrency(
    mappingRows,
    INVITE_SYNC_CONCURRENCY,
    (row) => syncInviteStatus(catalystApp, row)
  );

  const mappedByDealerCode = new Map();
  syncedRows.forEach((row) => mappedByDealerCode.set(row.dealer_code, row));

  return crmDealers.map((dealer) => {
    const mapping = mappedByDealerCode.get(dealer.dealer_code);
    let invite_status = 'not_invited';
    if (mapping?.invite_status === 'Active') invite_status = 'active';
    else if (mapping?.invite_status === 'Invited') invite_status = 'invited';

    return {
      ...dealer,
      invite_status,
      dealer_email: mapping?.dealer_email || null,
      invited_at: mapping?.invited_at || null,
      activated_at: mapping?.activated_at || null,
    };
  });
}

/* ========================================================================
 * NEW — Lead Exchange Health / Middleware Monitoring Dashboard support.
 * Everything below is additive: no existing function above this line was
 * changed in behaviour (only getAllDealersWithLeadCounts gained the two
 * extra `integration_last_sync_at`/read-only fields above).
 * ========================================================================
 */

// Catalyst's CREATEDTIME is in the project timezone (Asia/Kolkata,
// Console > Settings > General) — same fact already relied on by
// dealerReconciliationService.js's parseSystemTimestamp. Reproduced
// locally here rather than importing that module, to keep this
// read-only reporting file independent of the integration pipeline.
function toDateOnly(value) {
  const raw = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function safeQuoteForZcqlLocal(value) {
  return String(value).replace(/'/g, "''");
}

/** Chunked crm_record_id -> customer_name lookup, for readable error rows. */
async function fetchLeadNamesByIds(catalystApp, crmRecordIds) {
  const map = new Map();
  const ids = [...new Set(crmRecordIds)].filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map((id) => `'${safeQuoteForZcqlLocal(id)}'`).join(',');
    if (!chunk) continue;
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT crm_record_id, customer_name FROM ${LEADS_TABLE} WHERE crm_record_id IN (${chunk})`
    );
    rows.forEach((r) => map.set(r[LEADS_TABLE].crm_record_id, r[LEADS_TABLE].customer_name));
  }
  return map;
}

/** Chunked dealer_code -> dealer_name lookup, for readable error rows. */
async function fetchDealerNamesByCodes(catalystApp, dealerCodes) {
  const map = new Map();
  const codes = [...new Set(dealerCodes)].filter(Boolean);
  for (let i = 0; i < codes.length; i += 50) {
    const chunk = codes.slice(i, i + 50).map((c) => `'${safeQuoteForZcqlLocal(c)}'`).join(',');
    if (!chunk) continue;
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT dealer_code, dealer_name FROM ${DEALERS_TABLE} WHERE dealer_code IN (${chunk})`
    );
    rows.forEach((r) => map.set(r[DEALERS_TABLE].dealer_code, r[DEALERS_TABLE].dealer_name));
  }
  return map;
}

/**
 * Paginated, filterable Integration Error report — GET /admin/integration-logs.
 * Every row is a real integration_logs entry; nothing here is synthesized.
 */
async function getIntegrationLogs(catalystApp, {
  fromDate, toDate, dealerCode, scenarioCode, status, integration, page = 1, pageSize = 25,
} = {}) {
  const pageNum = Math.max(1, Math.floor(Number(page)) || 1);
  const requestedSize = Math.floor(Number(pageSize));
  const size = requestedSize >= 1 ? Math.min(200, requestedSize) : 25; // junk or non-positive -> default

  // Every filter is applied in the database before any row is fetched, and
  // `total` is a COUNT over the same filters — the complete number of matching
  // events however far back they go, not the size of a capped sample.
  const { rows: pageRows, total } = await stats.integrationLogsPage(
    catalystApp,
    {
      fromDate: toDateOnly(fromDate),
      toDate: toDateOnly(toDate),
      dealerCode,
      scenarioName: scenarioCode,
      status,
      direction: integration,
    },
    { page: pageNum, pageSize: size }
  );

  const [leadNames, dealerNames] = await Promise.all([
    fetchLeadNamesByIds(catalystApp, pageRows.map((r) => r.zoho_lead_id)),
    fetchDealerNamesByCodes(catalystApp, pageRows.map((r) => r.dealer_code)),
  ]);

  const logs = pageRows.map((row) => ({
    ROWID: row.ROWID,
    date: row.CREATEDTIME,
    dealerCode: row.dealer_code || null,
    dealerName: dealerNames.get(row.dealer_code) || null,
    leadId: row.zoho_lead_id || null,
    customerName: leadNames.get(row.zoho_lead_id) || null,
    integration: row.direction || null,
    operation: row.operation || null,
    scenarioCode: row.happy_unhappy_path_name || null,
    scenarioMessage: row.happy_unhappy_path_message || null,
    priority: row.happy_unhappy_path_priority || null,
    // Sensitive values (mobile/email) are already masked at source by
    // pathPolicyService.maskSensitiveValue before ever reaching
    // error_message — nothing further is stripped or added here.
    errorMessage: row.error_message || null,
    status: row.status || null,
  }));

  const totalPages = Math.max(1, Math.ceil(total / size));
  return {
    logs,
    // `logs` is ONE PAGE; `total` is the complete count of matching events.
    total,
    page: pageNum,
    pageSize: size,
    totalPages,
    hasMore: (pageNum - 1) * size + logs.length < total,
    scope: 'page',
    totalIsComplete: true,
    // Kept for existing clients: a count is never capped any more.
    truncated: false,
  };
}

/**
 * Groups integration_logs rows by happy_unhappy_path_name into the
 * counts the Happy/Unhappy Path cards need. `type` is derived from the
 * name prefix, matching the convention already used by
 * pathPolicyService.SCENARIOS and LeadDetailView.jsx.
 */
function summarizeScenarios(logs) {
  const byName = new Map();
  logs.forEach((log) => {
    const name = (log.happy_unhappy_path_name || '').trim();
    if (!name) return;
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        type: /^happy/i.test(name) ? 'happy' : 'unhappy',
        message: log.happy_unhappy_path_message || '',
        count: 0,
        dealers: new Set(),
        lastOccurrence: log.CREATEDTIME,
      });
    }
    const entry = byName.get(name);
    entry.count += 1;
    if (log.dealer_code) entry.dealers.add(log.dealer_code);
    if (String(log.CREATEDTIME) > String(entry.lastOccurrence)) entry.lastOccurrence = log.CREATEDTIME;
  });

  return [...byName.values()]
    .map((entry) => ({
      name: entry.name,
      type: entry.type,
      message: entry.message,
      count: entry.count,
      dealersAffected: entry.dealers.size,
      lastOccurrence: entry.lastOccurrence,
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Duplicate leads (Happy 3). The linked-lead detail (which enquiry
 * linked to which, and the gap in minutes) comes straight from the
 * `duplicate_link` field_changes entry recorded by
 * crmIntegrationService — the same data LeadDetailView.jsx already
 * renders for a single lead's timeline.
 */
function summarizeDuplicates(happy3Logs, totals = {}) {
  const records = happy3Logs.map((log) => {
    let link = null;
    try {
      const changes = JSON.parse(log.field_changes || '[]');
      link = Array.isArray(changes) ? changes.find((c) => c.field === 'duplicate_link') : null;
    } catch (_) {
      // Not every Happy 3 row necessarily carries a parsable field_changes
      // blob (older rows); fall back to the bare log identifiers below.
    }
    return {
      date: log.CREATEDTIME,
      dealerCode: log.dealer_code || null,
      linkedLeadId: link?.to || log.zoho_lead_id || null,
      originalLeadId: link?.from || null,
      gapMinutes: link?.gap_minutes ?? null,
    };
  });
  // `totals` carries the database-side count / distinct-dealer figures when only
  // the newest rows were read; with none supplied they are derived from `records`.
  return {
    total: totals.total ?? records.length,
    dealersAffected: totals.dealersAffected ?? new Set(records.map((r) => r.dealerCode).filter(Boolean)).size,
    recent: records.slice(0, 20),
  };
}

/**
 * SLA section.
 *
 * Breach evidence (Unhappy 10) is 100% real — every row is an actual
 * slaMonitorService.runSlaSweep breach, logged via
 * crmIntegrationService.recordScenario.
 *
 * "Monitored" and "met" are DERIVED, not stored as their own field,
 * because no such column/table currently exists:
 *   monitored = deliveries (Happy 1 + Happy 4) in range — every
 *               successfully delivered lead is exactly what
 *               slaMonitorService.runSlaSweep watches (it sweeps every
 *               lead_integrations row with sync_status = 'SYNCED').
 *   breached  = Unhappy 10 events in range.
 *   met       = monitored - breached (floored at 0).
 * This is a transparent calculation from real events, not an invented
 * number — but it is explicitly an approximation of "on time" rather
 * than a separately recorded fact, so the frontend should not present
 * "met" with the same confidence as "breached".
 *
 * Average/maximum breach duration are parsed out of the breach
 * error_message text ("... SLA age <N> min; ..."), which is the only
 * place that number currently exists — there is no structured duration
 * column on lead_integrations or integration_logs. A row whose message
 * doesn't match the pattern is excluded from the average/max rather
 * than treated as 0.
 */
function summarizeSla(unhappy10Logs, deliveredCount, totalBreaches = unhappy10Logs.length) {
  const durations = [];
  const breaches = unhappy10Logs.map((log) => {
    const match = /SLA age\s+(\d+)\s*min/i.exec(log.error_message || '');
    const minutes = match ? Number(match[1]) : null;
    if (minutes != null) durations.push(minutes);
    return {
      date: log.CREATEDTIME,
      dealerCode: log.dealer_code || null,
      leadId: log.zoho_lead_id || null,
      breachDurationMinutes: minutes,
      detail: log.error_message || null,
    };
  });

  const monitored = deliveredCount;
  const breachedCount = totalBreaches;
  const met = Math.max(0, monitored - breachedCount);

  return {
    monitored,
    met,
    breached: breachedCount,
    breachPercent: monitored > 0 ? Math.round((breachedCount / monitored) * 100) : 0,
    avgBreachMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    maxBreachMinutes: durations.length ? Math.max(...durations) : null,
    recentBreaches: breaches.slice(0, 20),
  };
}

/**
 * getLeadExchangeHealth — the single call the Overview health dashboard
 * uses. Everything is derived from real leads / dealers / integration_logs
 * rows, scoped by the optional date range and dealer filter. See the
 * comment above summarizeSla for the one pair of numbers ("monitored" /
 * "met") that is calculated rather than directly stored — every other
 * field here is a direct count of real rows.
 */
async function getLeadExchangeHealth(catalystApp, { fromDate, toDate, dealerCode } = {}) {
  const from = toDateOnly(fromDate);
  const to = toDateOnly(toDate);
  const filters = { fromDate: from, toDate: to, dealerCode };

  // Lead counts and the Happy/Unhappy path figures are database-side aggregates
  // over the same date range / dealer filter; no lead or log row is read just
  // to be counted.
  const [dealers, leadStatusCounts, scenarios, totalEvents] = await Promise.all([
    getAllRows(catalystApp, DEALERS_TABLE),
    stats.leadCountsByStatus(catalystApp, filters),
    stats.scenarioStats(catalystApp, filters),
    stats.totalLogEvents(catalystApp, filters),
  ]);

  const scenarioBreakdown = scenarios
    .map((entry) => ({
      name: entry.name,
      type: /^happy/i.test(entry.name) ? 'happy' : 'unhappy',
      message: entry.message,
      count: entry.count,
      dealersAffected: entry.dealers.size,
      lastOccurrence: entry.lastOccurrence,
    }))
    .sort((a, b) => b.count - a.count);
  const happyPaths = scenarioBreakdown.filter((s) => s.type === 'happy');
  const unhappyPaths = scenarioBreakdown.filter((s) => s.type === 'unhappy');

  const scenarioNamed = (name) => scenarios.find((entry) => entry.name === name);
  const deliveredCount = ['Happy 1', 'Happy 4'].reduce((sum, name) => sum + (scenarioNamed(name)?.count || 0), 0);

  const duplicateEntry = scenarioNamed('Happy 3');
  const duplicates = summarizeDuplicates(
    duplicateEntry ? await stats.recentScenarioRows(catalystApp, filters, 'Happy 3', 20) : [],
    { total: duplicateEntry?.count || 0, dealersAffected: duplicateEntry?.dealers.size || 0 }
  );

  const breachEntry = scenarioNamed('Unhappy 10');
  const breachRows = breachEntry
    ? await stats.scenarioRows(catalystApp, filters, 'Unhappy 10')
    : { rows: [], truncated: false };
  const sla = summarizeSla(breachRows.rows, deliveredCount, breachEntry?.count || 0);

  // Dealer health, scoped to the same range: a dealer counts as "active
  // in range" when it has at least one SUCCESS integration_logs event
  // (either direction) in the window. Without a date range, this falls
  // back to summarizeDealerStatus's existing active/inactive/pending
  // definition (dealers.status) — no new "inactive" rule is invented
  // for the all-time view since one already exists.
  const scopedDealers = dealerCode ? dealers.filter((d) => d.dealer_code === dealerCode) : dealers;
  let dealerHealth;
  if (from || to) {
    const [activeDealerCodes, errorDealerCodes] = await Promise.all([
      stats.dealersWithLogStatus(catalystApp, filters, 'SUCCESS'),
      stats.dealersWithLogStatus(catalystApp, filters, 'FAILED'),
    ]);
    const nonRemoved = scopedDealers.filter((d) => d.sync_status !== 'Removed');
    dealerHealth = {
      total: nonRemoved.length,
      activeInRange: nonRemoved.filter((d) => activeDealerCodes.has(d.dealer_code)).length,
      noSuccessfulSyncInRange: nonRemoved.filter((d) => !activeDealerCodes.has(d.dealer_code)).length,
      withErrorsInRange: nonRemoved.filter((d) => errorDealerCodes.has(d.dealer_code)).length,
      definitionNote: 'Active = at least one successful integration event in the selected date range.',
    };
  } else {
    const summary = summarizeDealerStatus(scopedDealers);
    dealerHealth = {
      total: summary.active + summary.inactive + summary.pending + summary.other,
      activeInRange: summary.active,
      noSuccessfulSyncInRange: summary.inactive,
      withErrorsInRange: scopedDealers.filter((d) => d.integration_status === 'ERROR').length,
      definitionNote: "No date range selected — showing each dealer's stored active/inactive/pending status.",
    };
  }

  const leadStatusSummary = summarizeStatusCounts(leadStatusCounts);
  const successfulExchanges = happyPaths.reduce((sum, s) => sum + s.count, 0);
  const failedExchanges = unhappyPaths.reduce((sum, s) => sum + s.count, 0);

  return {
    range: { fromDate: from, toDate: to, dealerCode: dealerCode || null },
    leadStatusSummary,
    happyPaths,
    unhappyPaths,
    duplicates,
    sla,
    dealerHealth,
    exchangeHealth: {
      totalEvents,
      successfulExchanges,
      failedExchanges,
      successRate: (successfulExchanges + failedExchanges) > 0
        ? Math.round((successfulExchanges / (successfulExchanges + failedExchanges)) * 100)
        : 0,
    },
    // Only the SLA breach list is read row by row (its average duration is
    // parsed from each row's message); true when that read hit its cap.
    truncated: breachRows.truncated,
  };
}

/**
 * Read-only diagnostic for the 200+ dealer concurrency audit: finds every
 * (integration_id, zoho_lead_id) pair with more than one lead_integrations
 * row. This is the exact "check whether existing records contain
 * duplicates" step required before anyone decides whether a DB-level
 * unique constraint could ever be safely added directly to that table —
 * it does NOT modify any data, and the cross-instance duplicate-creation
 * fix shipped alongside this (outboundSyncClaimService.js) does not
 * itself depend on the answer, since it uses a separate claims table
 * rather than a constraint on lead_integrations. This is purely
 * diagnostic visibility into whatever damage past races may have already
 * caused (e.g. an orphaned second lead on a dealer's CRM with no matching
 * row here, or exactly the two-rows-same-pair signature this detects).
 *
 * Walks the whole table via getIterableRows() (paginates internally)
 * rather than a single ZCQL SELECT — lead_integrations is not expected to
 * be enormous at current scale, and this is a one-off manual check, not a
 * hot path.
 */
async function findDuplicateLeadMappings(catalystApp) {
  const groups = new Map(); // "integrationId:zohoLeadId" -> rows[]
  const table = catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE);

  let totalRows = 0;
  for await (const row of table.getIterableRows()) {
    totalRows += 1;
    const key = `${row.integration_id}:${row.zoho_lead_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicates = [];
  for (const rows of groups.values()) {
    if (rows.length > 1) {
      duplicates.push({
        integrationId: rows[0].integration_id,
        zohoLeadId: rows[0].zoho_lead_id,
        count: rows.length,
        rows: rows.map((r) => ({
          ROWID: r.ROWID,
          externalCrmLeadId: r.external_crm_lead_id || null,
          syncStatus: r.sync_status,
          lastSyncedAt: r.last_synced_at || null,
          lastAttemptedAt: r.last_attempted_at || null,
          createdTime: r.CREATEDTIME,
        })),
      });
    }
  }

  return {
    totalMappingRows: totalRows,
    totalUniqueLeadIntegrationPairs: groups.size,
    duplicateGroupCount: duplicates.length,
    duplicates,
  };
}

module.exports = {
  getAllDealersWithLeadCounts,
  getAllLeads,
  summarizeLeadsByStatus,
  summarizeLeadsByRealStatus,
  summarizeDealerStatus,
  getDealerPerformance,
  getTopDealers,
  getTopDealersFromCounts,
  getLeadStatusSummary,
  summarizeStatusCounts,
  summarizeRealStatusCounts,
  buildActivityTimeline,
  getSyncLogs,
  getDashboardSummary,
  getDealerInvitationStatus,
  getIntegrationLogs, // NEW
  getLeadExchangeHealth, // NEW
  findDuplicateLeadMappings, // NEW
};