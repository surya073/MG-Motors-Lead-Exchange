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

test('Fusion adapter declares create and update as its supported capabilities', () => {
  assert.deepEqual(fusionSdAdapter.capabilities, {
    createLead: true,
    updateLead: true,
    getLead: false,
    statusUpdate: false,
    webhook: false,
    duplicateSearch: false,
  });
});

test('getLead rejects with UNSUPPORTED_OPERATION rather than guessing a request shape', async () => {
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

// Live production evidence (AU004/QA, 2026-10-05): Fusion's real create-lead
// response body comes back empty, so none of the body-based guesses could
// ever match. Falls back to the standard HTTP Location header for a 201
// Created (RFC 7231 §7.1.2) — a documented REST convention, not a
// Fusion-specific guess.
test('createLead: falls back to the Location header when the response body has no usable ID (real Fusion QA behavior)', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-create', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({
    status: 201,
    data: '',
    headers: { location: '/v1/leads/fusion-abc-123' },
  }));

  const integration = fakeIntegration({ ROWID: '4002' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  assert.equal(result.externalLeadId, 'fusion-abc-123');
});

test('createLead: parses a JSON body sent as a raw string (wrong Content-Type) before falling back to the Location header', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-create', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({
    status: 201,
    data: '{"id":"FUSION-STRING-BODY-1"}',
    headers: { location: '/v1/leads/should-not-be-used' },
  }));

  const integration = fakeIntegration({ ROWID: '4003' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  assert.equal(result.externalLeadId, 'FUSION-STRING-BODY-1', 'a parseable JSON string body takes priority over the Location header');
});

test('createLead: a bare plain-text ID body with no Location header is used as a last-resort candidate', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-create', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({ status: 200, data: 'fusion-bare-id-789', headers: {} }));

  const integration = fakeIntegration({ ROWID: '4005' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  assert.equal(result.externalLeadId, 'fusion-bare-id-789');
});

test('createLead: an HTML error page accidentally returned with a 2xx status is never mistaken for a bare ID', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-create', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({
    status: 200,
    data: '<html><body>Not Found</body></html>',
    headers: {},
  }));

  const integration = fakeIntegration({ ROWID: '4006' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  assert.equal(result.externalLeadId, undefined, 'markup must never be treated as a bare record ID');
});

test('createLead: a Location header takes priority over a bare-string body candidate', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-create', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({
    status: 201,
    data: 'fusion-bare-id-should-lose',
    headers: { location: '/v1/leads/from-location-header' },
  }));

  const integration = fakeIntegration({ ROWID: '4007' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  assert.equal(result.externalLeadId, 'from-location-header');
});

test('createLead: truly empty body and no Location header still surfaces as no ID found (not a crash)', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-create', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({ status: 201, data: '', headers: {} }));

  const integration = fakeIntegration({ ROWID: '4004' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  assert.equal(result.externalLeadId, undefined);
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

test('nestDottedKeys expands dotted mapping targets into the nested Fusion body', () => {
  const { nestDottedKeys } = fusionSdAdapter._test;
  assert.deepEqual(
    nestDottedKeys({
      'contact.firstName': 'Jane',
      'contact.email': 'jane@example.com',
      'requirement.model': 'ZS',
      leadSource: 'Website',
    }),
    {
      contact: { firstName: 'Jane', email: 'jane@example.com' },
      requirement: { model: 'ZS' },
      leadSource: 'Website',
    }
  );
});

test('createLead sends nested body, Idempotency-Key, and parses the lead_id from a 201', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 600 } }));
  let sent;
  t.mock.method(axios, 'request', async (req) => {
    sent = req;
    return { status: 201, data: { lead_id: 'lead_01ABC', status: 'received' }, headers: {} };
  });
  const result = await fusionSdAdapter.createLead(
    {},
    // Public IP literal so the SSRF guard needs no DNS lookup (offline-safe).
    fakeIntegration({ base_url: 'https://8.8.8.8/api/leadapi' }),
    { 'contact.lastName': 'Testing', 'contact.email': 'a@example.com' },
    { idempotencyKey: 'zoho-123' }
  );

  assert.equal(result.externalLeadId, 'lead_01ABC');
  assert.equal(sent.headers['Idempotency-Key'], 'zoho-123');
  assert.equal(sent.headers.Authorization, 'Bearer tok');
  assert.deepEqual(sent.data, { contact: { lastName: 'Testing', email: 'a@example.com' } });
});

