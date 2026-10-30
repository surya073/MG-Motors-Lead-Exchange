'use strict';

const dashboardStats = require('./dashboardStatsService');
const { toCatalystDateTime } = require('../utils/dateFormat');

/**
 * costKpiService.js (COST_OPTIMIZATION_PLAN.md, Batch 7; decision C6)
 * -----------------------------------------------------------------------
 * The Super Admin "Cost KPIs" page. Cost data is what a super admin uploads:
 * the daily, per-route summary that scripts/usageReport.js --json makes from
 * exported function logs, and billing snapshots typed in from the Catalyst
 * Console. Both live in one small table, cost_daily (a few writes per
 * upload, never one row per operation). Lead outcomes come from
 * integration_logs on demand.
 *
 * cost_daily columns (create in the Catalyst Console before use):
 *   record_type   Varchar 20   'USAGE' or 'BILLING'
 *   usage_day     Varchar 10   YYYY-MM-DD (IST); for BILLING the snapshot's date
 *   route_label   Varchar 255  USAGE only
 *   requests, ds_fetch, ds_fetch_rows, ds_insert, ds_update, ds_delete,
 *   api_calls, token_refresh, idle_runs, unchanged_runs   BigInt
 *   cost_inr      Double       USAGE: priced ops; BILLING: cumulative ₹ for ops
 *   credits_json  Text         USAGE: lowest Zoho credits remaining per org
 *   snapshot_at   DateTime     BILLING only (UTC, Catalyst format)
 */

const TABLE = 'cost_daily';
// Billing unit rates (₹ per operation), as recorded in the plan.
const PRICE = { fetch: 0.0036, update: 0.0048, insert: 0.006, delete: 0.0048 };
const MAX_UPLOAD_DAYS = 62;
const MAX_ROUTES_PER_DAY = 60;
const MAX_WINDOW_DAYS = 90;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IST_OFFSET_MS = 330 * 60 * 1000;

const USAGE_COUNTERS = {
  requests: 'requests',
  fetch: 'ds_fetch',
  fetchRows: 'ds_fetch_rows',
  insert: 'ds_insert',
  update: 'ds_update',
  delete: 'ds_delete',
  api: 'api_calls',
  tokenRefresh: 'token_refresh',
  idle: 'idle_runs',
  unchanged: 'unchanged_runs',
};

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function quote(value) {
  return String(value).replace(/'/g, "''");
}

function count(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isInteger(number) || number < 0) throw badRequest(`${field} must be a whole number of 0 or more`);
  return number;
}

function opsCost(ops) {
  return Math.round(Object.entries(PRICE).reduce((sum, [kind, price]) => sum + (ops[kind] || 0) * price, 0) * 100) / 100;
}

function istDay(date) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Validates usageReport.js --json output: { days: { day: { route: counters } } }. */
function parseUsageUpload(body) {
  const days = body?.days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) throw badRequest('Expected the JSON from usageReport.js --json: { "days": { ... } }');
  const entries = Object.entries(days).filter(([day]) => day !== 'unknown');
  if (entries.length === 0) throw badRequest('The upload has no dated usage lines');
  if (entries.length > MAX_UPLOAD_DAYS) throw badRequest(`Upload at most ${MAX_UPLOAD_DAYS} days at a time`);
  return entries.map(([day, routes]) => {
    if (!DAY.test(day)) throw badRequest(`"${day}" is not a YYYY-MM-DD day`);
    if (!routes || typeof routes !== 'object') throw badRequest(`${day}: expected routes`);
    const routeEntries = Object.entries(routes);
    if (routeEntries.length > MAX_ROUTES_PER_DAY) throw badRequest(`${day}: at most ${MAX_ROUTES_PER_DAY} routes`);
    return {
      day,
      rows: routeEntries.map(([route, counters]) => {
        if (!route || route.length > 255) throw badRequest(`${day}: route label must be 1-255 characters`);
        const row = { record_type: 'USAGE', usage_day: day, route_label: route };
        for (const [key, column] of Object.entries(USAGE_COUNTERS)) row[column] = count(counters?.[key], `${day} ${route} ${key}`);
        // Priced here from the counts, never trusted from the upload.
        row.cost_inr = opsCost({ fetch: row.ds_fetch, insert: row.ds_insert, update: row.ds_update, delete: row.ds_delete });
        const credits = Object.fromEntries(Object.entries(counters?.credits || {})
          .filter(([org, left]) => /^[\w.-]{1,40}$/.test(org) && Number.isFinite(Number(left)))
          .map(([org, left]) => [org, Number(left)]));
        row.credits_json = Object.keys(credits).length ? JSON.stringify(credits) : null;
        return row;
      }),
    };
  });
}

