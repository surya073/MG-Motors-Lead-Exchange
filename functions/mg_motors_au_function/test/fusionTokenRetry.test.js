'use strict';

// Audit handover §7 (Unhappy 1 → Happy 4 → Happy 1): Fusion's token endpoint
// often does not answer within 10 s on the first call after the integration
// has been idle, so the first send fails before any lead reaches Fusion.
// FUSION_TOKEN_RETRY retries that token call once; FUSION_TOKEN_TIMEOUT_MS
// sets its timeout. Both unset keep today's behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const fusionSdOAuthHelper = require('../services/integrations/adapters/fusionSdOAuthHelper');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const env = require('../config/env');

function fakeIntegration(overrides = {}) {
  return {
    ROWID: '7001',
    dealer_code: 'AU999',
    crm_type: 'FUSION_SD',
    base_url: 'https://qa.fusionamspro.com/api/leadapi',
    ...overrides,
  };
}

function timeoutError() {
  const err = new Error('timeout of 10000ms exceeded');
  err.code = 'ECONNABORTED';
  return err;
}

function withEnv(t, vars) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function mockKeys(t) {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, credType) =>
    credType === 'FUSION_ACCESS_KEY' ? 'ak' : 'sk'
  );
}

test('env: FUSION_TOKEN_RETRY is off unless set to true', (t) => {
  withEnv(t, { FUSION_TOKEN_RETRY: undefined });
  assert.equal(env.isFusionTokenRetryEnabled(), false);
  process.env.FUSION_TOKEN_RETRY = 'TRUE';
  assert.equal(env.isFusionTokenRetryEnabled(), true);
  process.env.FUSION_TOKEN_RETRY = 'yes';
  assert.equal(env.isFusionTokenRetryEnabled(), false);
});

test('env: FUSION_TOKEN_TIMEOUT_MS defaults to 10000 and ignores bad values', (t) => {
  withEnv(t, { FUSION_TOKEN_TIMEOUT_MS: undefined });
  assert.equal(env.getFusionTokenTimeoutMs(), 10000);
  process.env.FUSION_TOKEN_TIMEOUT_MS = '15000';
  assert.equal(env.getFusionTokenTimeoutMs(), 15000);
  for (const bad of ['0', '-5', 'abc', '1.5', '']) {
    process.env.FUSION_TOKEN_TIMEOUT_MS = bad;
    assert.equal(env.getFusionTokenTimeoutMs(), 10000, `"${bad}" falls back to 10000`);
  }
});

test('flag off: a token timeout fails at once, as today (one call, connection error)', async (t) => {
  withEnv(t, { FUSION_TOKEN_RETRY: undefined, FUSION_TOKEN_TIMEOUT_MS: undefined });
  fusionSdOAuthHelper._resetForTests();
  mockKeys(t);
  const timeouts = [];
  t.mock.method(axios, 'post', async (_url, _body, config) => {
    timeouts.push(config.timeout);
    throw timeoutError();
  });

  await assert.rejects(
    () => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, fakeIntegration()),
    (err) => err.code === 'EXTERNAL_CRM_ERROR'
  );
  assert.deepEqual(timeouts, [10000]);
});

test('flag on: a token timeout is retried once and the second token is used and cached', async (t) => {
  withEnv(t, { FUSION_TOKEN_RETRY: 'true', FUSION_TOKEN_TIMEOUT_MS: undefined });
  fusionSdOAuthHelper._resetForTests();
  mockKeys(t);
  let calls = 0;
  t.mock.method(axios, 'post', async () => {
    calls += 1;
    if (calls === 1) throw timeoutError();
    return { data: { access_token: 'tok-second', expires_in: 600 } };
  });

  const integration = fakeIntegration();
  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration), 'tok-second');
  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration), 'tok-second');
  assert.equal(calls, 2, 'one timed-out call, one retry, then the cache');
});

test('flag on: a connection error (no response) is also retried once', async (t) => {
  withEnv(t, { FUSION_TOKEN_RETRY: 'true' });
  fusionSdOAuthHelper._resetForTests();
  mockKeys(t);
  let calls = 0;
  t.mock.method(axios, 'post', async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('socket hang up');
      err.code = 'ECONNRESET';
      throw err;
    }
    return { data: { access_token: 'tok-reset', expires_in: 600 } };
  });

  assert.equal(await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, fakeIntegration()), 'tok-reset');
  assert.equal(calls, 2);
});

test('flag on: two timeouts in a row still fail as a connection error after exactly two calls', async (t) => {
  withEnv(t, { FUSION_TOKEN_RETRY: 'true' });
  fusionSdOAuthHelper._resetForTests();
  mockKeys(t);
  let calls = 0;
  t.mock.method(axios, 'post', async () => {
    calls += 1;
    throw timeoutError();
  });

  await assert.rejects(
    () => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, fakeIntegration()),
    (err) => err.code === 'EXTERNAL_CRM_ERROR' && err.response === undefined
  );
  assert.equal(calls, 2);
});

test('flag on: an answer from Fusion (401 wrong keys, 500) is never retried', async (t) => {
  withEnv(t, { FUSION_TOKEN_RETRY: 'true' });
  for (const status of [401, 500]) {
    fusionSdOAuthHelper._resetForTests();
    mockKeys(t);
    let calls = 0;
    t.mock.method(axios, 'post', async () => {
      calls += 1;
      const err = new Error(`Request failed with status code ${status}`);
      err.response = { status };
      throw err;
    });

    await assert.rejects(
      () => fusionSdOAuthHelper.getAccessTokenForFusionSd({}, fakeIntegration()),
      (err) => err.code === 'AUTHENTICATION_FAILED' && err.response.status === status
    );
    assert.equal(calls, 1, `HTTP ${status} is not retried`);
    t.mock.restoreAll();
  }
});

test('FUSION_TOKEN_TIMEOUT_MS sets the timeout of every token call, the retry included', async (t) => {
  withEnv(t, { FUSION_TOKEN_RETRY: 'true', FUSION_TOKEN_TIMEOUT_MS: '12000' });
  fusionSdOAuthHelper._resetForTests();
  mockKeys(t);
  const timeouts = [];
  t.mock.method(axios, 'post', async (_url, _body, config) => {
    timeouts.push(config.timeout);
    if (timeouts.length === 1) throw timeoutError();
    return { data: { access_token: 'tok', expires_in: 600 } };
  });

  await fusionSdOAuthHelper.getAccessTokenForFusionSd({}, fakeIntegration());
  assert.deepEqual(timeouts, [12000, 12000]);
});

test('flag on: concurrent callers still share one refresh (and one retry)', async (t) => {
  withEnv(t, { FUSION_TOKEN_RETRY: 'true' });
  fusionSdOAuthHelper._resetForTests();
  mockKeys(t);
  let calls = 0;
  t.mock.method(axios, 'post', async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (calls === 1) throw timeoutError();
    return { data: { access_token: 'tok-shared', expires_in: 600 } };
  });

  const integration = fakeIntegration();
  const tokens = await Promise.all([
    fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration),
    fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration),
    fusionSdOAuthHelper.getAccessTokenForFusionSd({}, integration),
  ]);
  assert.deepEqual(tokens, ['tok-shared', 'tok-shared', 'tok-shared']);
  assert.equal(calls, 2);
});
