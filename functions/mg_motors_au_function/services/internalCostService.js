'use strict';

const { TABLE } = require('./usageRollup');
const { _test: { PRICE } } = require('./costKpiService');

/**
 * internalCostService.js (internal cost module)
 * -----------------------------------------------------------------------
 * Reads the hourly usage totals (usageRollup.js) for the internal cost page:
 * per component (route), per hour and per CRM org, priced with the Data
 * Store prices in costKpiService.js. ₹ here is an estimate from our own
 * counts; the Catalyst billing page stays the source of truth.
 */
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 14;
const PAGE = 300; // ZCQL's row cap per query
const MAX_PAGES = 40;
const IST_OFFSET_MS = 330 * 60 * 1000;

function hourKey(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 13).replace('T', ' ');
}

function clampHours(value) {
  const hours = Math.floor(Number(value));
  if (!Number.isFinite(hours) || hours < 1) return DEFAULT_HOURS;
  return Math.min(hours, MAX_HOURS);
}

function opsCost(ds) {
  const rupees = Object.entries(PRICE).reduce((sum, [kind, price]) => sum + (Number(ds?.[kind]) || 0) * price, 0);
  return Math.round(rupees * 10000) / 10000;
}

function emptyTotals() {
  return { requests: 0, errors: 0, ms: 0, ds: { fetch: 0, fetchRows: 0, insert: 0, update: 0, delete: 0 }, api: 0, tokenRefresh: 0, tokenHit: 0, idle: 0, unchanged: 0 };
}

function add(target, c) {
  target.requests += Number(c.requests) || 0;
  target.errors += Number(c.errors) || 0;
  target.ms += Number(c.ms) || 0;
  for (const kind of Object.keys(target.ds)) target.ds[kind] += Number(c.ds?.[kind]) || 0;
  target.api += Object.values(c.api || {}).reduce((s, n) => s + (Number(n) || 0), 0);
  target.tokenRefresh += Number(c.token?.refresh) || 0;
  target.tokenHit += Number(c.token?.hit) || 0;
  target.idle += Number(c.idle) || 0;
  target.unchanged += Number(c.unchanged) || 0;
}

async function readRows(catalystApp, sinceHour) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // Catalyst's LIMIT offset is 1-based (see test/helpers/inMemoryZcql.js).
    const batch = await catalystApp.zcql().executeZCQLQuery(
      `SELECT bucket_hour, payload FROM ${TABLE} WHERE bucket_hour >= '${sinceHour}' ORDER BY ROWID LIMIT ${page * PAGE + 1},${PAGE}`
    );
    const list = (batch || []).map((r) => r[TABLE] || r);
    rows.push(...list);
    if (list.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/**
 * Usage for the last `hours` hours (IST buckets, the current hour included).
 */
async function getUsage(catalystApp, { hours, now = Date.now() } = {}) {
  const span = clampHours(hours);
  const firstMs = now - (span - 1) * 3600 * 1000;
  const sinceHour = hourKey(firstMs);
  const { rows, truncated } = await readRows(catalystApp, sinceHour);

  const components = new Map();
  const hourly = new Map();
  for (let ms = firstMs; hourKey(ms) <= hourKey(now); ms += 3600 * 1000) hourly.set(hourKey(ms), emptyTotals());
  const orgs = {};
  const credits = {};
  let unreadable = 0;

  const ordered = rows.slice().sort((a, b) => String(a.bucket_hour).localeCompare(String(b.bucket_hour)));
  for (const row of ordered) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { unreadable += 1; continue; }
    const hour = String(row.bucket_hour);
    if (!hourly.has(hour)) hourly.set(hour, emptyTotals());
    for (const [route, c] of Object.entries(payload.components || {})) {
      if (!components.has(route)) components.set(route, { route, trigger: c.trigger || null, apiByOrg: {}, ...emptyTotals() });
      const comp = components.get(route);
      add(comp, c);
      if (!comp.trigger && c.trigger) comp.trigger = c.trigger;
      for (const [org, n] of Object.entries(c.api || {})) {
        comp.apiByOrg[org] = (comp.apiByOrg[org] || 0) + (Number(n) || 0);
        orgs[org] = (orgs[org] || 0) + (Number(n) || 0);
      }
      add(hourly.get(hour), c);
    }
    for (const [org, value] of Object.entries(payload.credits || {})) credits[org] = { value, hour };
  }

  const total = emptyTotals();
  const componentList = [...components.values()].map((c) => {
    add(total, { ...c, api: { all: c.api }, token: { refresh: c.tokenRefresh, hit: c.tokenHit } });
    const { ms, ...rest } = c;
    return { ...rest, avgMs: c.requests ? Math.round(ms / c.requests) : 0, costInr: opsCost(c.ds) };
  }).sort((a, b) => b.costInr - a.costInr || b.requests - a.requests);

  const costInr = opsCost(total.ds);
  const { ms, ...totals } = total;
  return {
    hours: span,
    from: sinceHour,
    to: hourKey(now),
    prices: PRICE,
    totals: { ...totals, costInr, projectedMonthlyInr: Math.round((costInr / span) * 24 * 30 * 100) / 100 },
    components: componentList,
    hourly: [...hourly.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, t]) => ({ hour, requests: t.requests, ds: t.ds, api: t.api, costInr: opsCost(t.ds) })),
    orgs: Object.entries(orgs).map(([org, calls]) => ({ org, calls })).sort((a, b) => b.calls - a.calls),
    credits,
    rowsRead: rows.length,
    unreadable,
    truncated,
  };
}

module.exports = { getUsage, _test: { clampHours, opsCost, hourKey } };
