'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.CRM_API_CONCURRENCY_LIMIT = '3';

const { withCrmApiLimit, CRM_API_CONCURRENCY_LIMIT, _test } = require('../services/integrations/crmApiConcurrencyLimiter');

// Covers the fix for the 200+ dealer CRM API concurrency/rate-limit risk:
// no part of this codebase previously bounded how many real outbound CRM
// HTTP calls (Fusion SD, Zoho dealer orgs, generic REST) could be in
// flight simultaneously across the outbound retry sweep, inbound webhook
// deliveries, reconciliation, and admin lookups combined. This is a
// per-crm_type counting semaphore, wrapped around each adapter call site
// (crmIntegrationService.js, dealerReconciliationService.js,
// adminDashboardRoutes.js) without touching any adapter or factory code.

test('CRM_API_CONCURRENCY_LIMIT picks up the env override', () => {
  assert.equal(CRM_API_CONCURRENCY_LIMIT, 3);
});

test('concurrency never exceeds the configured limit for one crm_type', async () => {
  _test._resetForTests();
  let active = 0;
  let maxActive = 0;
  const calls = Array.from({ length: 10 }, () =>
    withCrmApiLimit('ZOHO_CRM', async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return 'ok';
    })
  );

  const results = await Promise.all(calls);

  assert.ok(maxActive <= 3, `expected at most 3 concurrent calls, saw ${maxActive}`);
  assert.equal(results.length, 10);
  assert.ok(results.every((r) => r === 'ok'));
});

test('different dealers (same crm_type) all eventually process, none starved', async () => {
  _test._resetForTests();
  const completed = [];
  const calls = Array.from({ length: 6 }, (_, i) =>
    withCrmApiLimit('GENERIC_REST', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(`dealer-${i}`);
    })
  );

  await Promise.all(calls);

  assert.equal(completed.length, 6, 'every dealer call must eventually run, queueing only delays, never drops');
  assert.equal(new Set(completed).size, 6);
});

test('Fusion SD and Zoho CRM traffic never share a concurrency pool — a Fusion burst cannot delay Zoho calls', async () => {
  _test._resetForTests();
  let fusionActive = 0;
  let maxFusionActive = 0;
  const fusionCalls = Array.from({ length: 10 }, () =>
    withCrmApiLimit('FUSION_SD', async () => {
      fusionActive += 1;
      maxFusionActive = Math.max(maxFusionActive, fusionActive);
      await new Promise((resolve) => setTimeout(resolve, 20));
      fusionActive -= 1;
    })
  );

  // Fire a Zoho call WHILE the Fusion burst (10 calls, limit 3) is still
  // queueing most of itself — it must complete quickly, not wait behind
  // Fusion's queue.
  const zohoStart = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 2)); // let the Fusion burst start queueing
  await withCrmApiLimit('ZOHO_CRM', async () => 'zoho-ok');
  const zohoDuration = Date.now() - zohoStart;

  assert.ok(zohoDuration < 20, `a Zoho call must not be delayed by a concurrent Fusion SD burst (took ${zohoDuration}ms)`);
  await Promise.all(fusionCalls); // drain
  assert.ok(maxFusionActive <= 3);
});

test('one slow call occupies only its own slot — it does not block unrelated concurrent calls for the same crm_type beyond the configured limit', async () => {
  _test._resetForTests();
  const order = [];
  const slow = withCrmApiLimit('ZOHO_CRM', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    order.push('slow');
    return 'slow-done';
  });
  const fastCalls = Array.from({ length: 2 }, (_, i) =>
    withCrmApiLimit('ZOHO_CRM', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(`fast-${i}`);
      return `fast-${i}-done`;
    })
  );

  await Promise.all([slow, ...fastCalls]);

  assert.ok(order[0] !== 'slow', 'the two fast calls sharing the slow call\'s limit-3 pool must finish first, proving they ran concurrently with it, not after it');
});

test('a thrown error does not permanently occupy a concurrency slot', async () => {
  _test._resetForTests();
  await assert.rejects(
    () => withCrmApiLimit('ZOHO_CRM', async () => {
      throw new Error('dealer CRM 500');
    }),
    /dealer CRM 500/
  );

  // If the slot were stuck, this would hang/time out.
  const result = await withCrmApiLimit('ZOHO_CRM', async () => 'recovered');
  assert.equal(result, 'recovered');
});

test('slots are released through finally even when the wrapped function throws asynchronously', async () => {
  _test._resetForTests();
  process.env.CRM_API_CONCURRENCY_LIMIT_TEST_MARKER = '1'; // no-op, documents intent only
  const semaphore = _test.getSemaphore('FUSION_SD');

  await assert.rejects(() => withCrmApiLimit('FUSION_SD', async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error('boom');
  }));

  assert.equal(semaphore.active, 0, 'the semaphore must show zero active holders after the throwing call settles');
});

test('three consecutive full-limit bursts for the same crm_type never deadlock (slots genuinely cycle, not just queue forever)', async () => {
  _test._resetForTests();
  for (let burst = 0; burst < 3; burst += 1) {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => withCrmApiLimit('ZOHO_CRM', async () => 'ok'))
    );
    assert.equal(results.length, 5);
  }
});
