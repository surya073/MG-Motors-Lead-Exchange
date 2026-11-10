'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getFusionRequestTimeoutMs } = require('../config/env');
const { withEnv } = require('./helpers/outboundHarness');

test('the Fusion request timeout is 20 seconds unless FUSION_REQUEST_TIMEOUT_MS says otherwise', (t) => {
  withEnv(t, { FUSION_REQUEST_TIMEOUT_MS: undefined });
  assert.equal(getFusionRequestTimeoutMs(), 20000);
  for (const [value, expected] of [['30000', 30000], ['10000', 10000], [' 15000 ', 15000], ['0', 20000], ['abc', 20000], ['-5', 20000], ['', 20000]]) {
    process.env.FUSION_REQUEST_TIMEOUT_MS = value;
    assert.equal(getFusionRequestTimeoutMs(), expected, `"${value}"`);
  }
});
