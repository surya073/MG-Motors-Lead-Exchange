'use strict';

/**
 * crmApiConcurrencyLimiter.js
 * -----------------------------------------------------------------------
 * Added for the 200+ dealer scale audit: nothing in this codebase bounded
 * how many outbound CRM API calls (Fusion SD, Zoho dealer orgs, generic
 * REST dealers) could be in flight at once. At 100-200+ active dealers,
 * several independent sources can all fire real HTTP calls through
 * crmAdapterFactory.getAdapter(...) at the same time: the outbound retry
 * sweep's own bounded batches, many simultaneous inbound webhook
 * deliveries (each doing its own adapter.getLead for a Zoho-dealer
 * notification), dealer reconciliation, and admin-triggered lookups —
 * including one genuinely UNBOUNDED `Promise.all` over up to 25 live
 * dealer lookups in routes/adminDashboardRoutes.js's out-of-order-events
 * enrichment. None of these sources coordinate with each other, so their
 * concurrent HTTP calls simply stack on top of one another with no cap.
 *
 * SCOPE: this bounds how many calls THIS application makes concurrently
 * — a self-protection measure for Catalyst's execution environment and
 * Node's event loop, not an attempt to honor any CRM provider's actual
 * rate limit (which is not documented/configured anywhere in this
 * project, so it is deliberately not guessed at or hardcoded here).
 *
 * PER-CRM-TYPE, not global and not per-dealer: each crm_type ('FUSION_SD',
 * 'ZOHO_CRM', 'GENERIC_REST', and any future type) gets its own
 * independent limiter instance, so a burst of Fusion SD traffic can never
 * delay Zoho traffic waiting on an unrelated downstream service, and vice
 * versa. Within one crm_type's limiter, many different dealers share the
 * same pool — this still lets up to CRM_API_CONCURRENCY_LIMIT different
 * dealers of that type process fully concurrently (comfortably covering
 * "different dealers must not block each other" in practice), without
 * the unbounded memory growth and per-dealer bookkeeping a literal
 * per-dealer limiter would add for no real benefit: one dealer's slow
 * call occupies at most one slot in its type's pool, never more.
 *
 * Deliberately a small hand-rolled counting semaphore, not a new npm
 * dependency — this codebase already has a precedent for hand-rolled
 * bounded concurrency (dealerReconciliationService.js's chunked
 * Promise.all) rather than pulling in a queue/rate-limit library for a
 * need this narrow.
 *
 * WHY WRAPPED AT CALL SITES, NOT INSIDE crmAdapterFactory.getAdapter():
 * wrapping the adapter object the factory returns would mean
 * getAdapter('FUSION_SD') no longer === the real fusionSdAdapter module,
 * breaking existing reference-equality tests and anything else that
 * resolves an adapter and expects the literal module back. Wrapping each
 * call to adapter.createLead/updateLead/getLead/testConnection instead
 * touches zero adapter internals and zero factory behavior — the
 * fsdapters, the factory's resolution contract, and every existing test
 * built around them are completely unaffected.
 *
 * QUEUE DEPTH CAP (added after a follow-up audit): a lead's outbound/
 * inbound claim (outboundSyncClaimService.js) is acquired BEFORE this
 * limiter is ever reached, and is held for the limiter's entire wait —
 * queueing time plus the call itself. The queue above was originally
 * unbounded, so under sustained traffic for one crm_type (especially a
 * slow/timing-out CRM holding every active slot near its own timeout),
 * a request's wait could approach or exceed the claim's ~5-minute TTL,
 * letting a second caller reclaim a claim that was never actually
 * abandoned — reopening the exact duplicate-processing race the claim
 * system exists to prevent. CRM_API_MAX_QUEUE_DEPTH bounds the worst-case
 * wait by bounding how many requests can ever be waiting at once, rather
 * than touching the claim TTL or its ordering (neither of which this
 * file has any business changing). Sized at the default concurrency (10)
 * and the adapters' own worst-case timeout (10s): 60 queued requests ×
 * 10s ÷ 10 concurrent ≈ 60s worst-case wait, a comfortable fraction of
 * the ~300s claim TTL. A request beyond that depth is rejected
 * immediately with a CRM_API_QUEUE_FULL error instead of queueing — it
 * is never added to the queue, so this cannot leak a counter or leave a
 * negative depth. That error carries no `err.response` and a code absent
 * from every "non-retryable" list this codebase's callers check, so it
 * is classified and retried exactly like any other transient CRM
 * failure, through the existing retry/backoff/held-for-replay paths —
 * no new retry mechanism is introduced.
 */

