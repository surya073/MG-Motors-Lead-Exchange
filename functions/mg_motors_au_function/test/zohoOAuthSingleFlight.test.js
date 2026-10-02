'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

// Covers the single-flight refresh fixes added for the 200+ dealer
// concurrency audit: zohoAuthService.js (OEM-side, one shared token) and
// zohoCrmOAuthHelper.js (dealer-side, one token per integration ROWID).
// Both previously did plain check-then-act with no de-duplication, so N
// concurrent callers seeing a stale/missing token would each fire an
// independent refresh request.
//
// zohoAuthService.js reads config via a destructured `getZohoConfig` at
// require-time, so it can't be property-mocked after the fact (unlike
// the module-reference style integrationAuthService.getDecryptedCredential
// calls elsewhere) — env vars are set directly instead, matching how
// config/env.js actually sources its values.
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

test('zohoAuthService.getAccessToken: concurrent calls single-flight into one OAuth request', async (t) => {
  const zohoAuthService = require('../services/zohoAuthService');
  zohoAuthService._resetForTests();

  let postCallCount = 0;
  t.mock.method(axios, 'post', async () => {
    postCallCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { data: { access_token: 'oem-tok', expires_in: 3600 } };
  });

  const [a, b, c] = await Promise.all([
    zohoAuthService.getAccessToken(),
    zohoAuthService.getAccessToken(),
    zohoAuthService.getAccessToken(),
  ]);

  assert.equal(postCallCount, 1, 'three concurrent callers should trigger exactly one token request');
  assert.equal(a, 'oem-tok');
  assert.equal(b, 'oem-tok');
  assert.equal(c, 'oem-tok');

  zohoAuthService._resetForTests();
});

test('zohoAuthService.getAccessToken: a failed refresh does not poison the cache for the next call', async (t) => {
  const zohoAuthService = require('../services/zohoAuthService');
  zohoAuthService._resetForTests();

  let call = 0;
  t.mock.method(axios, 'post', async () => {
    call += 1;
    if (call === 1) throw new Error('network blip');
    return { data: { access_token: 'oem-tok-2', expires_in: 3600 } };
  });

  await assert.rejects(() => zohoAuthService.getAccessToken());
  const token = await zohoAuthService.getAccessToken();
  assert.equal(token, 'oem-tok-2');

  zohoAuthService._resetForTests();
});

test('zohoCrmOAuthHelper.getAccessTokenForDealerZoho: concurrent calls for the same integration single-flight', async (t) => {
  const zohoCrmOAuthHelper = require('../services/integrations/adapters/zohoCrmOAuthHelper');
  const integrationAuthService = require('../services/integrations/integrationAuthService');
  zohoCrmOAuthHelper._resetForTests();

  let postCallCount = 0;
  t.mock.method(axios, 'post', async () => {
    postCallCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { data: { access_token: 'dealer-tok', expires_in: 3600 } };
  });
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'value');

  const integration = { ROWID: '9001', oauth_accounts_domain: 'https://accounts.zoho.in' };
  const [a, b, c] = await Promise.all([
    zohoCrmOAuthHelper.getAccessTokenForDealerZoho({}, integration),
    zohoCrmOAuthHelper.getAccessTokenForDealerZoho({}, integration),
    zohoCrmOAuthHelper.getAccessTokenForDealerZoho({}, integration),
  ]);

  assert.equal(postCallCount, 1, 'three concurrent callers for the same dealer should trigger exactly one refresh');
  assert.equal(a, 'dealer-tok');
  assert.equal(b, 'dealer-tok');
  assert.equal(c, 'dealer-tok');

  zohoCrmOAuthHelper._resetForTests();
});

test('zohoCrmOAuthHelper.getAccessTokenForDealerZoho: token cache/in-flight refresh is isolated per integration ROWID', async (t) => {
  const zohoCrmOAuthHelper = require('../services/integrations/adapters/zohoCrmOAuthHelper');
  const integrationAuthService = require('../services/integrations/integrationAuthService');
  zohoCrmOAuthHelper._resetForTests();

  const tokensIssued = { '7001': 'tok-dealer-a', '7002': 'tok-dealer-b' };
  t.mock.method(axios, 'post', async (url, body, config) => ({
    data: { access_token: tokensIssued[config.params.client_id], expires_in: 3600 },
  }));
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, integrationId, credType) =>
    credType === 'OAUTH2_CLIENT_ID' ? String(integrationId) : 'secret-or-refresh'
  );

  const dealerA = { ROWID: '7001', oauth_accounts_domain: 'https://accounts.zoho.in' };
  const dealerB = { ROWID: '7002', oauth_accounts_domain: 'https://accounts.zoho.in' };

  const tokenA = await zohoCrmOAuthHelper.getAccessTokenForDealerZoho({}, dealerA);
  const tokenB = await zohoCrmOAuthHelper.getAccessTokenForDealerZoho({}, dealerB);

  assert.equal(tokenA, 'tok-dealer-a');
  assert.equal(tokenB, 'tok-dealer-b');
  assert.notEqual(tokenA, tokenB, "dealer A's and dealer B's tokens must never cross");

  zohoCrmOAuthHelper._resetForTests();
});

test('zohoCrmOAuthHelper.getAccessTokenForDealerZoho: missing credentials fail as AUTHENTICATION_FAILED, not a crash', async (t) => {
  const zohoCrmOAuthHelper = require('../services/integrations/adapters/zohoCrmOAuthHelper');
  const integrationAuthService = require('../services/integrations/integrationAuthService');
  zohoCrmOAuthHelper._resetForTests();

  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => null);

  await assert.rejects(
    () => zohoCrmOAuthHelper.getAccessTokenForDealerZoho({}, { ROWID: '7003' }),
    (err) => err.code === 'AUTHENTICATION_FAILED'
  );

  zohoCrmOAuthHelper._resetForTests();
});
