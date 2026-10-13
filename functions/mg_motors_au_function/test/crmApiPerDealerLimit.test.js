'use strict';

// Batch 8 (FUSION_REMEDIATION_PLAN.md): the CRM call limiter caps calls per
// crm_type, and its comment assumed one busy dealer could not starve the
// others; nothing enforced that. CRM_API_PER_DEALER_LIMIT (unset = no
// per-dealer cap, as before) limits how many calls one dealer integration
// can have in flight, so the rest of its type's slots stay free for others.

const test = require('node:test');
const assert = require('node:assert/strict');

const limiter = require('../services/integrations/crmApiConcurrencyLimiter');
const { getCrmApiPerDealerLimit } = require('../config/env');

function withLimit(t, value) {
  const before = process.env.CRM_API_PER_DEALER_LIMIT;
  if (value === null) delete process.env.CRM_API_PER_DEALER_LIMIT; else process.env.CRM_API_PER_DEALER_LIMIT = value;
  t.after(() => { if (before === undefined) delete process.env.CRM_API_PER_DEALER_LIMIT; else process.env.CRM_API_PER_DEALER_LIMIT = before; });
  limiter._test._resetForTests();
}

// Starts `count` calls for `dealer` that stay in flight until released.
function startCalls(dealer, count, flight) {
  const releases = [];
  const done = [];
  for (let i = 0; i < count; i += 1) {
    done.push(limiter.withCrmApiLimit('FUSION_SD', () => new Promise((resolve) => {
      flight[dealer] = (flight[dealer] || 0) + 1;
      flight.peak[dealer] = Math.max(flight.peak[dealer] || 0, flight[dealer]);
      releases.push(() => { flight[dealer] -= 1; resolve(); });
    }), dealer));
  }
  return { releases, done };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('CRM_API_PER_DEALER_LIMIT: unset or not a positive whole number means no per-dealer cap', (t) => {
  for (const value of [null, '', '0', '-2', 'two', '1.5']) {
    withLimit(t, value);
    assert.equal(getCrmApiPerDealerLimit(), null, String(value));
  }
  process.env.CRM_API_PER_DEALER_LIMIT = '3';
  assert.equal(getCrmApiPerDealerLimit(), 3);
});

test('set: one busy dealer holds at most its cap; another dealer still gets a slot at once', async (t) => {
  withLimit(t, '2');
  const flight = { peak: {} };
  const a = startCalls('A', 6, flight);
  await tick();
  assert.equal(flight.A, 2);
  const b = startCalls('B', 1, flight);
  await tick();
  assert.equal(flight.B, 1, 'dealer B is not stuck behind A');
  while (a.releases.length || b.releases.length) {
    (a.releases.shift() || b.releases.shift())();
    await tick();
  }
  await Promise.all([...a.done, ...b.done]);
  assert.equal(flight.peak.A, 2);
});

test('unset: a single dealer can use every slot of its type, as before', async (t) => {
  withLimit(t, null);
  const flight = { peak: {} };
  const a = startCalls('A', 6, flight);
  await tick();
  assert.equal(flight.A, 6);
  a.releases.forEach((release) => release());
  await Promise.all(a.done);
});

test('a call without a dealer key is limited by its type only', async (t) => {
  withLimit(t, '1');
  let inFlight = 0;
  let peak = 0;
  const calls = [1, 2, 3].map(() => limiter.withCrmApiLimit('ZOHO_CRM', async () => {
    inFlight += 1; peak = Math.max(peak, inFlight); await tick(); inFlight -= 1;
  }));
  await Promise.all(calls);
  assert.equal(peak, 3);
});

test('a failing call releases its dealer slot', async (t) => {
  withLimit(t, '1');
  await assert.rejects(limiter.withCrmApiLimit('FUSION_SD', async () => { throw new Error('boom'); }, 'A'));
  assert.equal(await limiter.withCrmApiLimit('FUSION_SD', async () => 'ok', 'A'), 'ok');
});
