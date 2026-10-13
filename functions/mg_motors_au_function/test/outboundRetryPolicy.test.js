'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const pathPolicy = require('../services/integrations/pathPolicyService');
const { _resetForTests: resetSweepGuard } = require('../services/integrations/sweepOverlapGuard');
const { toCatalystDateTime } = require('../utils/dateFormat');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Sets environment variables for one test and restores them afterwards.
function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const apply = (values) => Object.entries(values).forEach(([name, value]) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
  apply(vars);
  t.after(() => apply(before));
}

const classified = (t, extra = {}) => withEnv(t, { OUTBOUND_RETRY_POLICY: 'classified', ...extra });

// An error shaped as the adapters raise it.
const dealerError = (status, code = 'EXTERNAL_CRM_ERROR', vendor) =>
  Object.assign(new Error(`Dealer CRM answered HTTP ${status}`), { code, response: { status }, ...(vendor ? { vendor } : {}) });

const streakStartedAgo = (ms) => toCatalystDateTime(new Date(Date.now() - ms));

async function failUpdate(t, error, options = {}) {
  const harness = setupOutbound(t, options);
  fakeAdapter(t, { updateLead: async () => { throw error; } });
  await assert.rejects(() => crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()));
  return {
    ...harness,
    mapping: harness.db.tables.lead_integrations[0],
    lead: harness.db.tables.leads[0],
  };
}

const minutesUntil = (catalystTime) => (pathPolicy.parseTimestamp(catalystTime).getTime() - Date.now()) / MINUTE;
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.1, `${label}: ${actual} min, expected ${expected}`);

// --- legacy policy: what every deploy does until OUTBOUND_RETRY_POLICY is set ---

test('without OUTBOUND_RETRY_POLICY every failure is retried at the fixed 15 minutes, without limit', async (t) => {
  withEnv(t, { OUTBOUND_RETRY_POLICY: undefined });

  const notFound = await failUpdate(t, dealerError(404, 'NOT_FOUND'));
  assert.equal(notFound.mapping.sync_status, 'FAILED');
  assert.equal(notFound.mapping.retry_count, '1');
  near(minutesUntil(notFound.mapping.next_retry_at), 15, 'interval');
  assert.equal(notFound.lead.sync_status, 'DELIVERY_FAILED');

  const fiftiethTry = await failUpdate(t, dealerError(503), {
    mapping: { sync_status: 'FAILED', retry_count: '50', failure_streak_started_at: streakStartedAgo(10 * MINUTE) },
  });
  assert.equal(fiftiethTry.mapping.sync_status, 'FAILED');
  assert.equal(fiftiethTry.mapping.retry_count, '51');
});

// --- classified policy ---

test('classified: a transient failure backs off 2, 5, 15 ... minutes, capped at 6 hours', async (t) => {
  classified(t, { OUTBOUND_RETRY_MAX_ATTEMPTS: '50', OUTBOUND_RETRY_MAX_AGE_HOURS: '1000' });
  t.mock.method(Math, 'random', () => 0.5); // no jitter

  for (const [previousAttempts, minutes] of [[0, 2], [1, 5], [2, 15], [3, 30], [5, 120], [6, 240], [7, 360], [30, 360]]) {
    const mapping = previousAttempts === 0
      ? {}
      : { sync_status: 'FAILED', retry_count: String(previousAttempts), failure_streak_started_at: streakStartedAgo(MINUTE) };
    const result = await failUpdate(t, dealerError(503), { mapping });
    assert.equal(result.mapping.sync_status, 'FAILED', `after ${previousAttempts}`);
    near(minutesUntil(result.mapping.next_retry_at), minutes, `after ${previousAttempts} failed attempts`);
  }
});

test('classified: jitter spreads a retry by up to 20% either way', async (t) => {
  classified(t);
  const random = t.mock.method(Math, 'random', () => 0);
  near(minutesUntil((await failUpdate(t, dealerError(503))).mapping.next_retry_at), 1.6, 'lowest');
  random.mock.mockImplementation(() => 0.999999);
  near(minutesUntil((await failUpdate(t, dealerError(503))).mapping.next_retry_at), 2.4, 'highest');
});

