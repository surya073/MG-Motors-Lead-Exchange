'use strict';

/**
 * usageReport.js (COST_OPTIMIZATION_PLAN.md, Batch 1, measurement step 1)
 * -----------------------------------------------------------------------
 * Sums the `[usage]` lines in exported Catalyst function logs into Data Store
 * operations and rupees, per day (IST) and route. Prices are the billing
 * unit rates recorded in the plan (₹ per operation).
 *
 *   node scripts/usageReport.js logs.txt [more-logs.txt ...]
 *   node scripts/usageReport.js --json logs.txt > usage.json   (upload on the Cost KPIs page, Batch 7)
 *
 * A usage line has no timestamp of its own; the day comes from the first
 * ISO-like date-time on the same log line (the export's timestamp column)
 * when there is one, else "unknown".
 */

const fs = require('node:fs');

const PRICE = { fetch: 0.0036, update: 0.0048, insert: 0.006, delete: 0.0048 };
const IST_OFFSET_MS = 330 * 60 * 1000;

function dayOf(line) {
  const match = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/.exec(line);
  if (!match) return 'unknown';
  const zone = match[3] ? match[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2') : '+05:30';
  const at = Date.parse(`${match[1]}T${match[2]}${zone}`);
  return Number.isNaN(at) ? 'unknown' : new Date(at + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function parseUsageLine(line) {
  const at = line.indexOf('[usage] ');
  if (at < 0) return null;
  const start = line.indexOf('{', at);
  if (start < 0) return null;
  // The JSON object ends at its matching brace; anything after is log noise.
  let depth = 0;
  for (let i = start; i < line.length; i += 1) {
    if (line[i] === '"') {
      for (i += 1; i < line.length && line[i] !== '"'; i += 1) if (line[i] === '\\') i += 1;
    } else if (line[i] === '{') depth += 1;
    else if (line[i] === '}' && --depth === 0) {
      try { return JSON.parse(line.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function cost(ds) {
  return Object.entries(PRICE).reduce((sum, [kind, price]) => sum + (ds[kind] || 0) * price, 0);
}

function summarize(text) {
  const days = {};
  for (const line of text.split(/\r?\n/)) {
    const usage = parseUsageLine(line);
    if (!usage) continue;
    const day = (days[dayOf(line)] = days[dayOf(line)] || {});
    const row = (day[usage.route || '?'] = day[usage.route || '?']
      || { requests: 0, fetch: 0, fetchRows: 0, insert: 0, update: 0, delete: 0, api: 0, tokenRefresh: 0, idle: 0, unchanged: 0, credits: {} });
    row.requests += 1;
    for (const kind of ['fetch', 'fetchRows', 'insert', 'update', 'delete']) row[kind] += usage.ds?.[kind] || 0;
    row.api += Object.values(usage.api || {}).reduce((a, b) => a + b, 0);
    row.tokenRefresh += usage.token?.refresh || 0;
    // Sweeps marked idle did no useful work; crm-notify marks no-change calls.
    if (usage.outcome === 'idle') row.idle += 1;
    if (usage.outcome === 'unchanged') row.unchanged += 1;
    // Lowest credits-remaining value seen per org that day (an absent header is unknown, not 0).
    for (const [org, left] of Object.entries(usage.credits || {})) {
      if (Number.isFinite(left)) row.credits[org] = Math.min(row.credits[org] ?? Infinity, left);
    }
  }
  for (const routes of Object.values(days)) {
    for (const row of Object.values(routes)) row.rupees = Math.round(cost(row) * 100) / 100;
  }
  return days;
}

function print(days) {
  for (const day of Object.keys(days).sort()) {
    const rows = Object.entries(days[day]).sort((a, b) => b[1].rupees - a[1].rupees);
    const total = rows.reduce((sum, [, r]) => sum + r.rupees, 0);
    console.log(`\n${day}  total ₹${total.toFixed(2)}`);
    console.log('route | requests | fetch | fetchRows | insert | update | delete | CRM calls | token refreshes | ₹');
    for (const [route, r] of rows) {
      console.log([route, r.requests, r.fetch, r.fetchRows, r.insert, r.update, r.delete, r.api, r.tokenRefresh, r.rupees.toFixed(2)].join(' | '));
    }
  }
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (files.filter((file) => file !== '--json').length === 0) {
    console.error('usage: node scripts/usageReport.js [--json] <exported-log-file> [...]');
    process.exit(1);
  }
  const json = files[0] === '--json';
  const days = summarize(files.slice(json ? 1 : 0).map((file) => fs.readFileSync(file, 'utf8')).join('\n'));
  if (json) console.log(JSON.stringify({ days }, null, 2));
  else print(days);
}

module.exports = { summarize, parseUsageLine, dayOf, cost };
