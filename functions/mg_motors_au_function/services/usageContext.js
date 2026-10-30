'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('node:crypto');
const { isUsageLogEnabled } = require('../config/env');

/**
 * usageContext.js (COST_OPTIMIZATION_PLAN.md, Batch 1)
 * -----------------------------------------------------------------------
 * Counts what one request costs and writes it as ONE `[usage]` log line
 * when the response finishes: Catalyst Data Store operations, calls to MG's
 * and dealers' CRMs, the last API-credits header seen, and access-token
 * refreshes vs. cache hits. Nothing is written to the datastore.
 *
 * Counting is transparent: the wrapped catalystApp returns the same values
 * and throws the same errors. USAGE_LOG=false turns all of it off.
 *
 * What one count means (the billing unit is not documented, so the line keeps
 * both: compare them with the Console counters before trusting either):
 *   - fetch: one ZCQL query, getRow, getPagedRows or getAllRows call;
 *     fetchRows: the rows those returned.
 *   - insert / update / delete: one row (a bulk call counts each row).
 */
const storage = new AsyncLocalStorage();

const FETCH_METHODS = new Set(['getRow', 'getPagedRows', 'getAllRows']);
const WRITE_METHODS = {
  insertRow: 'insert', insertRows: 'insert',
  updateRow: 'update', updateRows: 'update',
  deleteRow: 'delete', deleteRows: 'delete',
};
// Zoho documents an API-credits header on CRM responses; the exact name is
// not verified against this org yet. Absent means unknown, never zero.
const CREDITS_HEADERS = ['x-api-credits-remaining'];

function emptyDs() {
  return { fetch: 0, fetchRows: 0, insert: 0, update: 0, delete: 0 };
}

function triggerFor(path) {
  if (path.startsWith('/cron/')) return 'cron';
  if (path.startsWith('/webhooks/')) return 'webhook';
  return 'user';
}

function createContext(req) {
  return {
    cid: crypto.randomUUID(),
    method: req.method,
    path: req.path,
    trigger: triggerFor(req.path),
    startedAt: Date.now(),
    ds: emptyDs(),
    api: {},
    credits: {},
    token: { refresh: 0, hit: 0 },
    stage: null,
    stages: {},
    detail: {},
    emitted: false,
  };
}

function current() {
  return storage.getStore() || null;
}

function currentCid() {
  return current()?.cid || null;
}

function addDs(ctx, kind, amount = 1) {
  ctx.ds[kind] += amount;
  if (ctx.stage) ctx.stages[ctx.stage][kind] += amount;
}

function rowCount(value) {
  return Array.isArray(value) ? value.length : (value ? 1 : 0);
}

