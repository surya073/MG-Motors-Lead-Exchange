'use strict';

// DEALER_WEBHOOK_RENEWAL_CONCURRENCY is computed once at module load from
// this env var. Node's test runner isolates each test file into its own
// process by default, so this does not affect other test files' view of
// the same module.
process.env.DEALER_WEBHOOK_RENEWAL_CONCURRENCY = '2';
process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const catalyst = require('zcatalyst-sdk-node');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const cronRouter = require('../routes/cronRoutes');

// Covers the fix for the execution-time risk identified in the 200+
// dealer runtime audit: /cron/renew-dealer-webhooks previously processed
// every ZOHO_CRM dealer fully serially, the same unbounded-execution-time
// risk outboundRetryScheduler.js and dealerReconciliationService.js were
// already fixed for. Fixed by reusing their exact chunked-Promise.all
// pattern — zero changes to registerDealerWatchChannel itself, zero
// changes to which dealers are selected (no record cap added, only
// concurrency), zero changes to any other cron route.

function getHandler() {
  const layer = cronRouter.stack.find((l) => l.route && l.route.path === '/cron/renew-dealer-webhooks');
  if (!layer) throw new Error('Could not find /cron/renew-dealer-webhooks route in cronRoutes.js');
  return layer.route.stack[0].handle;
}

function buildFakeReqRes() {
  const req = { headers: { 'x-cron-secret': process.env.CRON_SECRET } };
  let statusCode;
  let jsonBody;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
      return this;
    },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonBody };
}

function buildDealerIntegration(rowId, dealerCode) {
  return {
    ROWID: rowId,
    dealer_code: dealerCode,
    integration_type: 'EXTERNAL_CRM',
    crm_type: 'ZOHO_CRM',
    base_url: `https://${dealerCode.toLowerCase()}.zohoapis.in`,
  };
}

function buildFakeCatalystApp(integrations) {
  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes("FROM dealer_integrations WHERE integration_type = 'EXTERNAL_CRM' AND crm_type = 'ZOHO_CRM'")) {
          return integrations.map((i) => ({ dealer_integrations: i }));
        }
        if (sql.includes('FROM webhook_channels')) {
          return []; // no prior channel — keeps each renewal on the simple "first registration" path
        }
        throw new Error(`Unexpected ZCQL query in test: ${sql}`);
      },
    }),
    datastore: () => ({
      table: () => ({
        insertRow: async (fields) => ({ ROWID: 'generic-row', ...fields }),
      }),
    }),
  };
}

test('dealer webhook renewals run concurrently, never exceeding the configured limit', async (t) => {
  t.mock.method(catalyst, 'initialize', () => buildFakeCatalystApp(
    Array.from({ length: 6 }, (_, i) => buildDealerIntegration(String(100 + i), `AU${100 + i}`))
  ));
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'fake-webhook-secret');

  let active = 0;
  let maxActive = 0;
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });

  const { req, res, getStatus, getJson } = buildFakeReqRes();
  await getHandler()(req, res);

  assert.equal(getStatus(), 200);
  assert.ok(maxActive <= 2, `concurrency limit of 2 must be enforced, saw ${maxActive} concurrent renewals`);
  assert.equal(getJson().results.length, 6, 'all 6 dealers must still be processed');
});

test('all selected dealers are processed even when more exist than the concurrency limit', async (t) => {
  const dealerCount = 9; // not a multiple of the limit (2), exercises a partial final batch
  t.mock.method(catalyst, 'initialize', () => buildFakeCatalystApp(
    Array.from({ length: dealerCount }, (_, i) => buildDealerIntegration(String(200 + i), `AU${200 + i}`))
  ));
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'fake-webhook-secret');
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });

  const { req, res, getJson } = buildFakeReqRes();
  await getHandler()(req, res);

  const results = getJson().results;
  assert.equal(results.length, dealerCount);
  const dealerCodes = new Set(results.map((r) => r.dealerCode));
  assert.equal(dealerCodes.size, dealerCount, 'every distinct dealer must appear exactly once in the results — none skipped, none duplicated');
});

test('one dealer\'s renewal failure does not prevent other dealers from being processed', async (t) => {
  const integrations = [
    buildDealerIntegration('301', 'AU301'),
    buildDealerIntegration('302', 'AU302-FAILS'),
    buildDealerIntegration('303', 'AU303'),
    buildDealerIntegration('304', 'AU304'),
  ];
  t.mock.method(catalyst, 'initialize', () => buildFakeCatalystApp(integrations));
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, integrationId) => {
    if (integrationId === '302') return null; // triggers WEBHOOK_AUTH_NOT_CONFIGURED inside registerDealerWatchChannel
    return 'fake-webhook-secret';
  });
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });

  const { req, res, getStatus, getJson } = buildFakeReqRes();
  await getHandler()(req, res);

  assert.equal(getStatus(), 200, 'the whole cron call must still report success even though one dealer failed');
  const results = getJson().results;
  assert.equal(results.length, 4);
  const failed = results.find((r) => r.dealerCode === 'AU302-FAILS');
  assert.ok(failed && failed.error, 'the failing dealer must be reported with an error, not silently dropped');
  const succeeded = results.filter((r) => r.dealerCode !== 'AU302-FAILS');
  assert.equal(succeeded.length, 3);
  succeeded.forEach((r) => assert.ok(!r.error, 'the other 3 dealers must have succeeded normally'));
});

test('dealer isolation: each dealer renews against its own base_url/credentials, never another dealer\'s', async (t) => {
  const integrations = [
    buildDealerIntegration('401', 'AU401'),
    buildDealerIntegration('402', 'AU402'),
  ];
  t.mock.method(catalyst, 'initialize', () => buildFakeCatalystApp(integrations));
  const secretsRequested = [];
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, integrationId) => {
    secretsRequested.push(integrationId);
    return `secret-for-${integrationId}`;
  });
  const registeredUrls = [];
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) {
      registeredUrls.push(url);
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });

  const { req, res, getJson } = buildFakeReqRes();
  await getHandler()(req, res);

  assert.deepEqual(new Set(secretsRequested), new Set(['401', '402']), 'each dealer\'s own credential must be fetched by its own integration id');
  assert.ok(registeredUrls.some((u) => u.includes('au401.zohoapis.in')));
  assert.ok(registeredUrls.some((u) => u.includes('au402.zohoapis.in')));
  const results = getJson().results;
  assert.equal(results.find((r) => r.dealerCode === 'AU401').dealerCode, 'AU401');
  assert.equal(results.find((r) => r.dealerCode === 'AU402').dealerCode, 'AU402');
});
