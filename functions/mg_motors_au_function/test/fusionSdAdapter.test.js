'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const fusionSdAdapter = require('../services/integrations/adapters/fusionSdAdapter');
const fusionSdOAuthHelper = require('../services/integrations/adapters/fusionSdOAuthHelper');
const genericRestAdapter = require('../services/integrations/adapters/genericRestAdapter');
const fixtures = require('./helpers/fusionFixtures');

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
    base_url: 'https://8.8.8.8/api/leadapi', // HTTP is mocked; DNS must not depend on QA
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
  assert.equal(capturedConfig.maxRedirects, 0);
  assert.equal(capturedConfig.proxy, false);
  assert.equal(capturedConfig.adapter, 'http');
  assert.equal(typeof capturedConfig.lookup, 'function');
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
    data: { lead_id: 'FUSION-LEAD-123' },
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
    data: '{"lead_id":"FUSION-STRING-BODY-1"}',
    headers: { location: '/v1/leads/should-not-be-used' },
  }));

  const integration = fakeIntegration({ ROWID: '4003' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  assert.equal(result.externalLeadId, 'FUSION-STRING-BODY-1', 'a parseable JSON string body takes priority over the Location header');
});

test('createLead: a bare plain-text body with no Location header is not used as the lead id', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok-create', expires_in: 3600 } }));
  t.mock.method(axios, 'request', async () => ({ status: 200, data: 'fusion-bare-id-789', headers: {} }));

  const integration = fakeIntegration({ ROWID: '4005' });
  const result = await fusionSdAdapter.createLead({}, integration, { customer_name: 'Test Lead' });

  // M6: Fusion returns JSON lead_id; a text body is never trusted as an id.
  assert.equal(result.externalLeadId, undefined);
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

test('nestDottedKeys never writes through __proto__, prototype or constructor', () => {
  const { nestDottedKeys } = fusionSdAdapter._test;
  try {
    const body = nestDottedKeys({
      '__proto__.polluted': 'yes',
      'contact.__proto__.polluted': 'yes',
      'constructor.prototype.polluted': 'yes',
      prototype: 'yes',
      'contact.email': 'a@example.com',
    });

    assert.equal({}.polluted, undefined, 'Object.prototype must stay untouched');
    assert.deepEqual(body, { contact: { email: 'a@example.com' } });
  } finally {
    delete Object.prototype.polluted;
  }
});

test('nestDottedKeys keeps the first of two colliding targets instead of overwriting it', () => {
  const { nestDottedKeys } = fusionSdAdapter._test;
  assert.deepEqual(
    nestDottedKeys({ contact: 'value first', 'contact.firstName': 'Jane' }),
    { contact: 'value first' }
  );
  assert.deepEqual(
    nestDottedKeys({ 'contact.firstName': 'Jane', contact: 'value second' }),
    { contact: { firstName: 'Jane' } }
  );
});

test('getAccessTokenForFusionSd refuses an unsafe token URL before reading the keys or sending anything', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  const credentials = t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  const post = t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 600 } }));

  for (const baseUrl of ['http://8.8.8.8/api/leadapi', 'https://127.0.0.1/api/leadapi', 'https://10.1.2.3/api/leadapi', 'not a url']) {
    await assert.rejects(
      () => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, fakeIntegration({ ROWID: '6001', base_url: baseUrl })),
      (err) => err.code === 'INVALID_CRM_CONFIGURATION',
      baseUrl
    );
  }
  assert.equal(credentials.mock.callCount(), 0, 'the keys are never read');
  assert.equal(post.mock.callCount(), 0, 'nothing is sent');

  const token = await fusionSdOAuthHelper.getAccessTokenForFusionSd(
    {},
    fakeIntegration({ ROWID: '6001', base_url: 'https://8.8.8.8/api/leadapi' })
  );
  assert.equal(token, 'tok');
  assert.equal(post.mock.calls[0].arguments[0], 'https://8.8.8.8/api/leadapi/oauth2/token');
});

