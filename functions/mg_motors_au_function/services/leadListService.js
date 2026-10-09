'use strict';

/**
 * leadListService.js
 * -----------------------------------------------------------------------
 * Server-side pagination for the Lead Exchange page (GET /admin/leads?page=).
 * Search, filters, sort and date range are applied in the database BEFORE
 * paging, so a request reads one page of rows plus a COUNT — never the whole
 * leads table.
 *
 * ZCQL facts this relies on (each verified against the live Catalyst Data
 * Store, not assumed):
 *   - LIKE wildcard is `*` (NOT `%`) and matching is case-insensitive.
 *   - COUNT(ROWID), GROUP BY (several columns), IS NULL, NOT IN, parenthesised
 *     AND/OR and multi-column ORDER BY are supported.
 *   - A LIMIT may not exceed 300 rows.
 */

const logger = require('../utils/logger');
const { FilterTooComplexError, translateZcqlError } = require('../utils/zcqlErrors');

const LEADS_TABLE = 'leads';
const DEALERS_TABLE = 'dealers';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const ZCQL_MAX_ROWS = 300; // ZCQL rejects a LIMIT above this
const ID_CHUNK = 50;

/**
 * ZCQL's LIMIT offset is effectively 1-based: `LIMIT 0, n` and `LIMIT 1, n`
 * return the same rows, and `LIMIT k, n` starts at the k-th row. Paging with
 * a plain 0-based offset therefore repeats the last row of page 1 at the top
 * of page 2 (verified against the live Data Store). `LIMIT offset + 1` is a
 * true 0-based offset, so pages are contiguous with no repeat and no gap.
 */
const zcqlOffset = (offset) => offset + 1;

// --- Happy / Unhappy classification ----------------------------------------
// MIRRORS classifyLeadWithDuplicate() and its lookup tables in
// mg-motor-web/src/pages/LeadExchange/LeadExchangePage.jsx. The backend needs
// its own copy so the Happy/Unhappy and scenario filters can run in the
// database. Like the role IDs (see CLAUDE.md), the two copies are separate
// deployables with no shared code: change one, change the other.

const UNHAPPY_LEAD_STATUSES = new Set([
  'Rejected', 'Junk', 'Junk Lead', 'Spam', 'Dealer Unavailable', 'Unattended Alert',
]);

const UNHAPPY_SYNC_STATUSES = new Set([
  'VALIDATION_HOLD', 'CONSENT_HOLD', 'ROUTING_HOLD', 'DELIVERY_FAILED',
  'FAILED_CRITICAL', 'SLA_BREACH', 'HELD',
]);

const SYNC_STATUS_TO_PATH = {
  CONSENT_HOLD: 'Unhappy 8',
  VALIDATION_HOLD: 'Unhappy 2',
  ROUTING_HOLD: 'Unhappy 5',
  DELIVERY_FAILED: 'Unhappy 1',
  FAILED: 'Unhappy 1',
  FAILED_CRITICAL: 'Unhappy 3',
  SLA_BREACH: 'Unhappy 10',
  HELD: 'Unhappy 4',
  RECONCILE_MISMATCH: 'Unhappy 11',
  DUPLICATE_LINKED: 'Happy 3',
};

const LEAD_STATUS_TO_PATH = {
  'Unattended Alert': 'Unhappy 10',
  'Dealer Unavailable': 'Unhappy 3',
  'Junk Lead': 'Unhappy 9',
  Junk: 'Unhappy 9',
  Spam: 'Unhappy 9',
  Rejected: 'Unhappy 9',
};

