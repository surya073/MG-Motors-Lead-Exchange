'use strict';

const crypto = require('node:crypto');
const { isUsageRollupEnabled } = require('../config/env');

/**
 * usageRollup.js (internal cost module)
 * -----------------------------------------------------------------------
 * Adds every request's usage line (usageContext.js) into an in-memory total
 * per IST hour and component (route), and saves those totals to the
 * cost_usage_hourly table with one insert, never inside a response:
 *   - IDLE_FLUSH_MS after the last request of a burst (live instances live
 *     only seconds to a few minutes: measured 9 s, ~2 min and ~3 min on
 *     23 Oct 2026, so a 10-minute timer never fired);
 *   - at the start of a request once the oldest unsaved total is
 *     FLUSH_EVERY_MS old or from an earlier hour (busy instances).
 *
 * The [usage] log lines stay the full record. An instance that is recycled
 * before its next flush loses its unsaved totals, so the hourly table is a
 * floor, not an exact count.
 *
 * Its own inserts are counted under the component COST_MODULE, so the
 * monitoring cost is visible next to everything else.
 */
const TABLE = 'cost_usage_hourly';
const FLUSH_EVERY_MS = 2 * 60 * 1000;
const IDLE_FLUSH_MS = 20 * 1000;
const COST_MODULE = '(cost module)';
// The payload column is Catalyst `text` (10,000 chars); a longer hour is split.
const MAX_PAYLOAD_CHARS = 9000;
const IST_OFFSET_MS = 330 * 60 * 1000;

const instanceTag = crypto.randomBytes(6).toString('hex');
let pending = new Map(); // bucket_hour -> { components: {}, credits: {} }
let firstPendingAt = null; // oldest unsaved request total (the module's own inserts don't count)
let flushing = false;
let idleTimer = null;
let getLatestApp = null; // initializes a Catalyst app from the latest request

/** Remembers how to reach the Data Store from the latest request, for the idle flush. */
function rememberApp(getApp) {
  getLatestApp = getApp;
}

function bucketHour(ms = Date.now()) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 13).replace('T', ' ');
}

function emptyComponent() {
  return {
    requests: 0, errors: 0, ms: 0,
    ds: { fetch: 0, fetchRows: 0, insert: 0, update: 0, delete: 0 },
    api: {}, token: { refresh: 0, hit: 0 },
    idle: 0, unchanged: 0, trigger: null,
  };
}

function bucket(hour) {
  if (!pending.has(hour)) pending.set(hour, { components: {}, credits: {} });
  return pending.get(hour);
}

function addInto(target, line) {
  target.requests += line.requests ?? 1;
  if (Number(line.status) >= 500) target.errors += 1;
  target.errors += line.errors ?? 0;
  target.ms += Number(line.ms) || 0;
  for (const kind of Object.keys(target.ds)) target.ds[kind] += Number(line.ds?.[kind]) || 0;
  for (const [org, n] of Object.entries(line.api || {})) target.api[org] = (target.api[org] || 0) + (Number(n) || 0);
  target.token.refresh += Number(line.token?.refresh) || 0;
  target.token.hit += Number(line.token?.hit) || 0;
  if (line.outcome === 'idle') target.idle += 1;
  if (line.outcome === 'unchanged') target.unchanged += 1;
  target.idle += line.idle ?? 0;
  target.unchanged += line.unchanged ?? 0;
  if (line.trigger && !target.trigger) target.trigger = line.trigger;
}

/** Adds one usage line (usageContext.usageLine) to the current hour. */
function record(line, now = Date.now()) {
  if (!line || !isUsageRollupEnabled()) return;
  const hourly = bucket(bucketHour(now));
  const name = String(line.route || 'unknown');
  if (!hourly.components[name]) hourly.components[name] = emptyComponent();
  addInto(hourly.components[name], line);
  for (const [org, value] of Object.entries(line.credits || {})) hourly.credits[org] = value;
  // The module's own insert is saved with the next real total; it never
  // starts a save by itself, or the module would keep saving its saves.
  if (name !== COST_MODULE) {
    if (firstPendingAt === null) firstPendingAt = now;
    scheduleIdleFlush();
  }
}