test('testConnection reports an unsafe Fusion URL as a configuration error, like the generic adapter', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  const post = t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 600 } }));

  await assert.rejects(
    () => fusionSdAdapter.testConnection({}, fakeIntegration({ ROWID: '6002', base_url: 'http://8.8.8.8/api/leadapi' })),
    (err) => err.code === 'INVALID_CRM_CONFIGURATION'
  );
  assert.equal(post.mock.callCount(), 0, 'the keys are never sent over plain HTTP');
});

test("extractExternalLeadId takes Fusion's lead_id only, and only when it looks like an id", () => {
  const { extractExternalLeadId } = fusionSdAdapter._test;
  const idFrom = (data) => extractExternalLeadId({ status: 201, data, headers: {} });

  // The shape of every Fusion lead id in the live datastore (13 Oct 2026).
  assert.equal(idFrom({ lead_id: 'lead_01M4FPDJ89FCJ7WFZ17JYN5CP1', status: 'received' }), 'lead_01M4FPDJ89FCJ7WFZ17JYN5CP1');
  assert.equal(
    idFrom('{"lead_id":"lead_01M4FPDJ89FCJ7WFZ17JYN5CP1"}'),
    'lead_01M4FPDJ89FCJ7WFZ17JYN5CP1',
    'JSON sent with the wrong Content-Type'
  );

  for (const data of [
    'OK',
    'lead_01M4FPDJ89FCJ7WFZ17JYN5CP1', // plain text, even when it looks like an id
    { id: 'abc' },
    { data: { id: 'abc' } },
    { record: { id: 'abc' } },
    { record: { uuid: 'abc' } },
    { lead_id: 'not an id' },
    { lead_id: '../leads/x' },
    { lead_id: '' },
    { lead_id: 42 },
    { lead_id: { id: 'x' } },
    { lead_id: 'x'.repeat(129) },
  ]) {
    assert.equal(idFrom(data), undefined, JSON.stringify(data).slice(0, 60));
  }
});

test('extractExternalLeadId reads a Location header only when its path is /v1/leads/{id}', () => {
  const { extractExternalLeadId } = fusionSdAdapter._test;
  const idFrom = (location) => extractExternalLeadId({ status: 201, data: '', headers: { location } });

  assert.equal(idFrom('/v1/leads/lead_01ABC'), 'lead_01ABC');
  assert.equal(idFrom('https://qa.fusionamspro.com/api/leadapi/v1/leads/lead_01ABC'), 'lead_01ABC');
  assert.equal(idFrom('/api/leadapi/v1/leads/lead_01ABC?expand=contact#top'), 'lead_01ABC', 'query and fragment are ignored');
  assert.equal(idFrom('/v1/leads/lead%5F01ABC'), 'lead_01ABC', 'percent-decoded');

  for (const location of ['/v1/contacts/abc', '/leads/abc', '/v1/leads/', '/v1/leads/abc/notes', '/v1/leads/not%20an%20id', '/v1/leads/%E0%A4%A']) {
    assert.equal(idFrom(location), undefined, location);
  }
});

test('createLead: a 2xx plain-text body such as "OK" is not taken as the lead id', async (t) => {
  mockFusionToken(t);
  t.mock.method(axios, 'request', async () => ({ status: 201, data: 'OK', headers: {} }));

  const result = await fusionSdAdapter.createLead({}, updateIntegration(), { 'contact.lastName': 'Testing' });

  assert.equal(result.externalLeadId, undefined);
});

// M7: token lifetime, invalidation and refresh on 401. Public IP literal
// base URLs keep these offline-safe.
function countTokens(t, { expiresIn = 600 } = {}) {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  const issued = { count: 0 };
  t.mock.method(axios, 'post', async () => {
    issued.count += 1;
    return { data: { access_token: `tok-${issued.count}`, ...(expiresIn ? { expires_in: expiresIn } : {}) } };
  });
  return issued;
}

test('a token without expires_in is treated as 600 s and refreshed 5 minutes before that', async (t) => {
  countTokens(t, { expiresIn: null });
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const integration = updateIntegration();

  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration), 'tok-1');
  now += 299 * 1000;
  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration), 'tok-1');
  now += 2 * 1000;
  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration), 'tok-2');
});

