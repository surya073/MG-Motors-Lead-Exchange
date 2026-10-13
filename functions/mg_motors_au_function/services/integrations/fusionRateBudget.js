'use strict';

const logger = require('../../utils/logger');
const { getFusionRateBudgetConfig } = require('../../config/env');

/**
 * fusionRateBudget.js
 * -----------------------------------------------------------------------
 * Fusion SD allows 300 requests per 60 seconds per credential, shared by
 * create and update (Lead API guide, 29 Sep 2026). With FUSION_RATE_BUDGET
 * on (FUSION_REMEDIATION_PLAN.md, Batch 8, audit S1) each Fusion integration
 * spends at most FUSION_RATE_LIMIT_PER_MINUTE x FUSION_RATE_HEADROOM
 * (default 300 x 0.8 = 240) requests per clock minute, and after a 429 every
 * caller waits out the dealer's Retry-After before sending again.
 *
 * Counts and cool-downs live in Catalyst Cache so every instance shares
 * them, keyed per integration and per minute. Catalyst Cache has no atomic
 * increment, so two instances counting at the same moment can both pass;
 * the headroom absorbs that. When the cache cannot be read or written the
 * instance's own count is used, so the budget still holds per instance.
 *
 * A request over budget or inside a cool-down is never sent: takeSlot()
 * throws a temporary error (no HTTP response) carrying vendor.retryAfter,
 * so the existing retry paths deliver the lead later and the classified
 * retry policy waits at least that long.
 */

const COOLDOWN_DEFAULT_SECONDS = 60;
const CACHE_EXPIRY_HOURS = 1;

// Per-instance fallback state, keyed like the cache.
const localCounts = new Map();
const localCooldowns = new Map();

function budgetPerMinute() {
  const { limitPerMinute, headroom } = getFusionRateBudgetConfig();
  return Math.max(1, Math.floor(limitPerMinute * headroom));
}

function segmentOf(catalystApp) {
  try {
    return typeof catalystApp?.cache === 'function' ? catalystApp.cache().segment() : null;
  } catch {
    return null;
  }
}

// A cache problem is logged at most once a minute per instance, not on every
// Fusion request.
const CACHE_ERROR_LOG_INTERVAL_MS = 60000;
let lastCacheErrorLoggedAt = 0;

function logCacheProblem(what, err) {
  const now = Date.now();
  if (now - lastCacheErrorLoggedAt < CACHE_ERROR_LOG_INTERVAL_MS) return;
  lastCacheErrorLoggedAt = now;
  logger.error('fusionRateBudget', `Catalyst Cache ${what} failed; using this instance's count (logged once a minute)`, err);
}

// A key nobody has written yet may come back empty or as an error,
// depending on the Catalyst API; either way it counts as absent.
async function cacheGet(segment, key) {
  if (!segment) return null;
  try {
    const value = await segment.getValue(key);
    return value === undefined || value === null || value === '' ? null : String(value);
  } catch {
    return null;
  }
}

// The SDK's put() inserts (POST) and update() replaces (PUT). Try update
// first (one call once the key exists), then put for a new key, so this
// works whether or not the live cache lets put() overwrite.
async function cachePut(segment, key, value) {
  if (!segment) return false;
  try {
    await segment.update(key, String(value), CACHE_EXPIRY_HOURS);
    return true;
  } catch {
    try {
      await segment.put(key, String(value), CACHE_EXPIRY_HOURS);
      return true;
    } catch (err) {
      logCacheProblem(`write of ${key}`, err);
      return false;
    }
  }
}

function limitError(code, retryAfterSeconds, integration) {
  const err = new Error(
    code === 'FUSION_COOLDOWN'
      ? `Fusion asked us to wait (HTTP 429) for integration ${integration.ROWID}; request not sent, retry in ${retryAfterSeconds}s`
      : `Fusion request budget for integration ${integration.ROWID} is used up this minute; request not sent, retry in ${retryAfterSeconds}s`
  );
  err.code = code;
  err.vendor = { retryAfter: retryAfterSeconds };
  return err;
}

/**
 * Spends one request of this integration's budget, or throws
 * FUSION_COOLDOWN / FUSION_RATE_BUDGET_EXHAUSTED without spending it.
 */
async function takeSlot(catalystApp, integration, now = Date.now()) {
  if (!getFusionRateBudgetConfig().enabled) return;
  const id = String(integration.ROWID);
  const segment = segmentOf(catalystApp);

  const cooldownKey = `fusion_cooldown_${id}`;
  const cooldownUntil = Math.max(Number(await cacheGet(segment, cooldownKey)) || 0, localCooldowns.get(cooldownKey) || 0);
  if (cooldownUntil > now) {
    throw limitError('FUSION_COOLDOWN', Math.ceil((cooldownUntil - now) / 1000), integration);
  }

  const minute = Math.floor(now / 60000);
  const countKey = `fusion_rate_${id}_${minute}`;
  const shared = await cacheGet(segment, countKey);
  const used = Math.max(shared === null ? 0 : Number(shared) || 0, localCounts.get(countKey) || 0);
  if (used >= budgetPerMinute()) {
    throw limitError('FUSION_RATE_BUDGET_EXHAUSTED', Math.ceil(((minute + 1) * 60000 - now) / 1000), integration);
  }
  localCounts.set(countKey, used + 1);
  await cachePut(segment, countKey, used + 1);
  // Drop this instance's counts for minutes that are over.
  for (const key of localCounts.keys()) {
    if (Number(key.slice(key.lastIndexOf('_') + 1)) < minute) localCounts.delete(key);
  }
}

/** After Fusion answers 429: no request for this integration until Retry-After has passed. */
async function recordRateLimited(catalystApp, integration, retryAfterSeconds, now = Date.now()) {
  if (!getFusionRateBudgetConfig().enabled) return;
  const seconds = Number(retryAfterSeconds) > 0 ? Number(retryAfterSeconds) : COOLDOWN_DEFAULT_SECONDS;
  const until = now + seconds * 1000;
  const key = `fusion_cooldown_${integration.ROWID}`;
  localCooldowns.set(key, Math.max(localCooldowns.get(key) || 0, until));
  await cachePut(segmentOf(catalystApp), key, until);
  logger.info('fusionRateBudget', `Fusion answered 429 for integration ${integration.ROWID}; pausing requests for ${seconds}s`);
}

function isLimitError(err) {
  return err?.code === 'FUSION_COOLDOWN' || err?.code === 'FUSION_RATE_BUDGET_EXHAUSTED';
}

function _resetForTests() {
  localCounts.clear();
  localCooldowns.clear();
  lastCacheErrorLoggedAt = 0;
}

module.exports = { takeSlot, recordRateLimited, budgetPerMinute, isLimitError, _resetForTests, _test: { limitError } };
