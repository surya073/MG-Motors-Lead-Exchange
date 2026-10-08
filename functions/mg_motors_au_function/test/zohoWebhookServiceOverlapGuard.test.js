'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const zohoAuthService = require('../services/zohoAuthService');
const zohoWebhookService = require('../services/zohoWebhookService');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const { _resetForTests: resetSweepGuard } = require('../services/integrations/sweepOverlapGuard');

// Covers the approved fix: registerWatchChannels (OEM) and
// registerDealerWatchChannel now reuse the existing sweepOverlapGuard.js
// mechanism (the same one already protecting outboundRetryScheduler.js,
// inboundReplayScheduler.js, dealerReconciliationService.js,
// slaMonitorService.js) to prevent two overlapping renewal runs. OEM uses
// one static key ('oemWebhookRenewal') since there is only ever one OEM
// channel; dealer renewal uses a PER-DEALER dynamic key
// (`dealerWebhookRenewal:<dealer_code>`) — a deliberate, user-approved
// resolution to a real conflict: a single shared key would have silently
// collapsed cronRoutes.js's existing 6-way concurrent dealer batching
// down to 1, since guardSweep treats a second concurrent call with the
// SAME key as "already running" and skips it.

function buildFakeCatalystApp({ existingRows = [] } = {}) {
  const insertedRows = [];
  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM webhook_channels')) {
          if (sql.includes("module_name = 'Dealers,Leads'")) {
            return existingRows.filter((r) => r.module_name === 'Dealers,Leads').map((r) => ({ webhook_channels: r }));
          }
          const dealerMatch = /dealer_code = '([^']*)'/.exec(sql);
          if (dealerMatch) {
            return existingRows.filter((r) => r.dealer_code === dealerMatch[1]).map((r) => ({ webhook_channels: r }));
          }
          return [];
        }
        throw new Error(`Unexpected ZCQL query in test: ${sql}`);
      },
    }),
    datastore: () => ({
      table: () => ({
        insertRow: async (fields) => {
          insertedRows.push(fields);
          return { ROWID: `new-${insertedRows.length}`, ...fields };
        },
      }),
    }),
    _insertedRows: insertedRows,
  };
}

function mockWatchApiSuccess(t, { registerDelayMs = 0 } = {}) {
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) {
      if (registerDelayMs) await new Promise((resolve) => setTimeout(resolve, registerDelayMs));
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });
  t.mock.method(axios, 'delete', async () => ({ data: {} }));
}

function buildIntegration(rowId, dealerCode) {
  return { ROWID: rowId, dealer_code: dealerCode, base_url: `https://${dealerCode.toLowerCase()}.zohoapis.in` };
}

test('OEM: first renewal acquires the guard and succeeds', async (t) => {
  resetSweepGuard();
  zohoAuthService._resetForTests();
  mockWatchApiSuccess(t);
  const catalystApp = buildFakeCatalystApp();

  const result = await zohoWebhookService.registerWatchChannels(catalystApp);

  assert.ok(result.channelId);
  assert.equal(result.skipped, undefined);
});

test('OEM: a second overlapping renewal is skipped while the first is still running', async (t) => {
  resetSweepGuard();
  zohoAuthService._resetForTests();
  mockWatchApiSuccess(t, { registerDelayMs: 20 });
  const catalystApp = buildFakeCatalystApp();

  const [first, second] = await Promise.all([
    zohoWebhookService.registerWatchChannels(catalystApp),
    zohoWebhookService.registerWatchChannels(catalystApp),
  ]);

  const outcomes = [first, second];
  const skipped = outcomes.filter((o) => o.skipped);
  const succeeded = outcomes.filter((o) => !o.skipped);
  assert.equal(skipped.length, 1, 'exactly one overlapping OEM renewal must be skipped');
  assert.equal(skipped[0].reason, 'SWEEP_ALREADY_RUNNING');
  assert.equal(succeeded.length, 1);
  assert.ok(succeeded[0].channelId);
});

test('OEM: the guard is released after a successful renewal, allowing a later call to run', async (t) => {
  resetSweepGuard();
  zohoAuthService._resetForTests();
  mockWatchApiSuccess(t);
  const catalystApp = buildFakeCatalystApp();

  const first = await zohoWebhookService.registerWatchChannels(catalystApp);
  const second = await zohoWebhookService.registerWatchChannels(catalystApp);

  assert.ok(first.channelId);
  assert.ok(second.channelId, 'a later, non-overlapping call must succeed, not be skipped');
});

test('OEM: the guard is released even when the renewal throws, so a later call is not blocked forever', async (t) => {
  resetSweepGuard();
  zohoAuthService._resetForTests();
  let callCount = 0;
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) {
      callCount += 1;
      if (callCount === 1) throw Object.assign(new Error('Zoho API down'), { response: { data: { code: 'SERVER_ERROR' } } });
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });
  t.mock.method(axios, 'delete', async () => ({ data: {} }));
  const catalystApp = buildFakeCatalystApp();

  await assert.rejects(() => zohoWebhookService.registerWatchChannels(catalystApp));
  const recovered = await zohoWebhookService.registerWatchChannels(catalystApp);
  assert.ok(recovered.channelId, 'the guard must be released after a thrown error, not left stuck');
});

test('Dealer: first renewal for a dealer acquires the guard and succeeds', async (t) => {
  resetSweepGuard();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  mockWatchApiSuccess(t);
  const catalystApp = buildFakeCatalystApp();
  const integration = buildIntegration('601', 'AU601');

  const result = await zohoWebhookService.registerDealerWatchChannel(catalystApp, integration);

  assert.equal(result.dealerCode, 'AU601');
  assert.equal(result.skipped, undefined);
});