test('a short-lived token is still reused, for half its lifetime', async (t) => {
  countTokens(t, { expiresIn: 60 });
  let now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const integration = updateIntegration();

  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration), 'tok-1');
  now += 29 * 1000;
  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration), 'tok-1');
  now += 2 * 1000;
  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration), 'tok-2');
});

test('invalidateToken makes the next caller fetch a new token; one fetched before it is not cached', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  let issued = 0;
  let release;
  t.mock.method(axios, 'post', async () => {
    issued += 1;
    const token = `tok-${issued}`;
    if (issued === 2) await new Promise((resolve) => { release = resolve; });
    return { data: { access_token: token, expires_in: 600 } };
  });
  const integration = updateIntegration();
  const get = () => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration);

  assert.equal(await get(), 'tok-1');
  fusionSdOAuthHelper.invalidateToken(integration.ROWID);
  const inFlight = get();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  // The keys are saved again while that request is still in flight.
  fusionSdOAuthHelper.invalidateToken(integration.ROWID);
  release();

  assert.equal(await inFlight, 'tok-2', 'the caller that asked still gets its token');
  assert.equal(await get(), 'tok-3', 'but it is not cached past the invalidation');
});

test('a 401 drops the cached token, refreshes it once and retries the request once', async (t) => {
  const issued = countTokens(t);
  const sentWith = [];
  t.mock.method(axios, 'request', async (req) => {
    sentWith.push(req.headers.Authorization);
    if (sentWith.length === 1) throw fixtures.fusionProblemError('credential_revoked');
    return fixtures.leadAcceptedResponse();
  });

  const result = await fusionSdAdapter.createLead({}, updateIntegration(), { 'contact.lastName': 'Testing' }, { idempotencyKey: 'z1' });

  assert.equal(result.externalLeadId, fixtures.FUSION_TEST_LEAD_ID);
  assert.deepEqual(sentWith, ['Bearer tok-1', 'Bearer tok-2']);
  assert.equal(issued.count, 2, 'exactly one refresh');
});

test('a 401 that persists after the refresh fails as AUTHENTICATION_FAILED, with no further retries', async (t) => {
  const issued = countTokens(t);
  const request = t.mock.method(axios, 'request', async () => {
    throw fixtures.fusionProblemError('credential_revoked');
  });

  await assert.rejects(
    () => fusionSdAdapter.updateLead({}, updateIntegration(), fixtures.FUSION_TEST_LEAD_ID, { enquiryStatus: 'Open' }),
    (err) => err.code === 'AUTHENTICATION_FAILED'
  );
  assert.equal(request.mock.callCount(), 2);
  assert.equal(issued.count, 2);
});

test('only a 401 triggers the refresh; other errors fail on the first attempt', async (t) => {
  const issued = countTokens(t);
  const request = t.mock.method(axios, 'request', async () => {
    throw fixtures.rateLimitedError();
  });

  await assert.rejects(
    () => fusionSdAdapter.createLead({}, updateIntegration(), {}),
    (err) => err.code === 'EXTERNAL_CRM_ERROR'
  );
  assert.equal(request.mock.callCount(), 1);
  assert.equal(issued.count, 1);
});

test('testConnection always asks Fusion for a new token', async (t) => {
  const issued = countTokens(t);
  const integration = updateIntegration();

  assert.equal((await fusionSdAdapter.testConnection({}, integration)).ok, true);
  assert.equal((await fusionSdAdapter.testConnection({}, integration)).ok, true);
  assert.equal(issued.count, 2);
});

test('a token error keeps its HTTP status for Test Connection; a network error has none', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'super-secret-key');
  let failure = Object.assign(new Error('Request failed with status code 401'), {
    response: { status: 401, data: { error: 'invalid_client' } },
  });
  t.mock.method(axios, 'post', async () => {
    throw failure;
  });
  const integration = updateIntegration();

  await assert.rejects(
    () => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration),
    (err) => {
      assert.equal(err.code, 'AUTHENTICATION_FAILED');
      assert.deepEqual(err.response, { status: 401 });
      assert.ok(!JSON.stringify(err).includes('super-secret-key'));
      return true;
    }
  );
  assert.equal((await fusionSdAdapter.testConnection({}, integration)).httpStatus, 401);

  failure = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
  const offline = await fusionSdAdapter.testConnection({}, integration);
  assert.equal(offline.ok, false);
  assert.equal(offline.httpStatus, 0, 'no response, so no status');
});

