'use strict';

// Batch 8 (FUSION_REMEDIATION_PLAN.md), audit S1 and the 429 cool-down:
// Fusion allows 300 requests per 60 s per credential, shared by create and
// update (lead API guide, 29 Sep 2026). With FUSION_RATE_BUDGET on, each
// Fusion integration spends at most 80% of that per minute, counted in
// Catalyst Cache so every instance shares one budget (per instance when the
// cache cannot be reached), and after a 429 every caller waits out the
// dealer's Retry-After. A request over budget is never sent: it fails as a
// temporary error and the existing retry paths deliver it later.

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const fusionRateBudget = require('../services/integrations/fusionRateBudget');
const fusionSdAdapter = require('../services/integrations/adapters/fusionSdAdapter');
const fusionSdOAuthHelper = require('../services/integrations/adapters/fusionSdOAuthHelper');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const { classifyDealerError, isRetryableClass } = require('../services/integrations/dealerErrorClassifier');

function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => { if (v === null) delete process.env[k]; else process.env[k] = v; });
  t.after(() => Object.entries(before).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }));
}

// A Catalyst Cache stand-in shared by "instances" (catalystApp objects).
function fakeCache({ failing = false } = {}) {
  const store = new Map();
  const calls = { put: 0, get: 0 };
  const segment = {
    put: async (key, value) => { calls.put += 1; if (failing) throw new Error('cache down'); store.set(key, String(value)); return {}; },
    update: async (key, value) => { calls.put += 1; if (failing) throw new Error('cache down'); store.set(key, String(value)); return {}; },
    getValue: async (key) => { calls.get += 1; if (failing) throw new Error('cache down'); return store.has(key) ? store.get(key) : null; },
  };
  return { app: () => ({ cache: () => ({ segment: () => segment }) }), store, calls };
}

const FUSION = { ROWID: '1001', dealer_code: '725001', crm_type: 'FUSION_SD' };
const WINDOW_START = Date.parse('2026-10-13T06:00:00Z');

async function spend(app, n, now, integration = FUSION) {
  for (let i = 0; i < n; i += 1) await fusionRateBudget.takeSlot(app, integration, now);
}

test('flag off: nothing is counted and nothing is refused', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: null });
  fusionRateBudget._resetForTests();
  const cache = fakeCache();
  await spend(cache.app(), 500, WINDOW_START);
  assert.deepEqual(cache.calls, { put: 0, get: 0 });
  await fusionRateBudget.recordRateLimited(cache.app(), FUSION, 60, WINDOW_START);
  await fusionRateBudget.takeSlot(cache.app(), FUSION, WINDOW_START + 1000);
});

test('flag on: 240 requests a minute (80% of 300); the 241st is refused until the next minute', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true', FUSION_RATE_LIMIT_PER_MINUTE: null, FUSION_RATE_HEADROOM: null });
  fusionRateBudget._resetForTests();
  const app = fakeCache().app();
  await spend(app, 240, WINDOW_START + 5000);
  await assert.rejects(fusionRateBudget.takeSlot(app, FUSION, WINDOW_START + 20000), (err) => {
    assert.equal(err.code, 'FUSION_RATE_BUDGET_EXHAUSTED');
    assert.equal(err.vendor.retryAfter, 40, 'seconds until the minute ends');
    assert.equal(err.response, undefined);
    return true;
  });
  await fusionRateBudget.takeSlot(app, FUSION, WINDOW_START + 60000);
});

test('the limit and headroom are configurable; nonsense values fall back to 300 and 80%', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true', FUSION_RATE_LIMIT_PER_MINUTE: '10', FUSION_RATE_HEADROOM: '0.5' });
  fusionRateBudget._resetForTests();
  const app = fakeCache().app();
  await spend(app, 5, WINDOW_START);
  await assert.rejects(fusionRateBudget.takeSlot(app, FUSION, WINDOW_START), { code: 'FUSION_RATE_BUDGET_EXHAUSTED' });
  process.env.FUSION_RATE_LIMIT_PER_MINUTE = 'lots';
  process.env.FUSION_RATE_HEADROOM = '7';
  assert.equal(fusionRateBudget.budgetPerMinute(), 240);
});

