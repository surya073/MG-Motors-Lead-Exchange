'use strict';

// zohoWebhookService.js reads Zoho config via a destructured getZohoConfig
// at call time and getAccessToken/getAccessTokenForDealerZoho via
// destructured imports — none of these are property-mockable after the
// fact (same reason as other OAuth-adjacent test files this session). Env
// vars are set directly; axios.post/axios.delete (used by every layer
// here, none of them destructured) are mocked instead.
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

// Covers the approved fix: registerWatchChannels (OEM) previously never
// deregistered its own previous watch channel before creating a new one,
// unlike registerDealerWatchChannel, which already did — confirmed by
// that function's own pre-existing comment describing exactly this bug.
// Fixed by generalizing the existing deregisterExistingChannel helper to
// accept a dealerCode (string) or null (OEM scope), rather than adding a
// second helper or duplicating the deregistration logic.

function buildFakeCatalystApp({ existingRows = [] }) {
  const insertedRows = [];
  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM webhook_channels')) {
          if (sql.includes("module_name = 'Dealers,Leads'")) {
            return existingRows
              .filter((r) => r.module_name === 'Dealers,Leads')
              .map((r) => ({ webhook_channels: r }));
          }
          const dealerMatch = /dealer_code = '([^']*)'/.exec(sql);
          if (dealerMatch) {
            return existingRows
              .filter((r) => r.dealer_code === dealerMatch[1])
              .map((r) => ({ webhook_channels: r }));
          }
          return [];
        }
        throw new Error(`Unexpected ZCQL query in test: ${sql}`);
      },
    }),
    datastore: () => ({
      table: (tableName) => {
        if (tableName === 'webhook_channels') {
          return {
            insertRow: async (fields) => {
              insertedRows.push(fields);
              return { ROWID: `new-${insertedRows.length}`, ...fields };
            },
          };
        }
        throw new Error(`Unexpected table in test: ${tableName}`);
      },
    }),
    _insertedRows: insertedRows,
  };
}

function mockWatchApiSuccess(t) {
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) {
      return { data: { access_token: 'tok', expires_in: 3600 } };
    }
    if (url.includes('/crm/v8/actions/watch')) {
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    throw new Error(`Unexpected axios.post URL in test: ${url}`);
  });
}

test('registerWatchChannels: deregisters the existing OEM channel BEFORE registering the new one', async (t) => {
  zohoAuthService._resetForTests();
  const callOrder = [];
  const deleteCalls = [];

  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) {
      callOrder.push('register');
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });
  t.mock.method(axios, 'delete', async (url, config) => {
    callOrder.push('deregister');
    deleteCalls.push(config.params.channel_ids);
    return { data: {} };
  });

  const catalystApp = buildFakeCatalystApp({
    existingRows: [{ channel_id: '111', module_name: 'Dealers,Leads' }],
  });

  await zohoWebhookService.registerWatchChannels(catalystApp);

  assert.deepEqual(callOrder, ['deregister', 'register'], 'deregistration must happen before the new channel is registered, not after');
  assert.deepEqual(deleteCalls, ['111'], 'the correct existing OEM channel id must be targeted');
});

test('registerWatchChannels: identifies the OEM channel via module_name, never via a dealer_code filter, and cannot match a dealer row', async (t) => {
  zohoAuthService._resetForTests();
  mockWatchApiSuccess(t);
  const deleteCalls = [];
  t.mock.method(axios, 'delete', async (url, config) => {
    deleteCalls.push(config.params.channel_ids);
    return { data: {} };
  });

  // Seed BOTH an OEM row and an unrelated dealer row with a different id —
  // only the OEM one must ever be targeted.
  const catalystApp = buildFakeCatalystApp({
    existingRows: [
      { channel_id: 'oem-channel', module_name: 'Dealers,Leads' },
      { channel_id: 'dealer-channel', module_name: 'Leads', dealer_code: 'AU777' },
    ],
  });

  await zohoWebhookService.registerWatchChannels(catalystApp);

  assert.deepEqual(deleteCalls, ['oem-channel'], 'only the OEM channel may ever be deregistered by registerWatchChannels');
});