const DEFAULT_CRM_API_CONCURRENCY_LIMIT = 10;
const configuredLimit = Number(process.env.CRM_API_CONCURRENCY_LIMIT);
const CRM_API_CONCURRENCY_LIMIT = Number.isFinite(configuredLimit) && configuredLimit >= 1
  ? configuredLimit
  : DEFAULT_CRM_API_CONCURRENCY_LIMIT;

const DEFAULT_CRM_API_MAX_QUEUE_DEPTH = 60;
const configuredMaxQueueDepth = Number(process.env.CRM_API_MAX_QUEUE_DEPTH);
// >= 0, not >= 1: unlike the concurrency limit (where 0 would mean nothing
// can ever run — nonsensical), a queue depth of 0 is a legitimate
// configuration ("never queue, reject immediately once the concurrency
// limit is reached") and must not be silently overridden to the default.
const CRM_API_MAX_QUEUE_DEPTH = Number.isFinite(configuredMaxQueueDepth) && configuredMaxQueueDepth >= 0
  ? configuredMaxQueueDepth
  : DEFAULT_CRM_API_MAX_QUEUE_DEPTH;

function buildQueueFullError(crmType, maxQueueDepth) {
  const err = new Error(
    `CRM API concurrency queue is full for crm_type "${crmType}" (${maxQueueDepth} requests already queued) — ` +
    'treat as a transient failure and retry.'
  );
  err.code = 'CRM_API_QUEUE_FULL';
  err.crmType = crmType;
  err.maxQueueDepth = maxQueueDepth;
  return err;
}

class Semaphore {
  constructor(limit, { crmType = 'UNKNOWN', maxQueueDepth = CRM_API_MAX_QUEUE_DEPTH } = {}) {
    this.limit = limit;
    this.crmType = crmType;
    this.maxQueueDepth = maxQueueDepth;
    this.active = 0;
    this.queue = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueueDepth) {
      // Rejected immediately — never pushed to `queue`, `active` never
      // touched, so this cannot leak a slot or leave a negative depth.
      return Promise.reject(buildQueueFullError(this.crmType, this.maxQueueDepth));
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      // Hand the freed slot straight to the oldest waiter — `active`
      // stays the same (one holder finishes, the next starts).
      next();
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }
}

const semaphoresByCrmType = new Map();

function getSemaphore(crmType) {
  const key = crmType || 'UNKNOWN';
  if (!semaphoresByCrmType.has(key)) {
    semaphoresByCrmType.set(key, new Semaphore(CRM_API_CONCURRENCY_LIMIT, { crmType: key, maxQueueDepth: CRM_API_MAX_QUEUE_DEPTH }));
  }
  return semaphoresByCrmType.get(key);
}

/**
 * Runs `fn` (an actual CRM API call) once a concurrency slot for this
 * crm_type is available. The slot is always released — success, thrown
 * error, or timeout — via `finally`, so a failure can never permanently
 * occupy it. This is purely a queueing delay: it never changes what `fn`
 * returns or throws, so retry/error-handling/claim behavior built around
 * these calls is unaffected.
 *
 * If this crm_type's queue is already at CRM_API_MAX_QUEUE_DEPTH, `fn` is
 * never called at all — acquire() rejects with CRM_API_QUEUE_FULL before
 * a slot is ever granted, so `release()` is correctly never reached for a
 * rejected acquisition (nothing to release).
 */
async function withCrmApiLimit(crmType, fn) {
  const semaphore = getSemaphore(crmType);
  await semaphore.acquire();
  try {
    return await fn();
  } finally {
    semaphore.release();
  }
}

/** Test-only: clears per-crm_type semaphore state between test runs. */
function _resetForTests() {
  semaphoresByCrmType.clear();
}

module.exports = {
  withCrmApiLimit,
  CRM_API_CONCURRENCY_LIMIT,
  CRM_API_MAX_QUEUE_DEPTH,
  _test: { getSemaphore, _resetForTests, Semaphore },
};