/**
 * Replaces the USAGE rows of every uploaded day with the upload's rows
 * (re-uploading a day corrects it; other days are untouched).
 */
async function uploadUsage(catalystApp, body) {
  const days = parseUsageUpload(body);
  const table = catalystApp.datastore().table(TABLE);
  const existing = await dashboardStats.selectEveryRow(
    catalystApp, TABLE,
    `WHERE record_type = 'USAGE' AND usage_day IN (${days.map(({ day }) => `'${day}'`).join(', ')})`,
    'ORDER BY ROWID ASC'
  );
  const byKey = new Map(existing.map((row) => [`${row.usage_day}|${row.route_label}`, row]));
  const summary = { days: days.length, inserted: 0, updated: 0, deleted: 0 };
  for (const { rows } of days) {
    for (const row of rows) {
      const key = `${row.usage_day}|${row.route_label}`;
      const current = byKey.get(key);
      if (current) {
        await table.updateRow({ ROWID: current.ROWID, ...row });
        summary.updated += 1;
        byKey.delete(key);
      } else {
        await table.insertRow(row);
        summary.inserted += 1;
      }
    }
  }
  // Routes of an uploaded day that the new upload no longer has.
  for (const stale of byKey.values()) {
    await table.deleteRow(stale.ROWID);
    summary.deleted += 1;
  }
  return summary;
}

/** A billing snapshot: the Console's cycle-to-date Data Store counters at a moment. */
async function addBillingSnapshot(catalystApp, body) {
  const at = new Date(body?.snapshotAt);
  if (!body?.snapshotAt || Number.isNaN(at.getTime())) throw badRequest('snapshotAt must be a date and time');
  if (at.getTime() > Date.now() + 5 * 60 * 1000) throw badRequest('snapshotAt cannot be in the future');
  const ops = {};
  for (const kind of ['fetch', 'update', 'insert', 'delete']) ops[kind] = count(body[kind], kind);
  const row = await catalystApp.datastore().table(TABLE).insertRow({
    record_type: 'BILLING',
    usage_day: istDay(at),
    snapshot_at: toCatalystDateTime(at),
    ds_fetch: ops.fetch,
    ds_update: ops.update,
    ds_insert: ops.insert,
    ds_delete: ops.delete,
    cost_inr: opsCost(ops),
  });
  return { ROWID: row.ROWID };
}

