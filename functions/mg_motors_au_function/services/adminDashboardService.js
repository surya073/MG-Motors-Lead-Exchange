'use strict';

const logger = require('../utils/logger');
const { toCatalystDateTime } = require('../utils/dateFormat');

const DEALERS_TABLE = 'dealers';
const LEADS_TABLE = 'leads';
const SYNC_LOGS_TABLE = 'sync_logs';
const MAPPING_TABLE = 'dealer_user_mapping';

const ZCQL_PAGE_SIZE = 200; // Catalyst ZCQL's max rows per LIMIT clause

/**
 * adminDashboardService.js
 * -----------------------------------------------------------------------
 * Read-only aggregation layer for Admin/Super Admin views. Queries our
 * own synced Catalyst tables (dealers, leads, sync_logs) — never hits
 * Zoho CRM directly, since that's what /crm/dealers and /sync/* are for.
 * This service is purely about presenting already-synced data.
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
    const query = `SELECT * FROM ${tableName} LIMIT ${offset}, ${ZCQL_PAGE_SIZE}`;
    const result = await catalystApp.zcql().executeZCQLQuery(query);
    const rows = result.map((row) => row[tableName]);
    allRows.push(...rows);

    if (rows.length < ZCQL_PAGE_SIZE) break;
    offset += ZCQL_PAGE_SIZE;
  }

  return allRows;
}

async function getAllDealersWithLeadCounts(catalystApp) {
  const dealers = await getAllRows(catalystApp, DEALERS_TABLE);
  const leads = await getAllRows(catalystApp, LEADS_TABLE);

  const leadCountByDealerCode = {};
  leads.forEach((lead) => {
    const code = lead.dealer_code;
    leadCountByDealerCode[code] = (leadCountByDealerCode[code] || 0) + 1;
  });

  return dealers.map((dealer) => ({
    ...dealer,
    lead_count: leadCountByDealerCode[dealer.dealer_code] || 0,
  }));
}

async function getAllLeads(catalystApp, { dealerCode, leadStatus } = {}) {
  const leads = await getAllRows(catalystApp, LEADS_TABLE);
  const dealers = await getAllRows(catalystApp, DEALERS_TABLE);

  const dealerNameByCode = {};
  dealers.forEach((d) => { dealerNameByCode[d.dealer_code] = d.dealer_name; });

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
  const dealers = await getAllRows(catalystApp, DEALERS_TABLE);
  const leads = await getAllRows(catalystApp, LEADS_TABLE);

  return dealers.map((dealer) => {
    const dealerLeads = leads.filter((l) => l.dealer_code === dealer.dealer_code);
    return {
      dealer_code: dealer.dealer_code,
      dealer_name: dealer.dealer_name,
      region: dealer.region,
      ...summarizeLeadsByStatus(dealerLeads),
    };
  });
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
  const logs = await getAllRows(catalystApp, SYNC_LOGS_TABLE);
  return logs
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    .slice(0, limit);
}

async function getDashboardSummary(catalystApp) {
  const [dealers, leads, syncLogs] = await Promise.all([
    getAllRows(catalystApp, DEALERS_TABLE),
    getAllRows(catalystApp, LEADS_TABLE),
    getAllRows(catalystApp, SYNC_LOGS_TABLE),
  ]);

  const recentSyncLogs = syncLogs
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))
    .slice(0, 5);

  return {
    totalDealers: dealers.length,
    totalLeads: leads.length,
    leadStatusSummary: summarizeLeadsByStatus(leads),
    dealerStatusSummary: summarizeDealerStatus(dealers),
    topDealers: getTopDealers(dealers, leads),
    activityTimeline: buildActivityTimeline(syncLogs),
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

  const syncedRows = await Promise.all(
    mappingRows.map((row) => syncInviteStatus(catalystApp, row))
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

module.exports = {
  getAllDealersWithLeadCounts,
  getAllLeads,
  summarizeLeadsByStatus,
  summarizeDealerStatus,
  getDealerPerformance,
  getTopDealers,
  buildActivityTimeline,
  getSyncLogs,
  getDashboardSummary,
  getDealerInvitationStatus,
};