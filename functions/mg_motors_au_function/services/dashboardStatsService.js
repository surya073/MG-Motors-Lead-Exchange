'use strict';

/**
 * dashboardStatsService.js
 * -----------------------------------------------------------------------
 * Database-side aggregates for the admin dashboards. Everything here is a
 * COUNT / GROUP BY (or a bounded "latest N" read) so a dashboard request costs
 * the same whether the leads table holds a thousand rows or a million — it
 * never reads lead rows just to count them.
 *
 * ZCQL facts relied on (verified against the live Catalyst Data Store):
 *   - COUNT(ROWID), multi-column GROUP BY, IS NULL, parenthesised AND/OR and
 *     CREATEDTIME BETWEEN '<date> 00:00:00' AND '<date> 23:59:59' work.
 *   - A LIMIT may not exceed 300 rows, and LIMIT's offset is effectively
 *     1-based (`LIMIT 0,n` and `LIMIT 1,n` return the same rows), so a true
 *     0-based offset is sent as `offset + 1`.
 *   - A WHERE with more than 10 AND-joined conditions is rejected; every
 *     filter here uses at most five.
 *
 * CREATEDTIME is in the project timezone, so a plain date range compares
 * directly — the same assumption adminDashboardService already relies on.
 */

const logger = require('../utils/logger');
const { translateZcqlError } = require('../utils/zcqlErrors');

const LEADS_TABLE = 'leads';
const INTEGRATION_LOGS_TABLE = 'integration_logs';
const SYNC_LOGS_TABLE = 'sync_logs';

const ZCQL_MAX_ROWS = 300;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Catalyst's own limit on the SLA rows read to average breach durations.
const SLA_ROWS_HARD_CAP = 5000;

// Catalyst answers 429 "Concurrency limit reached for the feature COMPONENT"
// when too many Data Store calls are in flight at once (seen against the live
// project while exercising these dashboards). All queries here therefore go
// through a small in-process cap and retry briefly on that response.
const MAX_CONCURRENT_QUERIES = 3;
const MAX_QUERY_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;

let activeQueries = 0;
const waiting = [];

function acquireSlot() {
  if (activeQueries < MAX_CONCURRENT_QUERIES) {
    activeQueries += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) next(); // hand the slot straight to the next waiter
  else activeQueries -= 1;
}

const isRateLimited = (err) =>
  err?.statusCode === 429 || err?.code === 'TOO_MANY_REQUESTS' || /Concurrency limit reached/i.test(String(err?.message));

async function runQuery(catalystApp, sql) {
  await acquireSlot();
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await catalystApp.zcql().executeZCQLQuery(sql);
      } catch (err) {
        if (!isRateLimited(err) || attempt >= MAX_QUERY_ATTEMPTS) throw translateZcqlError(err);
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * attempt));
      }
    }
  } finally {
    releaseSlot();
  }
}

