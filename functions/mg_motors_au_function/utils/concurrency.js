'use strict';

/**
 * concurrency.js
 * -----------------------------------------------------------------------
 * Catalyst answers "429 Concurrency limit reached for the feature COMPONENT"
 * when too many Data Store / Authentication calls are in flight at once (seen
 * against the live project at only a dozen parallel queries). Promise.all over
 * a data-dependent list — "delete these 200 notifications", "check every
 * invited dealer" — fires them all at once, so its worst case grows with the
 * data. This runs the same work with a fixed ceiling.
 */

/**
 * Like `Promise.all(items.map(fn))`, but at most `limit` calls are in flight at
 * a time. Results keep the input order. Rejects with the first error, like
 * Promise.all (callers that must tolerate failures catch inside `fn`).
 */
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  }

  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, list.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

module.exports = { mapWithConcurrency };
