'use strict';

const LEADS_TABLE = 'leads';
const MAPPING_TABLE = 'dealer_user_mapping';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const ZCQL_MAX_ROWS = 300; // ZCQL rejects a LIMIT above this
// Safety bound for the "give me every lead" call (see getAllLeadsForDealer).
const MAX_FULL_LIST_ROWS = 5000;

/**
 * ZCQL's LIMIT offset is effectively 1-based (`LIMIT 0,n` and `LIMIT 1,n`
 * return the same rows), so paging with a plain 0-based offset repeats a row
 * at the top of page 2. `offset + 1` is a true 0-based offset.
 */
const zcqlOffset = (offset) => offset + 1;

function quote(value) {
  return String(value ?? '').replace(/'/g, "''");
}

/**
 * leadAccessService.js
 * -----------------------------------------------------------------------
 * Enforces "never expose one dealer's leads to another dealer" at the
 * server layer. dealer_code is ALWAYS resolved server-side from the
 * logged-in user's session via dealer_user_mapping — never accepted
 * from the client, which would let a dealer simply pass a different
 * dealer_code and see someone else's data.
 */

async function resolveDealerCodeForUser(catalystApp, catalystUserId) {
  const safeId = String(catalystUserId).replace(/'/g, "''");
  const query = `SELECT * FROM ${MAPPING_TABLE} WHERE catalyst_user_id = '${safeId}' LIMIT 1`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  if (!result || result.length === 0) return null;
  return result[0][MAPPING_TABLE].dealer_code || null;
}

/**
 * Returns all Catalyst user_ids mapped to the given dealer_code — a
 * dealership can have more than one login (e.g. sales manager + staff),
 * so this returns an array, not a single id. Used by leadSyncService to
 * notify every user linked to a dealer when that dealer gets a new lead.
 */
async function resolveUsersForDealerCode(catalystApp, dealerCode) {
  const safeCode = String(dealerCode).replace(/'/g, "''");
  const query = `SELECT * FROM ${MAPPING_TABLE} WHERE dealer_code = '${safeCode}'`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  return result.map((row) => row[MAPPING_TABLE].catalyst_user_id).filter(Boolean);
}

/**
 * Every dealer-lead query is built from a dealer_code that the caller took
 * from the authenticated session (dealer_user_mapping) — never from the
 * request. A missing code is refused outright rather than becoming an
 * unrestricted query.
 */
function requireDealerCodeArg(dealerCode) {
  const code = String(dealerCode ?? '').trim();
  if (!code) throw new Error('A dealer code is required to read dealer leads');
  return code;
}

/** WHERE for one dealer's leads. The dealer restriction is always the first condition. */
function dealerLeadsWhere(dealerCode, { search, status } = {}) {
  const conditions = [`dealer_code = '${quote(requireDealerCodeArg(dealerCode))}'`];

  const term = String(search || '').trim();
  if (term) {
    if (term.includes('*')) {
      // `*` is ZCQL's LIKE wildcard and cannot be escaped; a literal `*` never
      // appears in lead data, so nothing can match.
      conditions.push("ROWID = '0'");
    } else {
      const like = quote(term);
      conditions.push(
        `(${['customer_name', 'email_address', 'mobile_number', 'vehicle_model']
          .map((column) => `${column} LIKE '*${like}*'`)
          .join(' OR ')})`
      );
    }
  }
  if (status) conditions.push(`lead_status = '${quote(status)}'`);

  return `WHERE ${conditions.join(' AND ')}`;
}

// Columns the My Leads table can sort by; anything else falls back to the
// natural (oldest first) order. ROWID makes every order total, so no row is
// skipped or repeated between pages.
const SORTABLE_COLUMNS = new Set(['customer_name', 'vehicle_model', 'lead_status', 'last_status_update']);

function orderByClause(sortKey, sortDir) {
  if (!SORTABLE_COLUMNS.has(sortKey)) return 'ORDER BY ROWID ASC';
  return `ORDER BY ${sortKey} ${String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}, ROWID ASC`;
}

function toPositiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function normalizePaging({ page, pageSize } = {}) {
  return {
    page: toPositiveInt(page, 1),
    pageSize: Math.min(MAX_PAGE_SIZE, toPositiveInt(pageSize, DEFAULT_PAGE_SIZE)),
  };
}

/**
 * One page of the dealer's leads. Search, status filter and sort run in the
 * database before paging; `total` counts the whole matching set, so it stays
 * accurate beyond ZCQL's 100-row default and 300-row maximum.
 *
 * query: page (1-based), pageSize (default 50, max 200), search, status,
 * sortKey (customer_name | vehicle_model | lead_status | last_status_update),
 * sortDir (asc | desc).
 */
async function getDealerLeadsPage(catalystApp, dealerCode, query = {}) {
  const { page, pageSize } = normalizePaging(query);
  const where = dealerLeadsWhere(dealerCode, query);
  const offset = (page - 1) * pageSize;

  const [countRows, pageRows] = await Promise.all([
    catalystApp.zcql().executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${LEADS_TABLE} ${where}`),
    catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEADS_TABLE} ${where} ${orderByClause(query.sortKey, query.sortDir)} LIMIT ${zcqlOffset(offset)}, ${pageSize}`
    ),
  ]);

  const total = Number(countRows[0]?.[LEADS_TABLE]?.['COUNT(ROWID)']) || 0;
  const leads = pageRows.map((row) => row[LEADS_TABLE]);
  return {
    leads,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: offset + leads.length < total,
    },
  };
}

/** [{ lead_status, count }] for one dealer — COUNT … GROUP BY, no lead rows read. */
async function getDealerStatusCounts(catalystApp, dealerCode) {
  const rows = [];
  for (let offset = 0; ; offset += ZCQL_MAX_ROWS) {
    const result = await catalystApp.zcql().executeZCQLQuery(
      `SELECT lead_status, COUNT(ROWID) FROM ${LEADS_TABLE} ${dealerLeadsWhere(dealerCode)} ` +
        `GROUP BY lead_status ORDER BY lead_status LIMIT ${zcqlOffset(offset)}, ${ZCQL_MAX_ROWS}`
    );
    rows.push(...result);
    if (result.length < ZCQL_MAX_ROWS) break;
  }
  return rows.map((wrapped) => ({
    lead_status: wrapped[LEADS_TABLE].lead_status ?? null,
    count: Number(wrapped[LEADS_TABLE]['COUNT(ROWID)']) || 0,
  }));
}

/** The My Leads KPI figures: the dealer's total and a count per exact lead_status. */
async function getDealerLeadCounts(catalystApp, dealerCode) {
  const statusCounts = await getDealerStatusCounts(catalystApp, dealerCode);
  const byStatus = {};
  let total = 0;
  statusCounts.forEach(({ lead_status: status, count }) => {
    total += count;
    if (status) byStatus[status] = (byStatus[status] || 0) + count;
  });
  return { total, byStatus };
}

/** Dealer Dashboard summary (same shape as summarizeLeadsByStatus), from database counts. */
async function getDealerLeadSummary(catalystApp, dealerCode) {
  const statusCounts = await getDealerStatusCounts(catalystApp, dealerCode);
  const summary = { total: 0, new: 0, contacted: 0, test_drive: 0, quotation: 0, delivered: 0, lost: 0 };
  statusCounts.forEach(({ lead_status: status, count }) => {
    summary.total += count;
    const key = STATUS_KEY_MAP[status];
    if (key) summary[key] += count;
  });
  return summary;
}

/**
 * Every lead belonging to the dealer, read completely (a bare SELECT silently
 * stops at 100 rows). Bounded by MAX_FULL_LIST_ROWS; `truncated` says so
 * instead of staying silent. Prefer getDealerLeadsPage for anything shown to
 * a person — this exists for callers that need the whole set client-side.
 */
async function getAllLeadsForDealer(catalystApp, dealerCode) {
  const where = dealerLeadsWhere(dealerCode);
  const leads = [];
  for (let offset = 0; leads.length < MAX_FULL_LIST_ROWS; offset += ZCQL_MAX_ROWS) {
    const size = Math.min(ZCQL_MAX_ROWS, MAX_FULL_LIST_ROWS - leads.length);
    const result = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEADS_TABLE} ${where} ORDER BY ROWID ASC LIMIT ${zcqlOffset(offset)}, ${size}`
    );
    leads.push(...result.map((row) => row[LEADS_TABLE]));
    if (result.length < size) return { leads, truncated: false, total: leads.length };
  }
  const countRows = await catalystApp.zcql().executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${LEADS_TABLE} ${where}`);
  const total = Number(countRows[0]?.[LEADS_TABLE]?.['COUNT(ROWID)']) || 0;
  return { leads, truncated: total > leads.length, total };
}