test('concurrent requests that all hit a 401 share one token refresh', async (t) => {
  const issued = countTokens(t);
  t.mock.method(axios, 'request', async (req) => {
    if (req.headers.Authorization === 'Bearer tok-1') throw fixtures.fusionProblemError('credential_revoked');
    return fixtures.leadAcceptedResponse();
  });
  const integration = updateIntegration();

  const results = await Promise.all(
    Array.from({ length: 5 }, () => fusionSdAdapter.createLead({}, integration, { 'contact.lastName': 'Testing' }))
  );

  assert.ok(results.every((result) => result.externalLeadId === fixtures.FUSION_TEST_LEAD_ID));
  assert.equal(issued.count, 2, 'the first token, then one shared refresh');
});

// M5: a safe copy of Fusion's error travels on err.vendor for the failure log.
test('a Fusion error keeps safe vendor diagnostics: status, problem fields and Retry-After', async (t) => {
  mockFusionToken(t);
  t.mock.method(axios, 'request', async () => {
    throw fixtures.rateLimitedError({ retryAfter: 60 });
  });

  await assert.rejects(
    () => fusionSdAdapter.createLead({}, updateIntegration(), {}),
    (err) => {
      assert.equal(err.code, 'EXTERNAL_CRM_ERROR');
      assert.deepEqual(err.vendor, {
        status: 429,
        type: 'https://docs.fusionamspro.com/lead-api/errors/rate_limited',
        title: 'Too many requests',
        detail: 'Retry after the period given in the Retry-After header.',
        instance: 'lreq_test00000001',
        retryAfter: 60,
      });
      return true;
    }
  );
});

test('vendor diagnostics keep a 422 type and instance, truncate long text, and carry nothing else', async (t) => {
  mockFusionToken(t);
  t.mock.method(axios, 'request', async () => {
    throw fixtures.fusionProblemError('missing_contact', { detail: 'x'.repeat(1000), instance: 'lreq_abc' });
  });

  await assert.rejects(
    () => fusionSdAdapter.createLead({}, updateIntegration(), { 'contact.email': 'jane@example.com' }),
    (err) => {
      assert.equal(err.code, 'FIELD_MAPPING_INVALID');
      assert.equal(err.vendor.type, 'https://docs.fusionamspro.com/lead-api/errors/missing_contact');
      assert.equal(err.vendor.instance, 'lreq_abc');
      assert.equal(err.vendor.detail.length, 300);
      assert.deepEqual(Object.keys(err.vendor).sort(), ['detail', 'instance', 'status', 'title', 'type']);
      assert.ok(!JSON.stringify(err.vendor).includes('jane@example.com'), 'no lead data');
      return true;
    }
  );
});

test('Retry-After given as an HTTP date becomes seconds; a network error has no vendor diagnostics', async (t) => {
  mockFusionToken(t);
  let failure = fixtures.rateLimitedError({ retryAfter: new Date(Date.now() + 90 * 1000).toUTCString() });
  t.mock.method(axios, 'request', async () => {
    throw failure;
  });

  await assert.rejects(
    () => fusionSdAdapter.createLead({}, updateIntegration(), {}),
    (err) => err.vendor.retryAfter >= 88 && err.vendor.retryAfter <= 90
  );

  failure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  await assert.rejects(
    () => fusionSdAdapter.createLead({}, updateIntegration(), {}),
    (err) => err.code === 'EXTERNAL_CRM_ERROR' && err.vendor === undefined
  );
});