test('registerDealerWatchChannel: deregistration behavior is unchanged — still scoped by dealer_code, still happens before registration', async (t) => {
  zohoAuthService._resetForTests();
  const integrationAuthService = require('../services/integrations/integrationAuthService');
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret-value');

  const deleteCalls = [];
  const postCallOrder = [];
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/v2/token')) return { data: { access_token: 'tok', expires_in: 3600 } };
    if (url.includes('/crm/v8/actions/watch')) {
      postCallOrder.push('register');
      return { data: { watch: [{ status: 'success', code: 'SUCCESS' }] } };
    }
    throw new Error(`Unexpected axios.post URL: ${url}`);
  });
  t.mock.method(axios, 'delete', async (url, config) => {
    postCallOrder.push('deregister');
    deleteCalls.push(config.params.channel_ids);
    return { data: {} };
  });

  const catalystApp = buildFakeCatalystApp({
    existingRows: [
      { channel_id: 'oem-channel', module_name: 'Dealers,Leads' },
      { channel_id: 'old-dealer-channel', module_name: 'Leads', dealer_code: 'AU888' },
    ],
  });
  const integration = { ROWID: '501', dealer_code: 'AU888', base_url: 'https://dealer.zohoapis.in' };

  const result = await zohoWebhookService.registerDealerWatchChannel(catalystApp, integration);

  assert.deepEqual(postCallOrder, ['deregister', 'register']);
  assert.deepEqual(deleteCalls, ['old-dealer-channel'], 'must only ever target this dealer\'s own channel, never the OEM one');
  assert.equal(result.dealerCode, 'AU888');
  assert.equal(catalystApp._insertedRows[0].dealer_code, 'AU888');
  assert.equal(catalystApp._insertedRows[0].module_name, 'Leads');
});

test('registerWatchChannels: still succeeds normally when there is no prior OEM channel to deregister', async (t) => {
  zohoAuthService._resetForTests();
  mockWatchApiSuccess(t);
  let deleteCalled = false;
  t.mock.method(axios, 'delete', async () => {
    deleteCalled = true;
    return { data: {} };
  });

  const catalystApp = buildFakeCatalystApp({ existingRows: [] });

  const result = await zohoWebhookService.registerWatchChannels(catalystApp);

  assert.equal(deleteCalled, false, 'deregistration is a safe no-op when there is nothing to deregister — Zoho must never be called');
  assert.ok(result.channelId);
  assert.ok(result.expiresAt);
  assert.equal(catalystApp._insertedRows.length, 1);
  assert.equal(catalystApp._insertedRows[0].module_name, 'Dealers,Leads');
  assert.equal(catalystApp._insertedRows[0].dealer_code, undefined, 'the OEM row must still never carry a dealer_code, exactly as before this fix');
});

test('registerWatchChannels: existing error handling is intact — a failed deregistration does not block the new OEM registration', async (t) => {
  zohoAuthService._resetForTests();
  mockWatchApiSuccess(t);
  t.mock.method(axios, 'delete', async () => {
    const err = new Error('channel already expired');
    err.response = { data: { code: 'INVALID_DATA' } };
    throw err;
  });

  const catalystApp = buildFakeCatalystApp({
    existingRows: [{ channel_id: 'stale-channel', module_name: 'Dealers,Leads' }],
  });

  const result = await zohoWebhookService.registerWatchChannels(catalystApp);

  assert.ok(result.channelId, 'registration must still succeed even though deregistering the old channel failed — matches the pre-existing dealer-side "safe to no-op, logged not thrown" behavior');
  assert.equal(catalystApp._insertedRows.length, 1);
});
