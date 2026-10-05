'use strict';

process.env.CRM_API_CONCURRENCY_LIMIT = '2';
process.env.CRM_API_MAX_QUEUE_DEPTH = '2';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmApiConcurrencyLimiter = require('../services/integrations/crmApiConcurrencyLimiter');

const { withCrmApiLimit, CRM_API_MAX_QUEUE_DEPTH, _test } = crmApiConcurrencyLimiter;

// Covers the approved fix for the claim-TTL/limiter-queue interaction risk
// found in the follow-up audit: crmApiConcurrencyLimiter.js's waiting queue
// was unbounded, so under sustained traffic for one crm_type a request
// could wait long enough to approach/exceed the outbound/inbound claim's
// ~5-minute TTL — reopening the duplicate-processing race the claim system
// exists to prevent. Fixed entirely inside this one file: a per-crm_type
// max queue depth that rejects immediately (CRM_API_QUEUE_FULL, retryable)
// instead of queueing further. No changes to the claim system, claim TTL,
// claim ordering, retry scheduling, inbound replay, or any adapter.

function makeBlockingCall(resolvers) {
  return () => new Promise((resolve) => resolvers.push(resolve));
}

// Resolving the active calls frees their slots, which immediately hands
// them to queued waiters — whose `fn` only runs NOW, pushing NEW resolvers
// onto the same array. A single `.forEach` pass misses those. This drains
// in rounds until nothing new appears, then confirms full settlement.
async function drainAll(resolvers, inFlightPromises) {
  while (resolvers.length > 0) {
    const batch = resolvers.splice(0, resolvers.length);
    batch.forEach((r) => r('done'));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await Promise.all(inFlightPromises);
}

test('CRM_API_MAX_QUEUE_DEPTH picks up the env override', () => {
  assert.equal(CRM_API_MAX_QUEUE_DEPTH, 2);
});

test('default value is 60 when the environment variable is absent/invalid', () => {
  const originalValue = process.env.CRM_API_MAX_QUEUE_DEPTH;
  delete process.env.CRM_API_MAX_QUEUE_DEPTH;
  delete require.cache[require.resolve('../services/integrations/crmApiConcurrencyLimiter')];
  const freshModule = require('../services/integrations/crmApiConcurrencyLimiter');
  assert.equal(freshModule.CRM_API_MAX_QUEUE_DEPTH, 60);

  // Also confirm an invalid (non-numeric) value falls back to the default.
  process.env.CRM_API_MAX_QUEUE_DEPTH = 'not-a-number';
  delete require.cache[require.resolve('../services/integrations/crmApiConcurrencyLimiter')];
  const invalidEnvModule = require('../services/integrations/crmApiConcurrencyLimiter');
  assert.equal(invalidEnvModule.CRM_API_MAX_QUEUE_DEPTH, 60);

  // Restore for subsequent tests in this file.
  process.env.CRM_API_MAX_QUEUE_DEPTH = originalValue;
  delete require.cache[require.resolve('../services/integrations/crmApiConcurrencyLimiter')];
  require('../services/integrations/crmApiConcurrencyLimiter');
});

test('queue accepts requests up to the configured maximum (limit + maxQueueDepth all eventually run)', async () => {
  _test._resetForTests();
  const resolvers = [];
  // limit=2 (active) + maxQueueDepth=2 (queued) = 4 total admitted.
  const calls = Array.from({ length: 4 }, () => withCrmApiLimit('ZOHO_CRM', makeBlockingCall(resolvers)));

  // Let them all settle into active/queued state.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolvers.length, 2, 'only 2 (the concurrency limit) should actually be running; the other 2 are queued, not yet invoked');

  resolvers.forEach((r) => r('first-batch'));
  await new Promise((resolve) => setTimeout(resolve, 10));
  // The 2 queued ones should now be running.
  resolvers.slice(2).forEach((r) => r('second-batch'));

  const results = await Promise.all(calls);
  assert.equal(results.length, 4);
  assert.ok(results.every((r) => r === 'first-batch' || r === 'second-batch'), 'all 4 must complete successfully, none rejected');
});

test('a request beyond the maximum queue depth is rejected immediately with CRM_API_QUEUE_FULL', async () => {
  _test._resetForTests();
  const resolvers = [];
  // Fill 2 active + 2 queued = at capacity.
  const inFlight = Array.from({ length: 4 }, () => withCrmApiLimit('FUSION_SD', makeBlockingCall(resolvers)));
  await new Promise((resolve) => setTimeout(resolve, 10));

  // The 5th request must be rejected immediately, not wait.
  const start = Date.now();
  await assert.rejects(
    () => withCrmApiLimit('FUSION_SD', async () => 'should-not-run'),
    (err) => {
      assert.equal(err.code, 'CRM_API_QUEUE_FULL');
      assert.equal(err.crmType, 'FUSION_SD');
      assert.equal(err.maxQueueDepth, 2);
      assert.match(err.message, /FUSION_SD/);
      return true;
    }
  );
  assert.ok(Date.now() - start < 10, 'rejection must be immediate, not a delayed queue timeout');

  await drainAll(resolvers, inFlight);
});

test('a rejected request never enters the queue (queue length is unaffected by rejection)', async () => {
  _test._resetForTests();
  const resolvers = [];
  const inFlight = Array.from({ length: 4 }, () => withCrmApiLimit('GENERIC_REST', makeBlockingCall(resolvers)));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const semaphore = _test.getSemaphore('GENERIC_REST');
  const queueLengthBefore = semaphore.queue.length;
  assert.equal(queueLengthBefore, 2);

  await assert.rejects(() => withCrmApiLimit('GENERIC_REST', async () => 'nope'));
  assert.equal(semaphore.queue.length, queueLengthBefore, 'a rejected acquisition must not be pushed onto the queue');

  await drainAll(resolvers, inFlight);
});

test('queue depth decreases correctly as queued requests are released, freeing room for new ones', async () => {
  _test._resetForTests();
  const resolvers = [];
  const inFlight = Array.from({ length: 4 }, () => withCrmApiLimit('ZOHO_CRM', makeBlockingCall(resolvers)));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const semaphore = _test.getSemaphore('ZOHO_CRM');
  assert.equal(semaphore.queue.length, 2);

  // A 5th request is rejected while still full.
  await assert.rejects(() => withCrmApiLimit('ZOHO_CRM', async () => 'nope'));

  // Release everything.
  await drainAll(resolvers, inFlight);
  assert.equal(semaphore.queue.length, 0);
  assert.equal(semaphore.active, 0, 'no leaked/negative counters after full drain');

  // A new request now succeeds instead of being rejected.
  const result = await withCrmApiLimit('ZOHO_CRM', async () => 'fresh-capacity');
  assert.equal(result, 'fresh-capacity');
});

test('queue depth is tracked independently per crm_type', async () => {
  _test._resetForTests();
  const resolversA = [];
  const fusionInFlight = Array.from({ length: 4 }, () => withCrmApiLimit('FUSION_SD', makeBlockingCall(resolversA)));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(_test.getSemaphore('FUSION_SD').queue.length, 2);
  assert.equal(_test.getSemaphore('ZOHO_CRM').queue.length, 0, 'an unrelated crm_type must start with an empty queue of its own');

  await drainAll(resolversA, fusionInFlight);
});

test('Zoho can continue processing normally while the Fusion SD queue is completely full', async () => {
  _test._resetForTests();
  const fusionResolvers = [];
  const fusionInFlight = Array.from({ length: 4 }, () => withCrmApiLimit('FUSION_SD', makeBlockingCall(fusionResolvers)));
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Fusion is now completely full (2 active + 2 queued) — the next Fusion
  // call would be rejected...
  await assert.rejects(() => withCrmApiLimit('FUSION_SD', async () => 'nope'));

  // ...but Zoho, a fully independent crm_type, is entirely unaffected.
  const zohoResult = await withCrmApiLimit('ZOHO_CRM', async () => 'zoho-ok');
  assert.equal(zohoResult, 'zoho-ok');

  await drainAll(fusionResolvers, fusionInFlight);
});

test('Fusion SD can continue processing normally while the Zoho queue is completely full', async () => {
  _test._resetForTests();
  const zohoResolvers = [];
  const zohoInFlight = Array.from({ length: 4 }, () => withCrmApiLimit('ZOHO_CRM', makeBlockingCall(zohoResolvers)));
  await new Promise((resolve) => setTimeout(resolve, 10));

  await assert.rejects(() => withCrmApiLimit('ZOHO_CRM', async () => 'nope'));

  const fusionResult = await withCrmApiLimit('FUSION_SD', async () => 'fusion-ok');
  assert.equal(fusionResult, 'fusion-ok');

  await drainAll(zohoResolvers, zohoInFlight);
});

test('existing concurrency limit behavior is unchanged: active calls still never exceed CRM_API_CONCURRENCY_LIMIT', async () => {
  _test._resetForTests();
  let active = 0;
  let maxActive = 0;
  // Exactly limit + maxQueueDepth (4) so none are rejected — isolates the
  // concurrency check from the new queue-depth rejection behavior.
  const calls = Array.from({ length: 4 }, () =>
    withCrmApiLimit('GENERIC_REST', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return 'ok';
    })
  );

  const results = await Promise.all(calls);
  assert.ok(maxActive <= 2, `concurrency limit of 2 must still be enforced exactly as before, saw ${maxActive}`);
  assert.ok(results.every((r) => r === 'ok'));
});