function mockFusionToken(t) {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 600 } }));
}

// Public IP literal so the SSRF guard needs no DNS lookup (offline-safe).
const updateIntegration = () => fakeIntegration({ base_url: 'https://8.8.8.8/api/leadapi' });

test('updateLead sends a nested merge-patch PATCH to /v1/leads/{lead_id}', async (t) => {
  mockFusionToken(t);
  let sent;
  t.mock.method(axios, 'request', async (req) => {
    sent = req;
    return { status: 200, data: { lead_id: 'lead_01ABC', enquiry_updated: true }, headers: {} };
  });

  const result = await fusionSdAdapter.updateLead(
    {},
    updateIntegration(),
    'lead_01ABC',
    { 'contact.phone': '0400000000', enquiryStatus: 'Contacted' }
  );

  assert.equal(sent.method, 'PATCH');
  assert.equal(sent.url, 'https://8.8.8.8/api/leadapi/v1/leads/lead_01ABC');
  assert.equal(sent.headers['Content-Type'], 'application/merge-patch+json');
  assert.equal(sent.headers.Authorization, 'Bearer tok');
  assert.deepEqual(sent.data, { contact: { phone: '0400000000' }, enquiryStatus: 'Contacted' });
  assert.equal(result.externalLeadId, 'lead_01ABC');
});

test('updateLead treats enquiry_updated:false (update held for a person) as success, not a failure', async (t) => {
  mockFusionToken(t);
  t.mock.method(axios, 'request', async () => ({
    status: 200,
    data: { lead_id: 'lead_01ABC', enquiry_updated: false },
    headers: {},
  }));
  const result = await fusionSdAdapter.updateLead({}, updateIntegration(), 'lead_01ABC', { enquiryStatus: 'Open' });
  assert.equal(result.externalLeadId, 'lead_01ABC');
  assert.equal(result.raw.enquiry_updated, false);
});

test('updateLead on a dealer with updates disabled (403 updates_not_enabled) is a no-op, not a retryable error', async (t) => {
  mockFusionToken(t);
  t.mock.method(axios, 'request', async () => {
    const err = new Error('forbidden');
    err.response = {
      status: 403,
      data: { type: 'https://docs.fusionamspro.com/lead-api/errors/updates_not_enabled', title: 'Updates not enabled' },
    };
    throw err;
  });
  const result = await fusionSdAdapter.updateLead({}, updateIntegration(), 'lead_01ABC', { enquiryStatus: 'Open' });
  assert.equal(result.skipped, true);
  assert.equal(result.externalLeadId, 'lead_01ABC');
});

test('updateLead keeps a 409 lead_not_ready retryable and a real 403 as an auth failure', async (t) => {
  mockFusionToken(t);
  let status = 409;
  t.mock.method(axios, 'request', async () => {
    const err = new Error('x');
    err.response = { status, data: { type: 'https://docs.fusionamspro.com/lead-api/errors/lead_not_ready' } };
    throw err;
  });
  await assert.rejects(
    () => fusionSdAdapter.updateLead({}, updateIntegration(), 'lead_01ABC', {}),
    (err) => err.code === 'EXTERNAL_CRM_ERROR'
  );
  status = 403;
  await assert.rejects(
    () => fusionSdAdapter.updateLead({}, updateIntegration(), 'lead_01ABC', {}),
    (err) => err.code === 'AUTHENTICATION_FAILED'
  );
});

test('updateLead without a dealer lead id is rejected before any request', async (t) => {
  mockFusionToken(t);
  await assert.rejects(
    () => fusionSdAdapter.updateLead({}, updateIntegration(), '', {}),
    (err) => err.code === 'INVALID_CRM_CONFIGURATION'
  );
});

test('crmAdapterFactory.supports: only an explicit false opts a CRM type out of a capability', () => {
  assert.equal(crmAdapterFactory.supports('FUSION_SD', 'getLead'), false);
  assert.equal(crmAdapterFactory.supports('FUSION_SD', 'updateLead'), true);
  assert.equal(crmAdapterFactory.supports('GENERIC_REST', 'getLead'), true);
  assert.equal(crmAdapterFactory.supports('ZOHO_CRM', 'getLead'), true);
  assert.equal(crmAdapterFactory.supports('NOT_A_CRM', 'getLead'), false);
});
