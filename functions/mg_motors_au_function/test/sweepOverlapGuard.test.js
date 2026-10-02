'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { guardSweep, _resetForTests } = require('../services/integrations/sweepOverlapGuard');

// Covers the overlap-guard fix added for the 200+ dealer concurrency
// audit: outboundRetryScheduler/inboundReplayScheduler/
// dealerReconciliationService/slaMonitorService previously had zero
// protection against the same sweep being re-entered before its
// previous run finished on the same warm instance.

test('guardSweep: a second concurrent call is skipped while the first is still running', async () => {
  _resetForTests();
  let runCount = 0;
  const guarded = guardSweep('test-sweep-a', async () => {
    runCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, run: runCount };
  });

  const [first, second] = await Promise.all([guarded(), guarded()]);

  assert.equal(runCount, 1, 'the wrapped function should execute exactly once for two overlapping calls');
  assert.deepEqual(first, { ok: true, run: 1 });
  assert.deepEqual(second, { skipped: true, reason: 'SWEEP_ALREADY_RUNNING', sweep: 'test-sweep-a' });
});

test('guardSweep: a later call succeeds once the previous run has finished', async () => {
  _resetForTests();
  let runCount = 0;
  const guarded = guardSweep('test-sweep-b', async () => {
    runCount += 1;
    return { ok: true, run: runCount };
  });

  const first = await guarded();
  const second = await guarded();

  assert.equal(runCount, 2);
  assert.deepEqual(first, { ok: true, run: 1 });
  assert.deepEqual(second, { ok: true, run: 2 });
});

test('guardSweep: different sweep names never block each other', async () => {
  _resetForTests();
  const guardedA = guardSweep('test-sweep-c', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 'a';
  });
  const guardedB = guardSweep('test-sweep-d', async () => 'b');

  const [a, b] = await Promise.all([guardedA(), guardedB()]);

  assert.equal(a, 'a');
  assert.equal(b, 'b');
});

test('guardSweep: a thrown error releases the guard so the next call can run', async () => {
  _resetForTests();
  let attempt = 0;
  const guarded = guardSweep('test-sweep-e', async () => {
    attempt += 1;
    if (attempt === 1) throw new Error('boom');
    return 'recovered';
  });

  await assert.rejects(() => guarded(), /boom/);
  const result = await guarded();
  assert.equal(result, 'recovered');
});