function quote(value) {
  return String(value ?? '').replace(/'/g, "''");
}

function toDateOnly(value) {
  const raw = String(value || '').trim();
  return DATE_ONLY.test(raw) ? raw : null;
}

/** The calendar day after a YYYY-MM-DD date. */
function nextDay(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * CREATEDTIME range as WHERE fragments covering whole days. The Data Store
 * compares CREATEDTIME to the millisecond (verified live), so the end of the
 * range is "before midnight of the next day": `<= 'date 23:59:59'` would drop a
 * row created at 23:59:59.500.
 */
function dateRangeConditions({ fromDate, toDate }) {
  const from = toDateOnly(fromDate);
  const to = toDateOnly(toDate);
  const conditions = [];
  if (from) conditions.push(`CREATEDTIME >= '${from} 00:00:00'`);
  if (to) conditions.push(`CREATEDTIME < '${nextDay(to)} 00:00:00'`);
  return conditions;
}

function whereClause(conditions) {
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

/** Runs a SELECT in pages of 300 and returns every wrapped row. */
async function selectAllPaged(catalystApp, sql) {
  const rows = [];
  for (let offset = 0; ; offset += ZCQL_MAX_ROWS) {
    const result = await runQuery(catalystApp, `${sql} LIMIT ${offset + 1}, ${ZCQL_MAX_ROWS}`);
    rows.push(...result);
    if (result.length < ZCQL_MAX_ROWS) return rows;
  }
}

/** The leads row-count for a WHERE, with no rows read. */
async function countRows(catalystApp, table, conditions) {
  const rows = await runQuery(catalystApp,
    `SELECT COUNT(ROWID) FROM ${table} ${whereClause(conditions)}`.trim()
  );
  return Number(rows[0]?.[table]?.['COUNT(ROWID)']) || 0;
}

/**
 * COUNT grouped by `groupColumns`, ordered by them so paging through a large
 * result is stable. Returns [{ <col>: value, ..., count }]; a NULL column comes
 * back as null.
 */
async function countGrouped(catalystApp, table, groupColumns, conditions = []) {
  const cols = groupColumns.join(', ');
  const rows = await selectAllPaged(
    catalystApp,
    `SELECT ${cols}, COUNT(ROWID) FROM ${table} ${whereClause(conditions)} GROUP BY ${cols} ORDER BY ${cols}`.replace(/\s+/g, ' ')
  );
  return rows.map((wrapped) => {
    const row = wrapped[table];
    const out = { count: Number(row['COUNT(ROWID)']) || 0 };
    groupColumns.forEach((col) => { out[col] = row[col] ?? null; });
    return out;
  });
}

// --- leads -----------------------------------------------------------------

function leadConditions({ dealerCode, fromDate, toDate, excludeRemoved } = {}) {
  const conditions = [];
  if (dealerCode) conditions.push(`dealer_code = '${quote(dealerCode)}'`);
  conditions.push(...dateRangeConditions({ fromDate, toDate }));
  // A lead with no sync_status is not "Removed" (matches `!== 'Removed'`).
  if (excludeRemoved) conditions.push("(sync_status IS NULL OR sync_status != 'Removed')");
  return conditions;
}

/** [{ lead_status, count }] — every lead, or those matching the filters. */
function leadCountsByStatus(catalystApp, filters = {}) {
  return countGrouped(catalystApp, LEADS_TABLE, ['lead_status'], leadConditions(filters));
}

/** [{ dealer_code, lead_status, count }] for every lead. */
function leadCountsByDealerAndStatus(catalystApp) {
  return countGrouped(catalystApp, LEADS_TABLE, ['dealer_code', 'lead_status']);
}

// --- sync logs ---------------------------------------------------------------

/**
 * The newest `limit` sync_logs rows (by start_time) — what the dashboards show.
 * Replaces reading the whole table, which grows with every webhook.
 */
async function recentSyncLogs(catalystApp, limit) {
  const wanted = Math.max(1, Math.floor(Number(limit)) || 1);
  const rows = [];
  for (let offset = 0; rows.length < wanted; offset += ZCQL_MAX_ROWS) {
    const size = Math.min(ZCQL_MAX_ROWS, wanted - rows.length);
    const result = await runQuery(catalystApp,
      `SELECT * FROM ${SYNC_LOGS_TABLE} ORDER BY start_time DESC, ROWID DESC LIMIT ${offset + 1}, ${size}`
    );
    rows.push(...result.map((r) => r[SYNC_LOGS_TABLE]));
    if (result.length < size) break;
  }
  return rows;
}

// --- integration logs (Happy / Unhappy path metrics) -------------------------

function logConditions({ dealerCode, fromDate, toDate, scenarioName, status, direction } = {}) {
  const conditions = [];
  if (dealerCode) conditions.push(`dealer_code = '${quote(dealerCode)}'`);
  conditions.push(...dateRangeConditions({ fromDate, toDate }));
  if (scenarioName) conditions.push(`happy_unhappy_path_name = '${quote(scenarioName)}'`);
  if (status) conditions.push(`status = '${quote(status)}'`);
  // `direction` is the integration (e.g. ZOHO_TO_EXTERNAL_CRM) shown in the report.
  if (direction) conditions.push(`direction = '${quote(direction)}'`);
  return conditions;
}

/**
 * Per-scenario figures for the Happy/Unhappy cards, from aggregates:
 * count, distinct dealers, last occurrence and the newest row's message —
 * the same values the old code derived by scanning every log.
 */
async function scenarioStats(catalystApp, filters) {
  const conditions = logConditions(filters);

  const [perScenarioDealer, lastSeen] = await Promise.all([
    countGrouped(catalystApp, INTEGRATION_LOGS_TABLE, ['happy_unhappy_path_name', 'dealer_code'], conditions),
    selectAllPaged(
      catalystApp,
      `SELECT happy_unhappy_path_name, MAX(CREATEDTIME) FROM ${INTEGRATION_LOGS_TABLE} ${whereClause(conditions)} ` +
        'GROUP BY happy_unhappy_path_name ORDER BY happy_unhappy_path_name'
    ),
  ]);

  const byName = new Map();
  for (const row of perScenarioDealer) {
    const name = (row.happy_unhappy_path_name || '').trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, { name, rawNames: new Set(), count: 0, dealers: new Set() });
    const entry = byName.get(name);
    entry.rawNames.add(row.happy_unhappy_path_name);
    entry.count += row.count;
    if (row.dealer_code) entry.dealers.add(row.dealer_code);
  }

  const lastByName = new Map();
  for (const wrapped of lastSeen) {
    const row = wrapped[INTEGRATION_LOGS_TABLE];
    const name = (row.happy_unhappy_path_name || '').trim();
    const at = row['MAX(CREATEDTIME)'];
    if (name && at && (!lastByName.has(name) || String(at) > String(lastByName.get(name)))) lastByName.set(name, at);
  }

  // Newest row's message per scenario (a handful of scenarios, one tiny query each).
  const entries = [...byName.values()];
  const messages = await Promise.all(
    entries.map(async (entry) => {
      const rawName = [...entry.rawNames][0];
      const rows = await runQuery(catalystApp,
        `SELECT happy_unhappy_path_message FROM ${INTEGRATION_LOGS_TABLE} ` +
          `${whereClause([...conditions, `happy_unhappy_path_name = '${quote(rawName)}'`])} ` +
          'ORDER BY CREATEDTIME DESC, ROWID DESC LIMIT 1, 1'
      );
      return rows[0]?.[INTEGRATION_LOGS_TABLE]?.happy_unhappy_path_message || '';
    })
  );

  return entries.map((entry, i) => ({
    name: entry.name,
    count: entry.count,
    dealers: entry.dealers,
    lastOccurrence: lastByName.get(entry.name) || null,
    message: messages[i],
  }));
}

/** Newest `limit` rows of one scenario, plus none of the rest. */
async function recentScenarioRows(catalystApp, filters, scenarioName, limit) {
  const rows = await runQuery(catalystApp,
    `SELECT * FROM ${INTEGRATION_LOGS_TABLE} ${whereClause(logConditions({ ...filters, scenarioName }))} ` +
      `ORDER BY CREATEDTIME DESC, ROWID DESC LIMIT 1, ${Math.min(limit, ZCQL_MAX_ROWS)}`
  );
  return rows.map((r) => r[INTEGRATION_LOGS_TABLE]);
}

/**
 * Every row of one scenario (newest first), capped. Used for the SLA breach
 * list, whose average/maximum duration is parsed out of each row's message and
 * therefore cannot be aggregated in the database. `truncated` reports a cap hit.
 */
async function scenarioRows(catalystApp, filters, scenarioName, cap = SLA_ROWS_HARD_CAP) {
  const sql =
    `SELECT CREATEDTIME, dealer_code, zoho_lead_id, error_message FROM ${INTEGRATION_LOGS_TABLE} ` +
    `${whereClause(logConditions({ ...filters, scenarioName }))} ORDER BY CREATEDTIME DESC, ROWID DESC`;
  const rows = [];
  for (let offset = 0; rows.length < cap; offset += ZCQL_MAX_ROWS) {
    const size = Math.min(ZCQL_MAX_ROWS, cap - rows.length);
    const result = await runQuery(catalystApp, `${sql} LIMIT ${offset + 1}, ${size}`);
    rows.push(...result.map((r) => r[INTEGRATION_LOGS_TABLE]));
    if (result.length < size) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Distinct dealer_codes with at least one log of `status` in the filters. */
async function dealersWithLogStatus(catalystApp, filters, status) {
  const groups = await countGrouped(
    catalystApp,
    INTEGRATION_LOGS_TABLE,
    ['dealer_code'],
    logConditions({ ...filters, status })
  );
  return new Set(groups.map((g) => g.dealer_code).filter(Boolean));
}

function totalLogEvents(catalystApp, filters) {
  return countRows(catalystApp, INTEGRATION_LOGS_TABLE, logConditions(filters));
}

/**
 * One page of integration_logs, newest first, with every filter applied in the
 * database BEFORE rows are fetched. `total` is a COUNT over the same filters,
 * so it is the complete number of matching records — not the size of whatever
 * was loaded — however far back they go. ROWID breaks CREATEDTIME ties so no
 * row repeats or vanishes between pages.
 */
async function integrationLogsPage(catalystApp, filters, { page, pageSize }) {
  const conditions = logConditions(filters);
  const offset = (page - 1) * pageSize;
  const [total, result] = await Promise.all([
    countRows(catalystApp, INTEGRATION_LOGS_TABLE, conditions),
    runQuery(
      catalystApp,
      `SELECT * FROM ${INTEGRATION_LOGS_TABLE} ${whereClause(conditions)} ` +
        `ORDER BY CREATEDTIME DESC, ROWID DESC LIMIT ${offset + 1}, ${pageSize}`
    ),
  ]);
  return { rows: result.map((r) => r[INTEGRATION_LOGS_TABLE]), total };
}

// CREATEDTIME is stored in the project timezone (Asia/Kolkata, UTC+05:30).
const PROJECT_UTC_OFFSET_MINUTES = 330;

/** A Date as the 'YYYY-MM-DD HH:mm:ss' project-time string CREATEDTIME is compared against. */
function toProjectDateTime(date) {
  const shifted = new Date(date.getTime() + PROJECT_UTC_OFFSET_MINUTES * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

// Bound for a single report window; hitting it is reported, never hidden.
const LOG_WINDOW_HARD_CAP = 20000;

/**
 * Every integration_logs row created at or after `since` (newest first), read
 * in full up to LOG_WINDOW_HARD_CAP. `truncated` is true only if that bound was
 * hit, so a caller can say so instead of presenting a partial report as whole.
 */
async function integrationLogsSince(catalystApp, since, cap = LOG_WINDOW_HARD_CAP) {
  const sql =
    `SELECT * FROM ${INTEGRATION_LOGS_TABLE} WHERE CREATEDTIME >= '${toProjectDateTime(since)}' ` +
    'ORDER BY CREATEDTIME DESC, ROWID DESC';
  const rows = [];
  for (let offset = 0; rows.length < cap; offset += ZCQL_MAX_ROWS) {
    const size = Math.min(ZCQL_MAX_ROWS, cap - rows.length);
    const result = await runQuery(catalystApp, `${sql} LIMIT ${offset + 1}, ${size}`);
    rows.push(...result.map((r) => r[INTEGRATION_LOGS_TABLE]));
    if (result.length < size) return { rows, truncated: false };
  }
  const total = await countRows(catalystApp, INTEGRATION_LOGS_TABLE, [`CREATEDTIME >= '${toProjectDateTime(since)}'`]);
  return { rows, truncated: total > rows.length, total };
}

/** Rows of one table matching a WHERE, read completely in ordered pages (bounded). */
async function selectEveryRow(catalystApp, table, whereSql, orderSql, cap = ZCQL_MAX_ROWS * 10) {
  const sql = `SELECT * FROM ${table} ${whereSql} ${orderSql}`.replace(/\s+/g, ' ').trim();
  const rows = [];
  for (let offset = 0; rows.length < cap; offset += ZCQL_MAX_ROWS) {
    const size = Math.min(ZCQL_MAX_ROWS, cap - rows.length);
    const result = await runQuery(catalystApp, `${sql} LIMIT ${offset + 1}, ${size}`);
    rows.push(...result.map((r) => r[table]));
    if (result.length < size) return rows;
  }
  // The bound was reached: there may be more rows. Never silent.
  logger.error('dashboardStatsService', `selectEveryRow(${table}) stopped at its ${cap}-row bound; the result may be incomplete`);
  return rows;
}

module.exports = {
  countRows,
  countGrouped,
  leadCountsByStatus,
  leadCountsByDealerAndStatus,
  recentSyncLogs,
  scenarioStats,
  recentScenarioRows,
  scenarioRows,
  dealersWithLogStatus,
  totalLogEvents,
  integrationLogsPage,
  integrationLogsSince,
  selectEveryRow,
  toProjectDateTime,
  LOG_WINDOW_HARD_CAP,
  SLA_ROWS_HARD_CAP,
  _test: { leadConditions, logConditions, dateRangeConditions },
};
