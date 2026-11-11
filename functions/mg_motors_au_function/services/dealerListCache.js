'use strict';

const { getDealerListCacheSeconds } = require('../config/env');

// Holds the /admin/dealers answer in this function instance's memory for a short
// time, so repeated page opens do not each read the whole dealers table plus the
// lead counts. Each instance has its own copy; the worst case is a list that is
// up to the cache time old. Writers that change a dealer clear it.
let entry = null;
let inflight = null;

function clear() {
  entry = null;
  inflight = null;
}

/**
 * Returns the cached value while it is fresh, otherwise runs `load` once (calls
 * that arrive meanwhile share that run) and keeps the result.
 */
async function getOrLoad(load, now = Date.now()) {
  const ttlMs = getDealerListCacheSeconds() * 1000;
  if (ttlMs <= 0) return load();
  if (entry && now - entry.at < ttlMs) return entry.value;
  if (inflight) return inflight;
  const run = (async () => {
    try {
      const value = await load();
      if (inflight === run) entry = { value, at: Date.now() };
      return value;
    } finally {
      if (inflight === run) inflight = null;
    }
  })();
  inflight = run;
  return run;
}

module.exports = { getOrLoad, clear };
