'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const cronRoutes = require('../routes/cronRoutes');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const dealerReconciliationService = require('../services/integrations/dealerReconciliationService');
const integrationAlertBatchService = require('../services/integrations/integrationAlertBatchService');

// /cron/fast-recover (every 2 minutes in the deployed project) retried every
// failed lead on every run, ignoring next_retry_at. FAST_RECOVER_HONOUR_SCHEDULE
// now waits for each lead's own retry time by default; explicit false preserves
// the legacy operator override.
async function runFastRecover(t, honourSchedule) {
  const before = process.env.FAST_RECOVER_HONOUR_SCHEDULE;
  if (honourSchedule === undefined) delete process.env.FAST_RECOVER_HONOUR_SCHEDULE;
  else process.env.FAST_RECOVER_HONOUR_SCHEDULE = honourSchedule;
  t.after(() => {
    if (before === undefined) delete process.env.FAST_RECOVER_HONOUR_SCHEDULE;
    else process.env.FAST_RECOVER_HONOUR_SCHEDULE = before;
  });

  const sweep = t.mock.method(outboundRetryScheduler, 'runOutboundRetrySweep', async () => ({ recovered: 0 }));
  t.mock.method(inboundReplayScheduler, 'runInboundReplaySweep', async () => ({}));
  t.mock.method(slaMonitorService, 'runSlaSweep', async () => ({}));
  t.mock.method(dealerReconciliationService, 'runDealerReconciliation', async () => ({}));
  t.mock.method(integrationAlertBatchService, 'flushIfWindowElapsed', async () => ({}));
  t.mock.method(catalyst, 'initialize', () => ({}));

  const server = express();
  server.use(express.json());
  server.use(cronRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());

  const response = await fetch(`http://127.0.0.1:${listener.address().port}/cron/fast-recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': process.env.CRON_SECRET },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(sweep.mock.callCount(), 1);
  const options = sweep.mock.calls[0].arguments[1];
  assert.ok(Number.isFinite(options.deadline), 'fast-recover always has an end-to-end start budget');
  assert.ok(options.deadline <= Date.now() + 25000);
  assert.ok(Number.isSafeInteger(options.windowSequence), 'candidate rotation has a stage-cycle sequence');
  const { deadline, windowSequence, ...retryOptions } = options;
  return retryOptions;
}

test('fast-recover respects next_retry_at by default', async (t) => {
  assert.deepEqual(await runFastRecover(t, undefined), { ignoreSchedule: false, includeRoutingHolds: true });
});

test('explicit false preserves the legacy fast-recover schedule override', async (t) => {
  assert.deepEqual(await runFastRecover(t, 'false'), { ignoreSchedule: true, includeRoutingHolds: true });
});

test('FAST_RECOVER_HONOUR_SCHEDULE=true makes fast-recover wait for each lead\'s next_retry_at', async (t) => {
  assert.deepEqual(await runFastRecover(t, 'true'), { ignoreSchedule: false, includeRoutingHolds: true });
});