async function deleteBillingSnapshot(catalystApp, rowId) {
  if (!/^\d+$/.test(String(rowId))) throw badRequest('Invalid snapshot id');
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID, record_type FROM ${TABLE} WHERE ROWID = ${rowId} LIMIT 1`
  );
  if (rows[0]?.[TABLE]?.record_type !== 'BILLING') {
    throw Object.assign(new Error('Billing snapshot not found'), { statusCode: 404 });
  }
  await catalystApp.datastore().table(TABLE).deleteRow(rowId);
  return { deleted: true };
}

function sumOps(rows) {
  const total = { requests: 0, fetch: 0, fetchRows: 0, insert: 0, update: 0, delete: 0, api: 0, tokenRefresh: 0, idle: 0, unchanged: 0, cost: 0 };
  for (const row of rows) {
    for (const [key, column] of Object.entries(USAGE_COUNTERS)) total[key] += Number(row[column]) || 0;
    total.cost += Number(row.cost_inr) || 0;
  }
  total.cost = Math.round(total.cost * 100) / 100;
  return total;
}

function parseCredits(text) {
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/**
 * Lead outcomes in the window, from integration_logs (one grouped count).
 * Delivered = Happy 1 + Happy 4. Non-deliverable = Unhappy 5 among outbound
 * (MG -> dealer) lead events. Recovery = Happy 4 / (Happy 4 + Unhappy 3): of
 * deliveries that went into retry and ended, the share that recovered rather
 * than escalating after 24 h.
 */
async function leadOutcomes(catalystApp, fromDay) {
  const grouped = await dashboardStats.countGrouped(
    catalystApp, 'integration_logs', ['happy_unhappy_path_name'],
    [`CREATEDTIME >= '${fromDay} 00:00:00'`, "direction = 'ZOHO_TO_EXTERNAL_CRM'", "operation IN ('CREATE_LEAD', 'UPDATE_LEAD')"]
  );
  const by = Object.fromEntries(grouped.map((row) => [row.happy_unhappy_path_name || 'Unclassified', row.count]));
  const n = (code) => by[code] || 0;
  const outboundEvents = Object.entries(by)
    .filter(([code]) => /^(Happy|Unhappy) \d+$/.test(code))
    .reduce((sum, [, value]) => sum + value, 0);
  const delivered = n('Happy 1') + n('Happy 4');
  const ended = n('Happy 4') + n('Unhappy 3');
  return {
    byScenario: by,
    outboundEvents,
    delivered,
    nonDeliverable: n('Unhappy 5'),
    nonDeliverableShare: outboundEvents ? n('Unhappy 5') / outboundEvents : null,
    recovered: n('Happy 4'),
    escalated: n('Unhappy 3'),
    recoveryRate: ended ? n('Happy 4') / ended : null,
  };
}

function daysInMonth(day) {
  const [year, month] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

async function getCostKpis(catalystApp, { days = 30, now = new Date() } = {}) {
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(Number(days)) || 30));
  const today = istDay(now);
  const fromDay = istDay(new Date(now.getTime() - (windowDays - 1) * 24 * 3600 * 1000));

  const [usageRows, billingRows, leads] = await Promise.all([
    dashboardStats.selectEveryRow(catalystApp, TABLE,
      `WHERE record_type = 'USAGE' AND usage_day >= '${quote(fromDay)}'`, 'ORDER BY usage_day ASC, ROWID ASC', 3000),
    dashboardStats.selectEveryRow(catalystApp, TABLE, "WHERE record_type = 'BILLING'", 'ORDER BY snapshot_at ASC, ROWID ASC', 300),
    leadOutcomes(catalystApp, fromDay),
  ]);

  // Daily trend and per-route breakdown (self-metered).
  const byDay = new Map();
  const byRoute = new Map();
  for (const row of usageRows) {
    if (!byDay.has(row.usage_day)) byDay.set(row.usage_day, []);
    byDay.get(row.usage_day).push(row);
    if (!byRoute.has(row.route_label)) byRoute.set(row.route_label, []);
    byRoute.get(row.route_label).push(row);
  }
  const daily = [...byDay.entries()].map(([day, rows]) => ({ day, ...sumOps(rows) }));
  const routes = [...byRoute.entries()]
    .map(([route, rows]) => ({ route, ...sumOps(rows) }))
    .sort((a, b) => b.cost - a.cost);
  const totals = sumOps(usageRows);

  // Month-end projection: month-to-date metered cost plus the average of the
  // last (up to) 7 metered days for each remaining day of the month.
  const monthPrefix = today.slice(0, 7);
  const monthToDate = daily.filter((d) => d.day.startsWith(monthPrefix));
  const recent = daily.slice(-7);
  const avgDaily = recent.length ? recent.reduce((sum, d) => sum + d.cost, 0) / recent.length : null;
  const daysLeft = daysInMonth(today) - Number(today.slice(8, 10));
  const projection = avgDaily === null ? null : {
    monthToDate: Math.round(monthToDate.reduce((sum, d) => sum + d.cost, 0) * 100) / 100,
    averageDaily: Math.round(avgDaily * 100) / 100,
    basedOnDays: recent.length,
    monthEnd: Math.round((monthToDate.reduce((sum, d) => sum + d.cost, 0) + avgDaily * daysLeft) * 100) / 100,
  };

  // Billing snapshots and the billed rate between consecutive ones, set
  // against the metered cost of the same days (approximate: whole days).
  const snapshots = billingRows.map((row) => ({
    ROWID: row.ROWID,
    snapshotAt: row.snapshot_at,
    day: row.usage_day,
    fetch: Number(row.ds_fetch) || 0,
    update: Number(row.ds_update) || 0,
    insert: Number(row.ds_insert) || 0,
    delete: Number(row.ds_delete) || 0,
    cost: Number(row.cost_inr) || 0,
  }));
  const meteredBetween = (from, to) => daily.filter((d) => d.day >= from && d.day < to);
  const billingPeriods = snapshots.slice(1).map((snap, i) => {
    const prev = snapshots[i];
    const hours = (Date.parse(`${snap.snapshotAt.replace(' ', 'T')}Z`) - Date.parse(`${prev.snapshotAt.replace(' ', 'T')}Z`)) / 3600000;
    const billed = Math.round((snap.cost - prev.cost) * 100) / 100;
    const metered = meteredBetween(prev.day, snap.day);
    const meteredCost = Math.round(metered.reduce((sum, d) => sum + d.cost, 0) * 100) / 100;
    return {
      from: prev.snapshotAt,
      to: snap.snapshotAt,
      // A drop means the snapshots belong to different billing cycles.
      sameCycle: billed >= 0,
      billed,
      billedPerDay: hours > 0 ? Math.round((billed / hours) * 24 * 100) / 100 : null,
      meteredDays: metered.length,
      metered: meteredCost,
      gap: billed > 0 && metered.length ? Math.round(((billed - meteredCost) / billed) * 1000) / 10 : null,
    };
  });

  // Sweeps with zero useful work, per sweep route.
  const sweeps = routes
    .filter((r) => r.route.startsWith('/cron/') && r.requests > 0)
    .map((r) => ({ route: r.route, runs: r.requests, idle: r.idle, idleShare: r.idle / r.requests }));

  // Latest known Zoho credits per org (lowest value on the latest day it was seen).
  const credits = {};
  for (const row of usageRows) {
    for (const [org, left] of Object.entries(parseCredits(row.credits_json))) {
      const prev = credits[org];
      if (!prev || row.usage_day > prev.day || (row.usage_day === prev.day && left < prev.remaining)) {
        credits[org] = { day: row.usage_day, remaining: left };
      }
    }
  }

  const notify = byRoute.get('/webhooks/crm-notify');
  return {
    window: { fromDay, toDay: today, days: windowDays, meteredDays: daily.length },
    totals,
    daily,
    routes,
    projection,
    snapshots,
    billingPeriods,
    leads: {
      ...leads,
      costPerDelivered: leads.delivered && totals.cost ? Math.round((totals.cost / leads.delivered) * 100) / 100 : null,
    },
    sweeps,
    crmNotify: notify ? { calls: sumOps(notify).requests, unchanged: sumOps(notify).unchanged } : null,
    tokenRefreshes: daily.map((d) => ({ day: d.day, refreshes: d.tokenRefresh })),
    credits,
  };
}

module.exports = {
  getCostKpis,
  uploadUsage,
  addBillingSnapshot,
  deleteBillingSnapshot,
  _test: { parseUsageUpload, opsCost, leadOutcomes, PRICE },
};
