'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const dealerStudioAdapter = require('../services/integrations/adapters/dealerStudioAdapter');
const genericRestAdapter = require('../services/integrations/adapters/genericRestAdapter');
const integrationAuthService = require('../services/integrations/integrationAuthService');

const API_KEY = 'ds-test-key-123';

function integration(overrides = {}) {
  return {
    ROWID: '2001',
    dealer_code: 'AU777',
    crm_type: 'DEALER_STUDIO',
    base_url: 'https://8.8.8.8', // HTTP is mocked; DNS must not matter
    create_lead_endpoint: '/api/v1/leads',
    http_method: 'POST',
    update_http_method: 'PUT',
    ...overrides,
  };
}

function withKey(t, key = API_KEY) {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, type) => {
    assert.equal(type, 'BEARER_TOKEN');
    return key;
  });
}

function mockRequest(t, impl) {
  const calls = [];
  t.mock.method(axios, 'request', async (config) => {
    calls.push(config);
    return impl(config);
  });
  return calls;
}

function httpError(status, data) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data, headers: {} };
  return err;
}

test('factory resolves DEALER_STUDIO to its own adapter and leaves the others alone', () => {
  assert.equal(crmAdapterFactory.getAdapter('DEALER_STUDIO'), dealerStudioAdapter);
  assert.equal(crmAdapterFactory.getAdapter('GENERIC_REST'), genericRestAdapter);
  assert.equal(crmAdapterFactory.supports('DEALER_STUDIO', 'createLead'), true);
  assert.equal(crmAdapterFactory.supports('DEALER_STUDIO', 'getLead'), false);
});

test('capabilities: create, update and the cluster webhook; no read', () => {
  assert.deepEqual(dealerStudioAdapter.capabilities, {
    createLead: true, updateLead: true, getLead: false, statusUpdate: false, webhook: true, duplicateSearch: false,
  });
});

test('getLead rejects with UNSUPPORTED_OPERATION', async () => {
  await assert.rejects(() => dealerStudioAdapter.getLead(), (err) => err.code === 'UNSUPPORTED_OPERATION');
});