test('each Fusion integration (credential) has its own budget', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true', FUSION_RATE_LIMIT_PER_MINUTE: '10', FUSION_RATE_HEADROOM: '1' });
  fusionRateBudget._resetForTests();
  const app = fakeCache().app();
  await spend(app, 10, WINDOW_START);
  await spend(app, 10, WINDOW_START, { ...FUSION, ROWID: '2002' });
  await assert.rejects(fusionRateBudget.takeSlot(app, FUSION, WINDOW_START), { code: 'FUSION_RATE_BUDGET_EXHAUSTED' });
});

test('two instances share one budget through Catalyst Cache', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true', FUSION_RATE_LIMIT_PER_MINUTE: '10', FUSION_RATE_HEADROOM: '1' });
  fusionRateBudget._resetForTests();
  const cache = fakeCache();
  await spend(cache.app(), 6, WINDOW_START);
  fusionRateBudget._resetForTests(); // the other instance has no local memory
  await spend(cache.app(), 4, WINDOW_START);
  await assert.rejects(fusionRateBudget.takeSlot(cache.app(), FUSION, WINDOW_START), { code: 'FUSION_RATE_BUDGET_EXHAUSTED' });
});

test('if the cache cannot be reached, the budget is still enforced per instance', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true', FUSION_RATE_LIMIT_PER_MINUTE: '10', FUSION_RATE_HEADROOM: '1' });
  fusionRateBudget._resetForTests();
  const app = fakeCache({ failing: true }).app();
  await spend(app, 10, WINDOW_START);
  await assert.rejects(fusionRateBudget.takeSlot(app, FUSION, WINDOW_START), { code: 'FUSION_RATE_BUDGET_EXHAUSTED' });
  const noCache = {};
  fusionRateBudget._resetForTests();
  await spend(noCache, 10, WINDOW_START);
  await assert.rejects(fusionRateBudget.takeSlot(noCache, FUSION, WINDOW_START), { code: 'FUSION_RATE_BUDGET_EXHAUSTED' });
});

test('after a 429 every caller, on every instance, waits out Retry-After', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true' });
  fusionRateBudget._resetForTests();
  const cache = fakeCache();
  await fusionRateBudget.recordRateLimited(cache.app(), FUSION, 30, WINDOW_START);
  fusionRateBudget._resetForTests();
  await assert.rejects(fusionRateBudget.takeSlot(cache.app(), FUSION, WINDOW_START + 10000), (err) => {
    assert.equal(err.code, 'FUSION_COOLDOWN');
    assert.equal(err.vendor.retryAfter, 20);
    return true;
  });
  await fusionRateBudget.takeSlot(cache.app(), FUSION, WINDOW_START + 30000);
  // Another integration (credential) is not cooled down.
  await fusionRateBudget.takeSlot(cache.app(), { ...FUSION, ROWID: '2002' }, WINDOW_START + 10000);
});

test('a 429 without Retry-After cools down for 60 seconds', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true' });
  fusionRateBudget._resetForTests();
  const app = fakeCache().app();
  await fusionRateBudget.recordRateLimited(app, FUSION, undefined, WINDOW_START);
  await assert.rejects(fusionRateBudget.takeSlot(app, FUSION, WINDOW_START + 59000), { code: 'FUSION_COOLDOWN' });
  await fusionRateBudget.takeSlot(app, FUSION, WINDOW_START + 60000);
});

test('a refused request is a temporary failure, retried by the existing paths after its wait', () => {
  const err = fusionRateBudget._test.limitError('FUSION_RATE_BUDGET_EXHAUSTED', 12, FUSION);
  assert.equal(isRetryableClass(classifyDealerError(err)), true);
  assert.equal(err.vendor.retryAfter, 12);
});

// ---- wiring in the Fusion adapter -------------------------------------------