/** Classifies a (happy_unhappy_path_name, sync_status, lead_status) triple. */
function classifyTriple({ storedPath, syncStatus, leadStatus }) {
  const stored = String(storedPath || '').trim();
  const sync = syncStatus || '';
  const status = leadStatus || '';

  if (sync === 'DUPLICATE_LINKED' || stored === 'Happy 3') {
    return { path: 'happy', label: 'Happy 3' };
  }

  const unhappy =
    /^Unhappy\s+/i.test(stored) ||
    UNHAPPY_SYNC_STATUSES.has(sync) ||
    UNHAPPY_LEAD_STATUSES.has(status);

  const label =
    (/^(Happy|Unhappy)\s+\d+$/i.test(stored) && stored) ||
    SYNC_STATUS_TO_PATH[sync] ||
    LEAD_STATUS_TO_PATH[status] ||
    (unhappy ? 'Unhappy' : '');

  return { path: unhappy ? 'unhappy' : 'happy', label };
}

// --- Query building --------------------------------------------------------

function quote(value) {
  return String(value ?? '').replace(/'/g, "''");
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

const SORTS = {
  // Last activity. MODIFIEDTIME moves on every row write (sync, dealer status
  // change, hold) so it is the latest of the row's timestamps; ROWID makes the
  // order total so no row is skipped or repeated between pages.
  recent: 'ORDER BY MODIFIEDTIME DESC, ROWID DESC',
  alpha: 'ORDER BY customer_name ASC, ROWID ASC',
};

// Catalyst rejects an over-complex WHERE ("More than 10 conditions"). The exact
// counting rule is not published and, measured live, is not just "10 ANDs" (see
// utils/zcqlErrors.js). Every fragment below is therefore a Cond that tracks
//   - `ands`:  how many ANDs it contains in total, and
//   - `chain`: how many comparisons sit in one flat (unparenthesised) chain,
// and the builder refuses what it cannot be sure Catalyst accepts. Both limits
// are conservative: all 45 heaviest real combinations the UI can send were run
// against the live Data Store and accepted.
const MAX_ANDS = 9;
const MAX_CHAIN = 10;

function cond(sql, ands = 0, chain = 1) {
  return { sql, ands, chain };
}

function and(...parts) {
  const present = parts.filter(Boolean);
  if (present.length === 0) return null;
  // Each part is parenthesised, so its own chain does not merge into this one.
  if (present.length > MAX_CHAIN) throw new FilterTooComplexError();
  return cond(
    present.map((c) => `(${c.sql})`).join(' AND '),
    present.reduce((n, c) => n + c.ands, 0) + (present.length - 1),
    present.length
  );
}

function or(...parts) {
  const present = parts.filter(Boolean);
  if (present.length === 0) return null;
  // ORed parts are NOT parenthesised, so their chains add up.
  const chain = present.reduce((n, c) => n + c.chain, 0);
  if (chain > MAX_CHAIN) throw new FilterTooComplexError();
  return cond(present.map((c) => c.sql).join(' OR '), present.reduce((n, c) => n + c.ands, 0), chain);
}

function inList(column, values) {
  return cond(`${column} IN (${values.map((v) => `'${quote(v)}'`).join(', ')})`);
}

const PATH_COL = 'happy_unhappy_path_name';
const VALID_STORED_LABEL = /^(Happy|Unhappy)\s+\d+$/i;
const UNHAPPY_STORED_LIKE = "happy_unhappy_path_name LIKE 'unhappy *'";

// "Not a duplicate": the JS classifier gives Happy 3 priority over everything.
const notDuplicate = () =>
  and(
    cond("sync_status IS NULL OR sync_status != 'DUPLICATE_LINKED'", 0, 2),
    cond(`${PATH_COL} IS NULL OR ${PATH_COL} != 'Happy 3'`, 0, 2)
  );
const syncNotDuplicate = () => cond("sync_status IS NULL OR sync_status != 'DUPLICATE_LINKED'", 0, 2);
const isDuplicate = () => cond(`sync_status = 'DUPLICATE_LINKED' OR ${PATH_COL} = 'Happy 3'`, 0, 2);

const UNHAPPY_SYNC_LIST = [...UNHAPPY_SYNC_STATUSES];
const UNHAPPY_STATUS_LIST = [...UNHAPPY_LEAD_STATUSES];
const quoted = (values) => values.map((v) => `'${quote(v)}'`).join(', ');

/** "Looks unhappy" on any of the three columns (before the duplicate override is applied). */
const unhappySignal = () =>
  or(
    cond(UNHAPPY_STORED_LIKE),
    inList('sync_status', UNHAPPY_SYNC_LIST),
    inList('lead_status', UNHAPPY_STATUS_LIST)
  );

/** Happy / Unhappy as rules over the three columns, mirroring classifyTriple(). */
function pathRuleCondition(path) {
  if (path === 'unhappy') {
    return and(notDuplicate(), unhappySignal());
  }
  return or(
    isDuplicate(),
    and(
      cond(`${PATH_COL} IS NULL OR ${PATH_COL} NOT LIKE 'unhappy *'`, 0, 2),
      cond(`sync_status IS NULL OR sync_status NOT IN (${quoted(UNHAPPY_SYNC_LIST)})`, 0, 2),
      cond(`lead_status IS NULL OR lead_status NOT IN (${quoted(UNHAPPY_STATUS_LIST)})`, 0, 2)
    )
  );
}

/**
 * One scenario label (e.g. "Unhappy 5") as a rule over the three columns, in
 * the same priority order as classifyTriple(): duplicate, then the stored
 * label, then the sync-status label, then the lead-status label.
 */
function scenarioRuleCondition(label, groups) {
  if (label === 'Happy 3') return isDuplicate();

  const validStored = [
    ...new Set(groups.map((g) => g.storedPath).filter((v) => v && VALID_STORED_LABEL.test(String(v).trim()))),
  ];
  const storedForLabel = validStored.filter((v) => String(v).trim() === label);
  const syncsForLabel = Object.keys(SYNC_STATUS_TO_PATH).filter((k) => SYNC_STATUS_TO_PATH[k] === label);
  const statusesForLabel = Object.keys(LEAD_STATUS_TO_PATH).filter((k) => LEAD_STATUS_TO_PATH[k] === label);

  // Duplicates (Happy 3) override every other label, so a lead only has this
  // label if it is not a duplicate. That exclusion is needed on the stored-label
  // branch only (sync_status = DUPLICATE_LINKED can still carry a stored label);
  // the derived branch below can never match a duplicate on its own: stored
  // 'Happy 3' is a valid stored label (so "not a valid label" is false for it),
  // and DUPLICATE_LINKED maps to Happy 3, not to this label. Stating it once,
  // where it matters, keeps the heaviest filter combination inside the budget.
  const viaStored = storedForLabel.length ? and(inList(PATH_COL, storedForLabel), syncNotDuplicate()) : null;
  const derived = or(
    syncsForLabel.length ? inList('sync_status', syncsForLabel) : null,
    statusesForLabel.length
      ? and(
          cond(`sync_status IS NULL OR sync_status NOT IN (${quoted(Object.keys(SYNC_STATUS_TO_PATH))})`, 0, 2),
          inList('lead_status', statusesForLabel)
        )
      : null
  );
  // When no valid stored label exists at all, "not a valid label" is always true.
  const storedNotValid = validStored.length
    ? cond(`${PATH_COL} IS NULL OR ${PATH_COL} NOT IN (${quoted(validStored)})`, 0, 2)
    : null;
  const viaDerived = derived ? and(storedNotValid, derived) : null;

  return or(viaStored, viaDerived);
}

/** Exact fallback for labels with no rule (e.g. the bare "Unhappy"): enumerate. */
function scenarioByEnumeration(groups, label) {
  const matches = groups.filter((g) => classifyTriple(g).label === label);
  if (matches.length === 0) return null;
  const col = (c, v) => (v === null || v === undefined ? cond(`${c} IS NULL`) : cond(`${c} = '${quote(v)}'`));
  // Each clause is parenthesised so it counts as ONE operand of the OR chain
  // (the shape Catalyst was verified to accept), not three.
  const clause = (g) => {
    const c = and(col(PATH_COL, g.storedPath), col('sync_status', g.syncStatus), col('lead_status', g.leadStatus));
    return cond(`(${c.sql})`, c.ands, 1);
  };
  return or(...matches.map(clause));
}

/**
 * Builds the Happy/Unhappy + scenario condition. Returns:
 *   undefined  -> no path filter requested
 *   null       -> filter requested but nothing can match (empty result)
 *   Cond       -> the condition
 * When a scenario is given the Happy/Unhappy toggle is redundant if every
 * lead currently carrying that label has the same path (the usual case); it is
 * then dropped to stay inside the AND budget, and kept only when it matters.
 */
function buildPathCondition(groups, { path, scenario }) {
  const wantPath = path === 'happy' || path === 'unhappy' ? path : null;
  const wantLabel = scenario ? String(scenario) : null;
  if (!wantPath && !wantLabel) return undefined;
  if (!wantLabel) return pathRuleCondition(wantPath);

  const present = groups.filter((g) => classifyTriple(g).label === wantLabel);
  if (present.length === 0) return null;
  const scenarioCond = VALID_STORED_LABEL.test(wantLabel)
    ? scenarioRuleCondition(wantLabel, groups)
    : scenarioByEnumeration(groups, wantLabel);
  if (!scenarioCond) return null;
  if (!wantPath) return scenarioCond;

  const paths = new Set(present.map((g) => classifyTriple(g).path));
  if (paths.size === 1 && paths.has(wantPath)) return scenarioCond; // toggle implied by the label
  if (paths.size === 1) return null; // this label never has the requested path
  return and(pathRuleCondition(wantPath), scenarioCond); // mixed: both matter
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}


/**
 * Builds the WHERE clause (or '') shared by the page and COUNT queries.
 * `searchDealerCodes` are the dealers whose NAME matched the search term
 * (dealer_name lives on the dealers table, not on leads). `pathCondition` is
 * buildPathCondition()'s result.
 */
function buildWhere(filters, { pathCondition, searchDealerCodes = [] } = {}) {
  const groups = [];

  const term = String(filters.search || '').trim();
  if (term) {
    if (term.includes('*')) {
      // `*` is ZCQL's LIKE wildcard and cannot be escaped; a literal `*` never
      // appears in lead data, so nothing can match.
      groups.push(cond("ROWID = '0'"));
    } else {
      const like = quote(term);
      const parts = ['customer_name', 'email_address', 'mobile_number', 'vehicle_model'].map((column) =>
        cond(`${column} LIKE '*${like}*'`)
      );
      if (searchDealerCodes.length) parts.push(inList('dealer_code', searchDealerCodes));
      groups.push(or(...parts));
    }
  }

  if (filters.status) groups.push(cond(`lead_status = '${quote(filters.status)}'`));
  if (filters.dealerCode) groups.push(cond(`dealer_code = '${quote(filters.dealerCode)}'`));
  if (filters.showRemoved === false) groups.push(cond("sync_status IS NULL OR sync_status != 'Removed'", 0, 2));
  const from = DATE_ONLY.test(filters.fromDate || '') ? filters.fromDate : null;
  const to = DATE_ONLY.test(filters.toDate || '') ? filters.toDate : null;
  // CREATEDTIME is compared to the millisecond, so the end of the range is
  // "before midnight of the next day" — `<= 'date 23:59:59'` would drop a row
  // created at 23:59:59.500. Each bound is its own AND-joined condition.
  if (from) groups.push(cond(`CREATEDTIME >= '${from} 00:00:00'`));
  if (to) groups.push(cond(`CREATEDTIME < '${nextDay(to)} 00:00:00'`));
  if (pathCondition) groups.push(pathCondition);

  const combined = and(...groups);
  if (!combined) return '';
  if (combined.ands > MAX_ANDS) throw new FilterTooComplexError();
  return `WHERE ${combined.sql}`;
}

// --- Data access -----------------------------------------------------------

async function runPaged(catalystApp, selectSql) {
  const rows = [];
  for (let offset = 0; ; offset += ZCQL_MAX_ROWS) {
    const result = await catalystApp.zcql().executeZCQLQuery(
      `${selectSql} LIMIT ${zcqlOffset(offset)}, ${ZCQL_MAX_ROWS}`
    );
    rows.push(...result);
    if (result.length < ZCQL_MAX_ROWS) return rows;
  }
}

/** Distinct (path, sync, status) combinations with their lead counts. */
async function loadTripleGroups(catalystApp) {
  const rows = await runPaged(
    catalystApp,
    `SELECT happy_unhappy_path_name, sync_status, lead_status, COUNT(ROWID) FROM ${LEADS_TABLE} ` +
      'GROUP BY happy_unhappy_path_name, sync_status, lead_status'
  );
  return rows.map((row) => {
    const r = row[LEADS_TABLE];
    return {
      storedPath: r.happy_unhappy_path_name ?? null,
      syncStatus: r.sync_status ?? null,
      leadStatus: r.lead_status ?? null,
      count: Number(r['COUNT(ROWID)']) || 0,
    };
  });
}

async function findDealerCodesByName(catalystApp, term) {
  const like = quote(String(term).trim());
  if (!like || like.includes('*')) return [];
  const rows = await runPaged(
    catalystApp,
    `SELECT dealer_code FROM ${DEALERS_TABLE} WHERE dealer_name LIKE '*${like}*'`
  );
  return rows.map((r) => r[DEALERS_TABLE].dealer_code).filter(Boolean);
}

async function fetchDealerNames(catalystApp, codes) {
  const map = new Map();
  const unique = [...new Set(codes)].filter(Boolean);
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const list = unique.slice(i, i + ID_CHUNK).map((c) => `'${quote(c)}'`).join(', ');
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT dealer_code, dealer_name FROM ${DEALERS_TABLE} WHERE dealer_code IN (${list})`
    );
    rows.forEach((r) => map.set(r[DEALERS_TABLE].dealer_code, r[DEALERS_TABLE].dealer_name));
  }
  return map;
}

function withDealerName(lead, names) {
  return { ...lead, dealer_name: names.get(lead.dealer_code) || 'Unknown' };
}

/**
 * Filter-dropdown data the page used to derive from the full list: lead
 * statuses, dealers, Happy/Unhappy counts and the scenario labels present.
 * Global (unfiltered), exactly as before.
 */
async function getLeadFacets(catalystApp, groups) {
  const tripleGroups = groups || (await loadTripleGroups(catalystApp));

  const statuses = new Set();
  const labels = new Set();
  const pathCounts = { happy: 0, unhappy: 0 };
  let total = 0;
  for (const g of tripleGroups) {
    total += g.count;
    if (g.leadStatus) statuses.add(g.leadStatus);
    const result = classifyTriple(g);
    pathCounts[result.path] += g.count;
    if (result.label) labels.add(result.label);
  }

  const dealerRows = await runPaged(
    catalystApp,
    `SELECT dealer_code, COUNT(ROWID) FROM ${LEADS_TABLE} GROUP BY dealer_code`
  );
  const dealerCodes = dealerRows.map((r) => r[LEADS_TABLE].dealer_code).filter(Boolean);
  const names = await fetchDealerNames(catalystApp, dealerCodes);
  const dealers = dealerCodes
    .map((code) => ({ code, name: names.get(code) || 'Unknown' }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    total,
    pathCounts,
    statuses: [...statuses].sort(),
    scenarios: [...labels],
    dealers,
  };
}

/**
 * One page of leads, filtered and sorted in the database.
 *
 * filters: search, status, dealerCode, path ('all'|'happy'|'unhappy'),
 *   scenario, showRemoved (default true), sortBy ('recent'|'alpha'),
 *   fromDate / toDate (YYYY-MM-DD, project time, on CREATEDTIME).
 * paging: page (1-based), pageSize (default 50, max 200).
 */
async function getLeadsPage(catalystApp, query = {}) {
  const { page, pageSize } = normalizePaging(query);
  const filters = {
    search: query.search,
    status: query.status,
    dealerCode: query.dealerCode,
    showRemoved: query.showRemoved === false || String(query.showRemoved).toLowerCase() === 'false' ? false : true,
    fromDate: query.fromDate,
    toDate: query.toDate,
  };
  const orderBy = SORTS[query.sortBy] || SORTS.recent;
  const wantsPathFilter = ['happy', 'unhappy'].includes(query.path) || Boolean(query.scenario);

  // Facets need the triple groups too; load them once and reuse.
  let groups = null;
  if (wantsPathFilter || query.includeFacets) groups = await loadTripleGroups(catalystApp);

  const pathCondition = wantsPathFilter
    ? buildPathCondition(groups, { path: query.path, scenario: query.scenario })
    : undefined;

  const facetsPromise = query.includeFacets ? getLeadFacets(catalystApp, groups) : null;

  const emptyPage = async () => ({
    leads: [],
    pagination: { page, pageSize, total: 0, totalPages: 1, hasMore: false },
    facets: facetsPromise ? await facetsPromise : undefined,
  });
  // A path filter that no existing lead can satisfy.
  if (pathCondition === null) return emptyPage();

  const searchDealerCodes = String(filters.search || '').trim()
    ? await findDealerCodesByName(catalystApp, filters.search)
    : [];
  const where = buildWhere(filters, { pathCondition, searchDealerCodes });
  const offset = (page - 1) * pageSize;

  let countRows;
  let pageRows;
  try {
    [countRows, pageRows] = await Promise.all([
      catalystApp.zcql().executeZCQLQuery(`SELECT COUNT(ROWID) FROM ${LEADS_TABLE} ${where}`.trim()),
      catalystApp.zcql().executeZCQLQuery(
        `SELECT * FROM ${LEADS_TABLE} ${where} ${orderBy} LIMIT ${zcqlOffset(offset)}, ${pageSize}`.replace(/\s+/g, ' ')
      ),
    ]);
  } catch (err) {
    throw translateZcqlError(err); // a platform complexity rejection becomes a clean 400
  }

  const total = Number(countRows[0]?.[LEADS_TABLE]?.['COUNT(ROWID)']) || 0;
  const leads = pageRows.map((r) => r[LEADS_TABLE]);
  const names = await fetchDealerNames(catalystApp, leads.map((l) => l.dealer_code));

  return {
    leads: leads.map((lead) => withDealerName(lead, names)),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      hasMore: offset + leads.length < total,
    },
    facets: facetsPromise ? await facetsPromise : undefined,
  };
}

/** A single lead by ROWID or crm_record_id (the detail route accepts either). */
async function getLeadByIdentifier(catalystApp, identifier) {
  const id = String(identifier ?? '').trim();
  if (!id) return null;

  // ROWID is numeric; comparing it with anything else makes ZCQL throw.
  const columns = /^\d+$/.test(id) ? ['ROWID', 'crm_record_id'] : ['crm_record_id'];
  for (const column of columns) {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${LEADS_TABLE} WHERE ${column} = '${quote(id)}' LIMIT 1`
    );
    if (rows.length) {
      const lead = rows[0][LEADS_TABLE];
      const names = await fetchDealerNames(catalystApp, [lead.dealer_code]);
      return withDealerName(lead, names);
    }
  }
  logger.info('leadListService', `Lead not found for identifier ${id}`);
  return null;
}

module.exports = {
  getLeadsPage,
  getLeadFacets,
  getLeadByIdentifier,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  FilterTooComplexError,
  _test: { classifyTriple, buildWhere, buildPathCondition, normalizePaging, SORTS, MAX_ANDS, MAX_CHAIN, or, and, cond, loadTripleGroups, pathRuleCondition, scenarioRuleCondition, dealerSearchCodes: findDealerCodesByName },
};
