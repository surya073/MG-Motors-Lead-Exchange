'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const dns = require('dns').promises;
const auth = require('../services/integrations/integrationAuthService');
const oauth = require('../services/integrations/adapters/zohoCrmOAuthHelper');
const watch = require('../services/zohoWebhookService');
const logger = require('../utils/logger');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { mockCredentialSnapshot } = require('./helpers/dealerZohoFixture');
const integration = {
  ROWID: '1000', dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: 'ZOHO_CRM',
  status: 'ACTIVE', inbound_enabled: true, base_url: 'https://www.zohoapis.in',
  oauth_accounts_domain: 'https://accounts.zoho.in',
};
function fixture(t) {
  oauth._resetForTests();
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  mockCredentialSnapshot(t);
  const secrets = t.mock.method(auth, 'getDecryptedCredential', async () => 'synthetic-sensitive-value');
  const db = createInMemoryZcql({
    dealer_integrations: [{ ...integration }],
    webhook_channels: [{ ROWID: '2000', dealer_code: 'AU999', channel_id: 'old', CREATEDTIME: '2026-01-01' }],
  });
  return { db, secrets };
}

test('dealer watch refuses unsafe or unsupported API hosts before any credential access or HTTP call', async (t) => {
  const { db, secrets } = fixture(t);
  const post = t.mock.method(axios, 'post', async () => { throw new Error('must not call'); });
  for (const base_url of ['https://outside.example', 'https://www.zohoapis.in.attacker.example',
    'http://www.zohoapis.in', 'https://user:pass@www.zohoapis.in', 'https://www.zohoapis.in:8443']) {
    await assert.rejects(watch.registerDealerWatchChannel(db.app, { ...integration, base_url }), { code: 'INVALID_CRM_CONFIGURATION' });
  }
  assert.equal(secrets.mock.callCount(), 0);
  assert.equal(post.mock.callCount(), 0);
});

test('dealer watch refuses private DNS and ineligible integrations before secrets', async (t) => {
  const { db, secrets } = fixture(t);
  for (const changes of [{ status: 'DISABLED' }, { inbound_enabled: false }, { crm_type: 'FUSION_SD' }, { integration_type: 'PORTAL' }]) {
    await assert.rejects(watch.registerDealerWatchChannel(db.app, { ...integration, ...changes }), { code: 'INVALID_CRM_CONFIGURATION' });
  }
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(watch.registerDealerWatchChannel(db.app, integration), { code: 'INVALID_CRM_CONFIGURATION' });
  assert.equal(secrets.mock.callCount(), 0);
});

test('watch register and deregister both pin a validated destination and refuse redirects/proxies', async (t) => {
  const { db } = fixture(t);
  const requests = [];
  t.mock.method(axios, 'post', async (url, body, config) => {
    if (url.includes('/oauth/')) return { data: { access_token: 'synthetic-access-token', expires_in: 3600 } };
    requests.push({ url, config });
    assert.equal(typeof body.watch[0].token, 'string');
    return { data: { watch: [{ code: 'SUCCESS' }] } };
  });
  t.mock.method(axios, 'delete', async (url, config) => { requests.push({ url, config }); return { data: {} }; });
  await watch.registerDealerWatchChannel(db.app, integration);
  assert.equal(requests.length, 2);
  for (const { url, config } of requests) {
    assert.equal(url, 'https://www.zohoapis.in/crm/v8/actions/watch');
    assert.equal(config.maxRedirects, 0);
    assert.equal(config.proxy, false);
    assert.equal(config.adapter, 'http');
    assert.equal(typeof config.lookup, 'function');
    assert.equal(config.headers.Authorization, 'Zoho-oauthtoken synthetic-access-token');
  }
});

test('watch API failures never expose the vendor body, request headers or callback token', async (t) => {
  const { db } = fixture(t);
  const logs = [];
  t.mock.method(logger, 'error', (...args) => logs.push(args));
  t.mock.method(axios, 'delete', async () => { throw Object.assign(new Error('synthetic-sensitive-value'), { response: { status: 404, data: 'synthetic-sensitive-value' } }); });
  t.mock.method(axios, 'post', async (url) => {
    if (url.includes('/oauth/')) return { data: { access_token: 'synthetic-sensitive-value', expires_in: 3600 } };
    throw Object.assign(new Error('synthetic-sensitive-value'), { response: { status: 302, data: 'synthetic-sensitive-value' }, config: { headers: { Authorization: 'synthetic-sensitive-value' } } });
  });
  await assert.rejects(watch.registerDealerWatchChannel(db.app, integration), (err) => {
    assert.match(err.message, /HTTP 302/);
    assert.ok(!err.message.includes('synthetic-sensitive-value'));
    return true;
  });
  assert.ok(!JSON.stringify(logs).includes('synthetic-sensitive-value'));
});