function scheduleIdleFlush() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (getLatestApp) flushIfDue(getLatestApp, Date.now(), { idle: true });
  }, IDLE_FLUSH_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

function isDue(now = Date.now(), { idle = false } = {}) {
  if (firstPendingAt === null || flushing) return false;
  if (idle || now - firstPendingAt >= FLUSH_EVERY_MS) return true;
  const current = bucketHour(now);
  return [...pending.keys()].some((hour) => hour !== current);
}

/** Splits one hour's totals into payloads that fit the text column. */
function payloads(hourly) {
  const out = [];
  let chunk = { components: {}, credits: hourly.credits };
  for (const [name, totals] of Object.entries(hourly.components)) {
    chunk.components[name] = totals;
    if (JSON.stringify(chunk).length > MAX_PAYLOAD_CHARS && Object.keys(chunk.components).length > 1) {
      delete chunk.components[name];
      out.push(chunk);
      chunk = { components: { [name]: totals }, credits: {} };
    }
  }
  if (Object.keys(chunk.components).length > 0) out.push(chunk);
  return out.map((p) => JSON.stringify(p));
}

function catalystDateTime(ms) {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Saves the pending totals with `catalystApp` (uncounted: the module's own
 * inserts go to COST_MODULE instead). Totals are dropped only once saved;
 * a failed save keeps them for the next try.
 */
async function flush(catalystApp, now = Date.now()) {
  if (flushing || pending.size === 0 || !catalystApp) return { inserted: 0 };
  flushing = true;
  const taken = pending;
  const takenFirstAt = firstPendingAt;
  pending = new Map();
  firstPendingAt = null;
  try {
    const rows = [];
    for (const [hour, hourly] of taken) {
      for (const payload of payloads(hourly)) {
        rows.push({ bucket_hour: hour, instance_tag: instanceTag, payload, flushed_at: catalystDateTime(now) });
      }
    }
    await catalystApp.datastore().table(TABLE).insertRows(rows);
    record({ route: COST_MODULE, trigger: 'internal', ds: { insert: rows.length } }, now);
    return { inserted: rows.length };
  } catch (err) {
    // Put the totals back (merged with anything recorded meanwhile).
    for (const [hour, hourly] of taken) {
      const into = bucket(hour);
      for (const [name, totals] of Object.entries(hourly.components)) {
        if (!into.components[name]) into.components[name] = emptyComponent();
        addInto(into.components[name], totals);
      }
      into.credits = { ...hourly.credits, ...into.credits };
    }
    // Retried at the next due point; the idle timer is not re-armed, so a
    // failing table does not turn into a retry loop.
    if (takenFirstAt !== null && (firstPendingAt === null || takenFirstAt < firstPendingAt)) firstPendingAt = takenFirstAt;
    const logger = require('../utils/logger');
    logger.error('usageRollup', 'hourly usage save failed', err);
    return { inserted: 0, error: err?.message };
  } finally {
    flushing = false;
  }
}

/** Starts a flush in the background when one is due; never throws. */
function flushIfDue(getApp, now = Date.now(), options = {}) {
  if (!isUsageRollupEnabled() || !isDue(now, options)) return;
  try {
    const app = getApp();
    flush(app, now).catch(() => {});
  } catch {
    // Metering must never affect the request.
  }
}

function reset() {
  pending = new Map();
  firstPendingAt = null;
  flushing = false;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  getLatestApp = null;
}

module.exports = {
  TABLE,
  COST_MODULE,
  record,
  flush,
  flushIfDue,
  rememberApp,
  bucketHour,
  _test: { reset, isDue, payloads, pending: () => pending, FLUSH_EVERY_MS, IDLE_FLUSH_MS },
};