function adapterSetup(t, responses) {
  fusionSdOAuthHelper._resetForTests();
  fusionRateBudget._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_a, _i, type) => (type === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'));
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  const sent = [];
  t.mock.method(axios, 'request', async (config) => {
    sent.push(config.method);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return sent;
}

const integration = { ...FUSION, base_url: 'https://8.8.8.8/api/leadapi', create_lead_endpoint: '/v1/leads', http_method: 'POST' };
function http429(retryAfter) {
  return Object.assign(new Error('429'), {
    response: { status: 429, headers: { 'retry-after': String(retryAfter) }, data: { type: 'https://docs.fusionamspro.com/lead-api/errors/rate_limited' } },
  });
}

test('adapter, flag on: a 429 starts the cool-down, and the next request is not sent', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true' });
  const sent = adapterSetup(t, [http429(45)]);
  await assert.rejects(fusionSdAdapter.createLead({}, integration, { 'contact.firstName': 'A' }));
  await assert.rejects(fusionSdAdapter.updateLead({}, integration, 'lead_1', { enquiryStatus: 'Open' }), { code: 'FUSION_COOLDOWN' });
  assert.deepEqual(sent, ['POST'], 'the PATCH never left');
});

test('adapter, flag on: creates and updates spend the same budget', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true', FUSION_RATE_LIMIT_PER_MINUTE: '2', FUSION_RATE_HEADROOM: '1' });
  const ok = { status: 201, data: { lead_id: 'lead_1' } };
  const sent = adapterSetup(t, [ok, { status: 200, data: {} }]);
  await fusionSdAdapter.createLead({}, integration, { 'contact.firstName': 'A' });
  await fusionSdAdapter.updateLead({}, integration, 'lead_1', { enquiryStatus: 'Open' });
  await assert.rejects(fusionSdAdapter.updateLead({}, integration, 'lead_1', { enquiryStatus: 'Open' }), { code: 'FUSION_RATE_BUDGET_EXHAUSTED' });
  assert.equal(sent.length, 2);
});

test('adapter, flag off: requests are sent exactly as before, 429 or not', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: null });
  const sent = adapterSetup(t, [http429(45), { status: 200, data: {} }]);
  await assert.rejects(fusionSdAdapter.createLead({}, integration, { 'contact.firstName': 'A' }));
  await fusionSdAdapter.updateLead({}, integration, 'lead_1', { enquiryStatus: 'Open' });
  assert.deepEqual(sent, ['POST', 'PATCH']);
});

// Review of Batch 8: the Catalyst SDK's put() is an insert (POST) and
// update() a separate PUT, and a read of a missing key may fail. The budget
// must be shared correctly whichever way the live cache behaves, and a cache
// problem must not write an error log line on every Fusion request.
const logger = require('../utils/logger');

function strictCache() {
  const store = new Map();
  const segment = {
    put: async (key, value) => { if (store.has(key)) throw new Error('Cache key already exists'); store.set(key, String(value)); return {}; },
    update: async (key, value) => { if (!store.has(key)) throw new Error('No such cache key'); store.set(key, String(value)); return {}; },
    getValue: async (key) => { if (!store.has(key)) throw new Error('No such cache key'); return store.get(key); },
  };
  return { app: () => ({ cache: () => ({ segment: () => segment }) }), store };
}

test('review: an insert-only cache still shares one budget across instances', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true', FUSION_RATE_LIMIT_PER_MINUTE: '10', FUSION_RATE_HEADROOM: '1' });
  t.mock.method(logger, 'error', () => {});
  fusionRateBudget._resetForTests();
  const cache = strictCache();
  await spend(cache.app(), 6, WINDOW_START);
  assert.equal(cache.store.get(`fusion_rate_1001_${Math.floor(WINDOW_START / 60000)}`), '6');
  fusionRateBudget._resetForTests(); // another instance
  await spend(cache.app(), 4, WINDOW_START);
  await assert.rejects(fusionRateBudget.takeSlot(cache.app(), FUSION, WINDOW_START), { code: 'FUSION_RATE_BUDGET_EXHAUSTED' });
});

test('review: a 429 cool-down is shared through an insert-only cache, even when renewed', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true' });
  t.mock.method(logger, 'error', () => {});
  fusionRateBudget._resetForTests();
  const cache = strictCache();
  await fusionRateBudget.recordRateLimited(cache.app(), FUSION, 30, WINDOW_START);
  await fusionRateBudget.recordRateLimited(cache.app(), FUSION, 90, WINDOW_START + 1000);
  fusionRateBudget._resetForTests();
  await assert.rejects(fusionRateBudget.takeSlot(cache.app(), FUSION, WINDOW_START + 60000), { code: 'FUSION_COOLDOWN' });
});

test('review: an unreachable cache logs one error a minute, not one per request', async (t) => {
  withEnv(t, { FUSION_RATE_BUDGET: 'true', FUSION_RATE_LIMIT_PER_MINUTE: '100', FUSION_RATE_HEADROOM: '1' });
  fusionRateBudget._resetForTests();
  const errors = t.mock.method(logger, 'error', () => {});
  await spend(fakeCache({ failing: true }).app(), 20, WINDOW_START);
  assert.equal(errors.mock.callCount(), 1);
});