test('a skipped update (403 updates_not_enabled) carries the vendor diagnostics for the log', async (t) => {
  mockFusionToken(t);
  t.mock.method(axios, 'request', async () => {
    throw fixtures.updatesNotEnabledError();
  });

  const result = await fusionSdAdapter.updateLead({}, updateIntegration(), fixtures.FUSION_TEST_LEAD_ID, { enquiryStatus: 'Open' });

  assert.equal(result.skipped, true);
  assert.equal(result.vendor.status, 403);
  assert.equal(result.vendor.type, 'https://docs.fusionamspro.com/lead-api/errors/updates_not_enabled');
  assert.equal(result.vendor.instance, 'lreq_test00000001');
});

// H4: what Fusion did with a PATCH (LeadUpdated) is summarised for the log.
test('updateLead summarises what Fusion did with the update: mode, linked enquiry, updated and ignored fields', async (t) => {
  mockFusionToken(t);
  t.mock.method(axios, 'request', async () => fixtures.leadUpdatedResponse({ update_mode: 'manual', ignored_fields: ['privacy'] }));

  const result = await fusionSdAdapter.updateLead({}, updateIntegration(), fixtures.FUSION_TEST_LEAD_ID, { enquiryStatus: 'Open' });

  assert.deepEqual(result.dealerResponse, {
    update_mode: 'manual',
    enquiry_linked: true,
    updated_fields: ['status'],
    ignored_fields: ['privacy'],
  });
});

test('the update summary is trimmed, and absent when Fusion reports none of those fields', async (t) => {
  mockFusionToken(t);
  let body = fixtures.leadUpdatedResponse({ updated_fields: Array.from({ length: 40 }, (_, i) => `field_${i}_${'x'.repeat(80)}`) });
  t.mock.method(axios, 'request', async () => body);

  const trimmed = (await fusionSdAdapter.updateLead({}, updateIntegration(), fixtures.FUSION_TEST_LEAD_ID, {})).dealerResponse;
  assert.equal(trimmed.updated_fields.length, 25);
  assert.ok(trimmed.updated_fields.every((name) => name.length <= 60));

  body = { status: 200, data: { lead_id: fixtures.FUSION_TEST_LEAD_ID, enquiry_updated: true }, headers: {} };
  assert.equal((await fusionSdAdapter.updateLead({}, updateIntegration(), fixtures.FUSION_TEST_LEAD_ID, {})).dealerResponse, undefined);
});

// Buckby MG (725001), 12-13 Oct 2026: Fusion's token endpoint twice took
// over 10 s to answer and the deliveries were logged AUTHENTICATION_FAILED,
// which reads as wrong keys. A timeout or a connection that cannot be made
// is a connection problem, labelled like one on create and update.
test('a token request that times out or cannot connect is a connection error, not AUTHENTICATION_FAILED', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'super-secret-key');
  let failure = Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
  t.mock.method(axios, 'post', async () => {
    throw failure;
  });

  for (const networkError of [failure, Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })]) {
    failure = networkError;
    await assert.rejects(
      () => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, updateIntegration()),
      (err) => {
        assert.equal(err.code, 'EXTERNAL_CRM_ERROR', networkError.code);
        assert.equal(err.response, undefined, 'no HTTP status, so it is retried as temporary');
        assert.match(err.message, /did not respond/);
        assert.ok(!JSON.stringify(err).includes('super-secret-key'));
        return true;
      }
    );
  }
});

test('token HTTP 429 and 5xx preserve transient classification and Retry-After without secrets', async (t) => {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'synthetic-secret');
  let failure;
  t.mock.method(axios, 'post', async () => { throw failure; });
  for (const status of [429, 500, 503]) {
    failure = Object.assign(new Error('synthetic error'), {
      response: { status, headers: { 'retry-after': '60' }, data: { error_description: 'synthetic-secret' } },
      config: { auth: { password: 'synthetic-secret' } },
    });
    await assert.rejects(() => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, updateIntegration()), (err) => {
      assert.equal(err.code, 'EXTERNAL_CRM_ERROR');
      assert.deepEqual(err.response, { status });
      assert.deepEqual(err.vendor, { status, retryAfter: 60 });
      assert.ok(!JSON.stringify(err).includes('synthetic-secret'));
      return true;
    });
  }
});
