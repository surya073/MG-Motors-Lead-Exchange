'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { classifyDealerError, isRetryableClass } = require('../services/integrations/dealerErrorClassifier');

const withStatus = (status, extra = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status }, ...extra });
const withCode = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

test('no HTTP response (network error, timeout, unresolvable host) is TRANSIENT', () => {
  for (const code of ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'ERR_NETWORK', 'DEALER_HOST_UNREACHABLE']) {
    assert.equal(classifyDealerError(withCode(code)), 'TRANSIENT', code);
  }
  // OAuth helpers preserve a real transport failure as a connection error.
  assert.equal(classifyDealerError(withCode('EXTERNAL_CRM_ERROR')), 'TRANSIENT');
  assert.equal(classifyDealerError(undefined), 'TRANSIENT');
});

test('missing/rejected credentials without an HTTP response are not retried as a network outage', () => {
  assert.equal(classifyDealerError(withCode('AUTHENTICATION_FAILED')), 'AUTH');
  assert.equal(classifyDealerError(withCode('CREDENTIAL_DECRYPT_FAILED')), 'PERMANENT');
  assert.equal(classifyDealerError(withStatus(429, { code: 'AUTHENTICATION_FAILED' })), 'TRANSIENT');
});

test('408, 429 and 5xx are TRANSIENT; 401 is AUTH; other 4xx are PERMANENT', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(classifyDealerError(withStatus(status)), 'TRANSIENT', String(status));
  }
  assert.equal(classifyDealerError(withStatus(401, { code: 'AUTHENTICATION_FAILED' })), 'AUTH');
  for (const status of [400, 403, 404, 409, 422]) {
    assert.equal(classifyDealerError(withStatus(status)), 'PERMANENT', String(status));
  }
});

test("Fusion's documented problem responses classify by their HTTP status", () => {
  assert.equal(classifyDealerError(fixtures.rateLimitedError()), 'TRANSIENT');
  assert.equal(classifyDealerError(fixtures.fusionProblemError('internal')), 'TRANSIENT');
  assert.equal(classifyDealerError(fixtures.fusionProblemError('dealer_unavailable')), 'TRANSIENT');
  assert.equal(classifyDealerError(fixtures.fusionProblemError('credential_revoked')), 'AUTH');
  for (const slug of ['invalid_payload', 'provider_unavailable', 'lead_not_found', 'idempotency_conflict', 'lead_not_ready', 'missing_contact']) {
    assert.equal(classifyDealerError(fixtures.fusionProblemError(slug)), 'PERMANENT', slug);
  }
});

test('our own queue limit and the OEM write-back are LOCAL, whatever else they carry', () => {
  assert.equal(classifyDealerError(withCode('CRM_API_QUEUE_FULL')), 'LOCAL');
  assert.equal(classifyDealerError(withCode('ZOHO_ACK_UPDATE_FAILED', { response: { status: 500 } })), 'LOCAL');
});

test('a dealer that answered without an id, a Zoho record rejection and a configuration error are PERMANENT', () => {
  assert.equal(classifyDealerError(withCode('DEALER_ACK_MISSING_ID')), 'PERMANENT');
  // Zoho rejects a record with HTTP 2xx and a record-level error code.
  assert.equal(classifyDealerError(withCode('EXTERNAL_CRM_ERROR', { response: { status: 200 }, zohoCode: 'DUPLICATE_DATA' })), 'PERMANENT');
  for (const code of ['INVALID_CRM_CONFIGURATION', 'FIELD_MAPPING_INVALID', 'STATUS_MAPPING_NOT_FOUND', 'UNSUPPORTED_OPERATION']) {
    assert.equal(classifyDealerError(withCode(code)), 'PERMANENT', code);
  }
});

test('only TRANSIENT and LOCAL failures are retried automatically', () => {
  assert.equal(isRetryableClass('TRANSIENT'), true);
  assert.equal(isRetryableClass('LOCAL'), true);
  assert.equal(isRetryableClass('AUTH'), false);
  assert.equal(isRetryableClass('PERMANENT'), false);
});