function countedTable(table, ctx) {
  return new Proxy(table, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      if (FETCH_METHODS.has(prop)) {
        return async (...args) => {
          addDs(ctx, 'fetch');
          const result = await value.apply(target, args);
          addDs(ctx, 'fetchRows', prop === 'getPagedRows' ? rowCount(result?.data) : rowCount(result));
          return result;
        };
      }
      if (prop === 'getIterableRows') {
        // Pages internally; counted as one fetch plus every row it yields.
        return async function* iterate(...args) {
          addDs(ctx, 'fetch');
          for await (const row of value.apply(target, args)) {
            addDs(ctx, 'fetchRows');
            yield row;
          }
        };
      }
      if (WRITE_METHODS[prop]) {
        return (...args) => {
          addDs(ctx, WRITE_METHODS[prop], Array.isArray(args[0]) ? args[0].length : 1);
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

/**
 * Wraps a catalystApp so its Data Store work counts against `ctx` (by default
 * the request's context). Returns the app unchanged when there is no context.
 */
function instrument(catalystApp, ctx = current()) {
  if (!catalystApp || !ctx) return catalystApp;
  return new Proxy(catalystApp, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'zcql' && typeof value === 'function') {
        return (...args) => {
          const zcql = value.apply(target, args);
          return new Proxy(zcql, {
            get(zTarget, zProp) {
              const zValue = Reflect.get(zTarget, zProp);
              if (typeof zValue !== 'function') return zValue;
              if (zProp === 'executeZCQLQuery') {
                return async (...queryArgs) => {
                  addDs(ctx, 'fetch');
                  const rows = await zValue.apply(zTarget, queryArgs);
                  addDs(ctx, 'fetchRows', rowCount(rows));
                  return rows;
                };
              }
              return zValue.bind(zTarget);
            },
          });
        };
      }
      if (prop === 'datastore' && typeof value === 'function') {
        return (...args) => {
          const datastore = value.apply(target, args);
          return new Proxy(datastore, {
            get(dTarget, dProp) {
              const dValue = Reflect.get(dTarget, dProp);
              if (typeof dValue !== 'function') return dValue;
              if (dProp === 'table') return (...tableArgs) => countedTable(dValue.apply(dTarget, tableArgs), ctx);
              return dValue.bind(dTarget);
            },
          });
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * `catalyst.initialize(req)`, counted. Also re-enters the request's context
 * in case a body parser's stream callback dropped it.
 */
function initialize(catalyst, req) {
  const app = catalyst.initialize(req);
  const ctx = req?.usageContext;
  if (!ctx) return app;
  if (storage.getStore() !== ctx) storage.enterWith(ctx);
  return instrument(app, ctx);
}

function readCredits(headers) {
  if (!headers) return undefined;
  for (const name of CREDITS_HEADERS) {
    const value = typeof headers.get === 'function' ? headers.get(name) : (headers[name] ?? headers[name.toUpperCase()]);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const number = Number(value);
      return Number.isFinite(number) ? number : undefined;
    }
  }
  return undefined;
}

/**
 * Counts one HTTP call to a CRM (`org`: 'mg' or the dealer code) around the
 * axios call `send` makes, and keeps the last credits header it returned.
 * The call's result or error passes through untouched.
 */
async function trackApiCall(org, send) {
  const ctx = current();
  const label = String(org || 'dealer');
  if (ctx) ctx.api[label] = (ctx.api[label] || 0) + 1;
  try {
    const response = await send();
    noteCredits(ctx, label, response?.headers);
    return response;
  } catch (err) {
    noteCredits(ctx, label, err?.response?.headers);
    throw err;
  }
}

function noteCredits(ctx, label, headers) {
  if (!ctx) return;
  const credits = readCredits(headers);
  if (credits !== undefined) ctx.credits[label] = credits;
}

/** 'refresh' for each token endpoint call, 'hit' when a cached token is reused. */
function countToken(kind) {
  const ctx = current();
  if (ctx && (kind === 'refresh' || kind === 'hit')) ctx.token[kind] += 1;
}

/** Attributes Data Store work from here on to `name` (fast-recover stages). */
function setStage(name) {
  const ctx = current();
  if (!ctx) return;
  ctx.stage = name || null;
  if (name && !ctx.stages[name]) ctx.stages[name] = emptyDs();
}

/** Adds route-specific facts to the usage line (counts and labels only, never payloads). */
function annotate(fields) {
  const ctx = current();
  if (ctx && fields) Object.assign(ctx.detail, fields);
}

function routeLabel(req, ctx) {
  const routePath = req.route?.path;
  return routePath ? `${req.baseUrl || ''}${routePath}` : ctx.path;
}

function usageLine(req, res, ctx) {
  const line = {
    cid: ctx.cid,
    route: routeLabel(req, ctx),
    method: ctx.method,
    trigger: ctx.trigger,
    status: res.statusCode,
    ms: Date.now() - ctx.startedAt,
    ds: ctx.ds,
    api: ctx.api,
    credits: ctx.credits,
    token: ctx.token,
  };
  if (Object.keys(ctx.stages).length > 0) line.stages = ctx.stages;
  return { ...line, ...ctx.detail };
}

function emit(req, res, ctx) {
  if (ctx.emitted) return;
  ctx.emitted = true;
  try {
    const logger = require('../utils/logger');
    const line = usageLine(req, res, ctx);
    storage.run(ctx, () => logger.info('usage', JSON.stringify(line)));
    require('./usageRollup').record(line);
  } catch {
    // Metering must never affect the response.
  }
}

/**
 * Express middleware: one context per request, emitted once when the
 * response finishes (or the connection closes first).
 */
function middleware(req, res, next) {
  if (!isUsageLogEnabled()) return next();
  const ctx = createContext(req);
  req.usageContext = ctx;
  const done = () => emit(req, res, ctx);
  res.once('finish', done);
  res.once('close', done);
  // Saves earlier requests' hourly totals in the background (uncounted app).
  // Admin scope: on a portal request the default scope is the signed-in user,
  // and only App Administrator may insert into cost_usage_hourly, so saves
  // during Admin, Dealer or View User requests failed with "No privileges".
  const rollup = require('./usageRollup');
  const getApp = () => require('zcatalyst-sdk-node').initialize(req, { scope: 'admin' });
  rollup.rememberApp(getApp);
  rollup.flushIfDue(getApp);
  return storage.run(ctx, next);
}

// Result counters that mean a sweep changed something (COST_OPTIMIZATION_PLAN.md,
// Batch 7, "sweeps with zero useful work"). Re-holding, rotating, skipping and
// failed attempts are housekeeping, not work.
const USEFUL_WORK_KEYS = new Set([
  'recovered', 'delivered', 'breached', 'expired', 'closedUnreplayable',
  'changed', 'reconciled', 'missingAtDealer', 'neverCreated',
  'recordsInserted', 'recordsUpdated', 'recordsRemoved',
]);

function usefulWork(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return 0;
  let work = value.sent === true ? 1 : 0; // an alert batch that went out
  for (const [key, child] of Object.entries(value)) {
    if (USEFUL_WORK_KEYS.has(key) && typeof child === 'number') work += child;
    else if (child && typeof child === 'object' && !Array.isArray(child)) work += usefulWork(child, depth + 1);
  }
  return work;
}

/** Marks a sweep's usage line `worked` or `idle`, from its result object. */
function annotateSweepOutcome(results) {
  const work = usefulWork(results);
  annotate({ outcome: work > 0 ? 'worked' : 'idle', work });
}

/** Runs `fn` inside a fresh context (tests and non-HTTP callers). */
function runWithContext(fields, fn) {
  const ctx = { ...createContext({ method: '', path: '' }), ...fields };
  return storage.run(ctx, () => fn(ctx));
}

module.exports = {
  middleware,
  initialize,
  instrument,
  trackApiCall,
  countToken,
  setStage,
  annotate,
  annotateSweepOutcome,
  current,
  currentCid,
  runWithContext,
  _test: { usageLine, readCredits, usefulWork },
};