test('Dealer: a second overlapping renewal for the SAME dealer is skipped', async (t) => {
  resetSweepGuard();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  mockWatchApiSuccess(t, { registerDelayMs: 20 });
  const catalystApp = buildFakeCatalystApp();
  const integration = buildIntegration('602', 'AU602');

  const [first, second] = await Promise.all([
    zohoWebhookService.registerDealerWatchChannel(catalystApp, integration),
    zohoWebhookService.registerDealerWatchChannel(catalystApp, integration),
  ]);

  const outcomes = [first, second];
  const skipped = outcomes.filter((o) => o.skipped);
  const succeeded = outcomes.filter((o) => !o.skipped);
  assert.equal(skipped.length, 1, 'exactly one overlapping renewal for the SAME dealer must be skipped');
  assert.equal(skipped[0].reason, 'SWEEP_ALREADY_RUNNING');
  assert.equal(succeeded.length, 1);
  assert.equal(succeeded[0].dealerCode, 'AU602');
});

test('Dealer: the guard is released after a successful renewal for that dealer', async (t) => {
  resetSweepGuard();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  mockWatchApiSuccess(t);
  const catalystApp = buildFakeCatalystApp();
  const integration = buildIntegration('603', 'AU603');

  const first = await zohoWebhookService.registerDealerWatchChannel(catalystApp, integration);
  const second = await zohoWebhookService.registerDealerWatchChannel(catalystApp, integration);

  assert.equal(first.dealerCode, 'AU603');
  assert.equal(second.dealerCode, 'AU603', 'a later, non-overlapping call for the same dealer must succeed, not be skipped');
});

test('Dealer: the guard is released even when renewal throws for that dealer', async (t) => {
  resetSweepGuard();
  zohoAuthService._resetForTests();
  const integration = buildIntegration('604', 'AU604');
  let webhookSecretCallCount = 0;
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) => {
    if (credType !== 'WEBHOOK_SECRET') return 'oauth-value'; // dealer OAuth creds always available
    webhookSecretCallCount += 1;
    // First attempt: no webhook secret configured yet -> WEBHOOK_AUTH_NOT_CONFIGURED.
    // Second attempt: configured -> succeeds.
    return webhookSecretCallCount === 1 ? null : 'secret';
  });
  mockWatchApiSuccess(t);
  const catalystApp = buildFakeCatalystApp();

  await assert.rejects(
    () => zohoWebhookService.registerDealerWatchChannel(catalystApp, integration),
    (err) => err.code === 'WEBHOOK_AUTH_NOT_CONFIGURED'
  );
  const recovered = await zohoWebhookService.registerDealerWatchChannel(catalystApp, integration);
  assert.equal(recovered.dealerCode, 'AU604', 'the guard must be released after a thrown error for this dealer, not left stuck');
});

test('Normal sequential executions continue to work for both OEM and dealer renewal', async (t) => {
  resetSweepGuard();
  zohoAuthService._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  mockWatchApiSuccess(t);
  const catalystApp = buildFakeCatalystApp();
  const integration = buildIntegration('605', 'AU605');

  const oem1 = await zohoWebhookService.registerWatchChannels(catalystApp);
  const dealer1 = await zohoWebhookService.registerDealerWatchChannel(catalystApp, integration);
  const oem2 = await zohoWebhookService.registerWatchChannels(catalystApp);
  const dealer2 = await zohoWebhookService.registerDealerWatchChannel(catalystApp, integration);

  [oem1, dealer1, oem2, dealer2].forEach((r) => assert.equal(r.skipped, undefined, 'sequential (non-overlapping) calls must never be skipped'));
});

test('OEM and dealer guards use independent keys: an in-progress OEM renewal does not block a concurrent dealer renewal, or vice versa', async (t) => {
  resetSweepGuard();
  zohoAuthService._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  mockWatchApiSuccess(t, { registerDelayMs: 15 });
  const catalystApp = buildFakeCatalystApp();
  const integration = buildIntegration('606', 'AU606');

  const [oemResult, dealerResult] = await Promise.all([
    zohoWebhookService.registerWatchChannels(catalystApp),
    zohoWebhookService.registerDealerWatchChannel(catalystApp, integration),
  ]);

  assert.equal(oemResult.skipped, undefined, 'OEM renewal must not be blocked by a concurrent dealer renewal');
  assert.equal(dealerResult.skipped, undefined, 'dealer renewal must not be blocked by a concurrent OEM renewal');
});

test('Existing dealer concurrency is unaffected: different dealers renew fully concurrently, never blocking each other', async (t) => {
  resetSweepGuard();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  mockWatchApiSuccess(t, { registerDelayMs: 15 });
  const catalystApp = buildFakeCatalystApp();

  const integrations = Array.from({ length: 6 }, (_, i) => buildIntegration(String(700 + i), `AU${700 + i}`));
  const results = await Promise.all(integrations.map((integration) => zohoWebhookService.registerDealerWatchChannel(catalystApp, integration)));

  assert.equal(results.length, 6);
  results.forEach((r, i) => {
    assert.equal(r.skipped, undefined, `dealer ${integrations[i].dealer_code} must not be skipped — different dealers must run fully concurrently`);
    assert.equal(r.dealerCode, integrations[i].dealer_code);
  });
});