test('createLead POSTs the mapped body to /api/v1/leads with the Bearer API key and returns the id', async (t) => {
  withKey(t);
  const calls = mockRequest(t, () => ({ status: 201, data: { id: 'ld_42' }, headers: {} }));
  const payload = { first_name: 'Test', source: 'Manufacturer' };

  const result = await dealerStudioAdapter.createLead({}, integration(), payload, { idempotencyKey: 'zoho-1' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://8.8.8.8/api/v1/leads');
  assert.equal(calls[0].headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(calls[0].headers['Idempotency-Key'], 'zoho-1');
  assert.deepEqual(JSON.parse(calls[0].data), { lead: payload });
  assert.deepEqual(result, { externalLeadId: 'ld_42', httpStatus: 201, raw: { id: 'ld_42' } });
});

test('updateLead PUTs to /api/v1/leads/{id}, derived from the create path', async (t) => {
  withKey(t);
  const calls = mockRequest(t, () => ({ status: 200, data: {}, headers: {} }));

  const result = await dealerStudioAdapter.updateLead({}, integration(), 'ld 42', { status: 'x' });

  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].url, 'https://8.8.8.8/api/v1/leads/ld%2042');
  assert.equal(result.externalLeadId, 'ld 42');
  assert.equal(result.httpStatus, 200);
  assert.deepEqual(JSON.parse(calls[0].data), { lead: { status: 'x' } });
});

test('updateLead without an id is an INVALID_CRM_CONFIGURATION error and sends nothing', async (t) => {
  withKey(t);
  const calls = mockRequest(t, () => ({ status: 200, data: {}, headers: {} }));
  await assert.rejects(() => dealerStudioAdapter.updateLead({}, integration(), '', {}), (err) => err.code === 'INVALID_CRM_CONFIGURATION');
  assert.equal(calls.length, 0);
});

test('a 422 (value not matching Dealer Studio exactly) is FIELD_MAPPING_INVALID, without leaking body or key', async (t) => {
  withKey(t);
  mockRequest(t, () => { throw httpError(422, { message: 'category is invalid', email: 'jane@example.com' }); });

  await assert.rejects(
    () => dealerStudioAdapter.createLead({}, integration(), { email: 'jane@example.com' }),
    (err) => {
      assert.equal(err.code, 'FIELD_MAPPING_INVALID');
      assert.match(err.message, /HTTP 422: category is invalid/);
      assert.ok(!err.message.includes('jane@example.com'));
      assert.ok(!err.message.includes(API_KEY));
      return true;
    }
  );
});

test('error statuses map onto the shared error-code vocabulary', () => {
  const { classifyDealerStudioError: classify } = dealerStudioAdapter._test;
  assert.equal(classify({ response: { status: 401 } }), 'AUTHENTICATION_FAILED');
  assert.equal(classify({ response: { status: 403 } }), 'AUTHENTICATION_FAILED');
  assert.equal(classify({ response: { status: 400 } }), 'FIELD_MAPPING_INVALID');
  assert.equal(classify({ response: { status: 422 } }), 'FIELD_MAPPING_INVALID');
  assert.equal(classify({ response: { status: 404 } }), 'NOT_FOUND');
  assert.equal(classify({ response: { status: 503 } }), 'EXTERNAL_CRM_ERROR');
  assert.equal(classify({}), 'EXTERNAL_CRM_ERROR');
});

test('a missing API key fails with AUTHENTICATION_FAILED before any request', async (t) => {
  withKey(t, null);
  const calls = mockRequest(t, () => ({ status: 201, data: { id: '1' }, headers: {} }));
  await assert.rejects(() => dealerStudioAdapter.createLead({}, integration(), {}), (err) => err.code === 'AUTHENTICATION_FAILED');
  assert.equal(calls.length, 0);
});

test('a non-HTTPS base URL is refused before any request', async (t) => {
  withKey(t);
  const calls = mockRequest(t, () => ({ status: 201, data: { id: '1' }, headers: {} }));
  await assert.rejects(() => dealerStudioAdapter.createLead({}, integration({ base_url: 'http://8.8.8.8' }), {}));
  assert.equal(calls.length, 0);
});

test('the documented 201 { id, lead_cluster_id } yields the lead id', () => {
  const { extractExternalLeadId: extract } = dealerStudioAdapter._test;
  assert.equal(extract({ data: { id: 100001, lead_cluster_id: 200001 } }), '100001');
});

test('extractExternalLeadId falls back to other common id shapes, else nothing', () => {
  const { extractExternalLeadId: extract } = dealerStudioAdapter._test;
  assert.equal(extract({ data: { id: 'a1' } }), 'a1');
  assert.equal(extract({ data: { id: 77 } }), '77');
  assert.equal(extract({ data: { lead_id: 'b2' } }), 'b2');
  assert.equal(extract({ data: { data: { id: 'c3' } } }), 'c3');
  assert.equal(extract({ data: { lead: { id: 'd4' } } }), 'd4');
  assert.equal(extract({ data: '{"id":"e5"}' }), 'e5');
  assert.equal(extract({ data: {}, headers: { location: '/api/v1/leads/f6' } }), 'f6');
  assert.equal(extract({ data: 'OK' }), undefined);
  assert.equal(extract({ data: { id: '<html>' } }), undefined);
  assert.equal(extract({ data: { id: '' } }), undefined);
});

test('an accepted create with an unreadable id returns no id (the orchestrator holds it as ACK_UNRESOLVED)', async (t) => {
  withKey(t);
  mockRequest(t, () => ({ status: 201, data: 'OK', headers: {} }));
  const result = await dealerStudioAdapter.createLead({}, integration(), {});
  assert.equal(result.externalLeadId, undefined);
  assert.equal(result.httpStatus, 201);
});

test('testConnection checks the key at GET /api/v1/apikeys/apikey_details.json; only a 2xx is ok', async (t) => {
  const run = async (status) => {
    t.mock.restoreAll();
    withKey(t);
    const calls = mockRequest(t, () => ({ status, data: { locations: [] }, headers: {} }));
    const result = await dealerStudioAdapter.testConnection({}, integration());
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://8.8.8.8/api/v1/apikeys/apikey_details.json');
    assert.equal(calls[0].headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(result.httpStatus, status);
    return result.ok;
  };
  assert.equal(await run(200), true);
  assert.equal(await run(401), false);
  assert.equal(await run(403), false);
  assert.equal(await run(404), false); // wrong base URL
  assert.equal(await run(503), false);

  t.mock.restoreAll();
  withKey(t);
  mockRequest(t, () => { throw new Error('ECONNREFUSED'); });
  const down = await dealerStudioAdapter.testConnection({}, integration());
  assert.equal(down.ok, false);
  assert.equal(down.httpStatus, 0);
});