test("classified: the dealer's Retry-After is honoured when it is longer than the backoff", async (t) => {
  classified(t);
  t.mock.method(Math, 'random', () => 0.5);

  const result = await failUpdate(t, dealerError(429, 'EXTERNAL_CRM_ERROR', { status: 429, retryAfter: 1800 }));

  assert.equal(result.mapping.sync_status, 'FAILED');
  near(minutesUntil(result.mapping.next_retry_at), 30, 'Retry-After');
});

test('classified: our own queue being full (LOCAL) is retried', async (t) => {
  classified(t);
  const result = await failUpdate(t, Object.assign(new Error('queue full'), { code: 'CRM_API_QUEUE_FULL' }));
  assert.equal(result.mapping.sync_status, 'FAILED');
  assert.equal(result.lead.sync_status, 'DELIVERY_FAILED');
});

test('classified: AUTH and PERMANENT failures stop at once as RETRY_EXHAUSTED, without escalating', async (t) => {
  classified(t);

  for (const [error, errorClass] of [[dealerError(401, 'AUTHENTICATION_FAILED'), 'AUTH'], [dealerError(404, 'NOT_FOUND'), 'PERMANENT']]) {
    const result = await failUpdate(t, error);
    assert.equal(result.mapping.sync_status, 'RETRY_EXHAUSTED', error.code);
    assert.equal(result.mapping.last_error, error.code);
    assert.equal(result.lead.sync_status, 'RETRY_EXHAUSTED');
    assert.equal(result.oemWrites.length, 0, 'no Dealer Unavailable write');
    const retry = JSON.parse(result.logs().at(-1).field_changes).find((change) => change.field === 'retry');
    assert.deepEqual(retry, { field: 'retry', class: errorClass, attempt: 1, stopped: 'NOT_RETRYABLE' });
  }
});

test('classified: retries stop as RETRY_EXHAUSTED at OUTBOUND_RETRY_MAX_ATTEMPTS', async (t) => {
  classified(t, { OUTBOUND_RETRY_MAX_ATTEMPTS: '10' });

  const ninth = await failUpdate(t, dealerError(503), {
    mapping: { sync_status: 'FAILED', retry_count: '8', failure_streak_started_at: streakStartedAgo(HOUR) },
  });
  assert.equal(ninth.mapping.sync_status, 'FAILED');

  const tenth = await failUpdate(t, dealerError(503), {
    mapping: { sync_status: 'FAILED', retry_count: '9', failure_streak_started_at: streakStartedAgo(HOUR) },
  });
  assert.equal(tenth.mapping.sync_status, 'RETRY_EXHAUSTED');
  assert.equal(tenth.mapping.retry_count, '10');
  assert.equal(tenth.lead.sync_status, 'RETRY_EXHAUSTED');
});

test('classified: retries stop as RETRY_EXHAUSTED once the failure is older than OUTBOUND_RETRY_MAX_AGE_HOURS', async (t) => {
  classified(t, { OUTBOUND_RETRY_MAX_AGE_HOURS: '48' });

  const result = await failUpdate(t, dealerError(503), {
    mapping: { sync_status: 'FAILED_CRITICAL', retry_count: '3', failure_streak_started_at: streakStartedAgo(49 * HOUR) },
  });

  assert.equal(result.mapping.sync_status, 'RETRY_EXHAUSTED');
  assert.equal(result.lead.sync_status, 'RETRY_EXHAUSTED', 'stopped, even though the streak is past the escalation window');
});

test('a RETRY_EXHAUSTED lead is left out of the retry sweep, and a later success counts as a recovery', async (t) => {
  classified(t);
  const harness = setupOutbound(t, {
    mapping: { sync_status: 'RETRY_EXHAUSTED', retry_count: '10', failure_streak_started_at: streakStartedAgo(HOUR) },
    lead: { sync_status: 'RETRY_EXHAUSTED' },
  });
  const calls = fakeAdapter(t, { updateLead: async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} }) });

  resetSweepGuard();
  const sweep = await outboundRetryScheduler.runOutboundRetrySweep(harness.db.app, { ignoreSchedule: true });
  assert.equal(sweep.attempted, 0);
  assert.equal(calls.update.length, 0);

  // The lead is edited in the OEM CRM (or replayed by an admin) and delivered.
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(result.ok, true);
  assert.equal(result.scenarioCode, 'Happy 4');
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'SYNCED');
});
