'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const fusionSdAdapter = require('../services/integrations/adapters/fusionSdAdapter');
const fusionSdOAuthHelper = require('../services/integrations/adapters/fusionSdOAuthHelper');
const genericRestAdapter = require('../services/integrations/adapters/genericRestAdapter');

// Minimal fake Catalyst app + credential lookups, swapped in instead of a
// real integrationAuthService call — these tests exercise the adapter's
// own logic (factory selection, error classification, single-flight
// de-dup, capability flags), not the credential-encryption layer, which
// is already covered by integrationAuthService's own usage elsewhere.
const integrationAuthService = require('../services/integrations/integrationAuthService');

function fakeIntegration(overrides = {}) {
  return {
    ROWID: '1001',
    dealer_code: 'AU999',
    crm_type: 'FUSION_SD',
    base_url: 'https://qa.fusionamspro.com/api/leadapi',
    create_lead_endpoint: '/v1/leads',
    http_method: 'POST',
    ...overrides,
  };
}

test('crmAdapterFactory resolves FUSION_SD to the dedicated Fusion adapter', () => {
  const adapter = crmAdapterFactory.getAdapter('FUSION_SD');
  assert.equal(adapter, fusionSdAdapter);
});

test('FUSION_SD does not affect GENERIC_REST/ZOHO_CRM resolution (regression check)', () => {
  assert.equal(crmAdapterFactory.getAdapter('GENERIC_REST'), genericRestAdapter);
  assert.equal(crmAdapterFactory.getAdapter('ZOHO_CRM'), genericRestAdapter);
});

test('Fusion adapter declares only createLead as a confirmed capability', () => {
  assert.deepEqual(fusionSdAdapter.capabilities, {
    createLead: true,
    updateLead: false,
    getLead: false,
    statusUpdate: false,
    webhook: false,
    duplicateSearch: false,
  });
});

test('updateLead and getLead reject with UNSUPPORTED_OPERATION rather than guessing a request shape', async () => {
  await assert.rejects(() => fusionSdAdapter.updateLead(), (err) => err.code === 'UNSUPPORTED_OPERATION');
  await assert.rejects(() => fusionSdAdapter.getLead(), (err) => err.code === 'UNSUPPORTED_OPERATION');
});

test('classifyFusionError maps HTTP status to the existing shared error-code vocabulary', () => {
  const { classifyFusionError } = fusionSdAdapter._test;
  assert.equal(classifyFusionError({ response: { status: 401 } }), 'AUTHENTICATION_FAILED');
  assert.equal(classifyFusionError({ response: { status: 403 } }), 'AUTHENTICATION_FAILED');
  assert.equal(classifyFusionError({ response: { status: 400 } }), 'FIELD_MAPPING_INVALID');
  assert.equal(classifyFusionError({ response: { status: 422 } }), 'FIELD_MAPPING_INVALID');
  assert.equal(classifyFusionError({ response: { status: 404 } }), 'NOT_FOUND');
  assert.equal(classifyFusionError({ response: { status: 500 } }), 'EXTERNAL_CRM_ERROR');
  assert.equal(classifyFusionError({ response: undefined }), 'EXTERNAL_CRM_ERROR'); // network/timeout
});

test('getAccessTokenForFusionSd: concurrent calls for the same integration single-flight into one token request', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  let postCallCount = 0;
  t.mock.method(axios, 'post', async () => {
    postCallCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 20)); // simulate network latency
    return { data: { access_token: 'tok-concurrent', expires_in: 3600 } };
  });
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );

  const integration = fakeIntegration();
  const [a, b, c] = await Promise.all([
    fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration),
    fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration),
    fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration),
  ]);

  assert.equal(postCallCount, 1, 'three concurrent callers should trigger exactly one token request');
  assert.equal(a, 'tok-concurrent');
  assert.equal(b, 'tok-concurrent');
  assert.equal(c, 'tok-concurrent');
});

test('getAccessTokenForFusionSd: sends Basic Auth (access key as username) + form-urlencoded grant_type, per Fusion QA confirmation', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  let capturedBody;
  let capturedConfig;
  t.mock.method(axios, 'post', async (url, body, config) => {
    capturedBody = body;
    capturedConfig = config;
    return { data: { access_token: 'tok-shape-check', expires_in: 600 } };
  });
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'the-access-key' : 'the-secret-key'
  );

  await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, fakeIntegration({ ROWID: '5001' }));

  assert.equal(capturedBody, 'grant_type=client_credentials');
  assert.equal(capturedConfig.auth.username, 'the-access-key');
  assert.equal(capturedConfig.auth.password, 'the-secret-key');
  assert.equal(capturedConfig.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('getAccessTokenForFusionSd: token cache is isolated per integration ROWID', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  const tokensIssued = { '2001': 'tok-dealer-a', '2002': 'tok-dealer-b' };
  t.mock.method(axios, 'post', async (url, body, config) => ({
    data: { access_token: tokensIssued[config.auth.username], expires_in: 3600 },
  }));
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, integrationId, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? String(integrationId) : 'secret'
  );

  const dealerA = fakeIntegration({ ROWID: '2001', dealer_code: 'AU991' });
  const dealerB = fakeIntegration({ ROWID: '2002', dealer_code: 'AU992' });

  const tokenA = await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, dealerA);
  const tokenB = await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, dealerB);

  assert.equal(tokenA, 'tok-dealer-a');
  assert.equal(tokenB, 'tok-dealer-b');
  assert.notEqual(tokenA, tokenB, "dealer A's and dealer B's tokens must never cross");
});

test('getAccessTokenForFusionSd: missing credentials fail as AUTHENTICATION_FAILED, not a crash', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => null);

  await assert.rejects(
    () => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, fakeIntegration({ ROWID: '3001' })),
    (err) => err.code === 'AUTHENTICATION_FAILED'
  );
});

test('createLead: extracts the external record ID from the response', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-create', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({
    status: 201,
    data: { id: 'FUSION-LEAD-123' },
  }));

  const integration = fakeIntegration({ ROWID: '4001' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  assert.equal(result.externalLeadId, 'FUSION-LEAD-123');
  assert.equal(result.httpStatus, 201);
});

test('createLead: a 401 from Fusion is classified AUTHENTICATION_FAILED and the thrown error carries no credential data', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'super-secret-key'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-401', expires_in: 3600 } }));
  const authError = Object.assign(new Error('Unauthorized'), { response: { status: 401, data: { message: 'bad token' } } });
  t.mock.method(axios, 'request', async () => {
    throw authError;
  });

  await assert.rejects(
    () => fusionSdAdapter.createLead({}, fakeIntegration({ ROWID: '4002' }), {}),
    (err) => {
      assert.equal(err.code, 'AUTHENTICATION_FAILED');
      assert.ok(!String(err.message).includes('super-secret-key'), 'thrown error must never include the secret key');
      assert.ok(!JSON.stringify(err).includes('super-secret-key'), 'serialized error must never include the secret key');
      return true;
    }
  );
});