/** Returns all leads belonging to the given dealer_code (complete, up to MAX_FULL_LIST_ROWS). */
async function getLeadsForDealer(catalystApp, dealerCode) {
  return (await getAllLeadsForDealer(catalystApp, dealerCode)).leads;
}

/**
 * Groups leads by lead_status into the counts the Dealer Dashboard
 * needs (Step 4): Total, New, Contacted, Test Drive, Quotation,
 * Delivered, Lost.
 */
const STATUS_KEY_MAP = {
  'New': 'new',
  'Contacted': 'contacted',
  'Test Drive': 'test_drive',
  'Quotation': 'quotation',
  'Delivered': 'delivered',
  'Lost': 'lost',
};

function summarizeLeadsByStatus(leads) {
  const summary = {
    total: leads.length,
    new: 0,
    contacted: 0,
    test_drive: 0,
    quotation: 0,
    delivered: 0,
    lost: 0,
  };

  leads.forEach((lead) => {
    const key = STATUS_KEY_MAP[lead.lead_status];
    if (key) summary[key] += 1;
  });

  return summary;
}

/**
 * Fetches a single lead by ROWID, but only returns it if it belongs to
 * the given dealer_code — otherwise returns null, which the route
 * translates to a 403/404 rather than leaking whether the lead exists
 * at all for another dealer.
 */
async function getOwnedLead(catalystApp, rowId, dealerCode) {
  const table = catalystApp.datastore().table(LEADS_TABLE);
  const row = await table.getRow(rowId);
  if (!row || row.dealer_code !== dealerCode) {
    return null;
  }
  return row;
}

module.exports = {
  resolveDealerCodeForUser,
  resolveUsersForDealerCode,
  getLeadsForDealer,
  getAllLeadsForDealer,
  getDealerLeadsPage,
  getDealerLeadCounts,
  getDealerLeadSummary,
  summarizeLeadsByStatus,
  getOwnedLead,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  _test: { dealerLeadsWhere, orderByClause, normalizePaging },
};