'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { isMappingCachePerRunEnabled } = require('../../config/env');

/**
 * mappingRunCache.js
 * -----------------------------------------------------------------------
 * Audit S6 (FUSION_REMEDIATION_PLAN.md, Batch 9a): each outbound attempt
 * re-read the dealer's field and status mappings, so a sweep of N leads for
 * one dealer read the same rows N times. With MAPPING_CACHE_PER_RUN on, a
 * sweep or sync run (runWithMappingCache) reads each dealer's mappings once.
 *
 * The cache belongs to that one run (AsyncLocalStorage), so there is nothing
 * to invalidate: a mapping saved during a run is used from the next run, and
 * a call outside any run (a webhook, an admin request) reads fresh, as
 * before. A failed read is not kept, and each caller gets its own copy of
 * the array.
 */

const storage = new AsyncLocalStorage();

function runWithMappingCache(fn) {
  if (!isMappingCachePerRunEnabled() || storage.getStore()) return fn();
  return storage.run(new Map(), fn);
}

async function cachedForRun(kind, integrationId, load) {
  const store = storage.getStore();
  if (!store) return load();
  const key = `${kind}:${integrationId}`;
  if (!store.has(key)) {
    const pending = Promise.resolve().then(load);
    store.set(key, pending);
    pending.catch(() => store.delete(key));
  }
  const rows = await store.get(key);
  return Array.isArray(rows) ? [...rows] : rows;
}

/** Wraps a sweep or sync function so each call runs with its own cache. */
function withMappingCache(fn) {
  return (...args) => runWithMappingCache(() => fn(...args));
}

module.exports = { runWithMappingCache, cachedForRun, withMappingCache };
