'use strict';

const { baseIntegration, oauthApp, mockCredentialSnapshot } = require('./helpers/dealerZohoFixture');
const test = require('node:test');
test.beforeEach(mockCredentialSnapshot);
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const axios = require('axios');
const { assertZohoEndpoint } = require('../services/integrations/adapters/zohoEndpointPolicy');
const generic = require('../services/integrations/adapters/genericRestAdapter');
const zoho = require('../services/integrations/adapters/zohoCrmOAuthHelper');
const auth = require('../services/integrations/integrationAuthService');

test('Zoho endpoint policy accepts exact datacenter and CRM environment hosts', () => {
  for (const dc of ['com', 'com.au', 'eu', 'in', 'com.cn', 'jp', 'ca', 'sa', 'uk']) {
    const account = dc === 'ca' ? 'accounts.zohocloud.ca' : `accounts.zoho.${dc}`;
    assert.equal(assertZohoEndpoint(`https://${account}/oauth/v2/token`, 'accounts').hostname, account);
    for (const environment of ['www', 'sandbox', 'developer']) {
      const host = `${environment}.zohoapis.${dc}`;
      assert.equal(assertZohoEndpoint(`https://${host}/crm/v8/Leads`, 'api').hostname, host);
    }
  }
});

test('untrusted Zoho account URLs fail before reading credentials or sending a token request', async (t) => {
  const credential = t.mock.method(auth, 'getDecryptedCredential', async () => 'synthetic-secret');
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const post = t.mock.method(axios, 'post', async () => { throw new Error('must not post'); });
  for (const accounts of [
    'http://127.0.0.1', 'https://accounts.zoho.in.attacker.example',
    'https://attacker.example/accounts.zoho.in', 'https://user:pass@accounts.zoho.in',
    'https://accounts.zoho.in:8443', 'https://www.zohoapis.in',
  ]) {
    zoho._resetForTests();
    await assert.rejects(() => zoho.getAccessTokenForDealerZoho({}, {
      ...baseIntegration, ROWID: 'safety-test', oauth_accounts_domain: accounts,
    }), { code: 'INVALID_CRM_CONFIGURATION' });
  }
  assert.equal(credential.mock.callCount(), 0);
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(post.mock.callCount(), 0);
});

test('all dealer Zoho API operations refuse a third-party host before reading credentials', async (t) => {
  const credential = t.mock.method(auth, 'getDecryptedCredential', async () => 'synthetic-secret');
  const lookup = t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const integration = {
    ROWID: 'safety-test', crm_type: 'ZOHO_CRM', base_url: 'https://www.example.in',
    create_lead_endpoint: '/crm/v8/Leads', update_lead_endpoint: '/crm/v8/Leads/{externalLeadId}',
  };
  for (const send of [
    () => generic.createLead({}, integration, { Last_Name: 'Example' }),
    () => generic.updateLead({}, integration, '1', { Last_Name: 'Example' }),
    () => generic.getLead({}, integration, '1'),
    () => generic.testConnection({}, integration),
  ]) await assert.rejects(send, { code: 'INVALID_CRM_CONFIGURATION' });
  assert.equal(credential.mock.callCount(), 0);
  assert.equal(lookup.mock.callCount(), 0);
});

test('dealer Zoho credentials travel in a form body, with redirects disabled and HTTP transport pinned', async (t) => {
  zoho._resetForTests();
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(auth, 'getDecryptedCredential', async (_app, _id, type) => `synthetic-${type}`);
  const post = t.mock.method(axios, 'post', async (url, body, config) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://accounts.zoho.com.au');
    assert.equal(parsed.search, '', 'secrets are absent from the URL');
    const fields = new URLSearchParams(body);
    assert.equal(fields.get('grant_type'), 'refresh_token');
    assert.equal(fields.get('client_secret'), 'synthetic-OAUTH2_CLIENT_SECRET');
    assert.equal(fields.get('refresh_token'), 'synthetic-OAUTH2_REFRESH_TOKEN');
    assert.equal(config.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(config.maxRedirects, 0);
    assert.equal(config.proxy, false);
    assert.equal(config.adapter, 'http');
    assert.equal(typeof config.lookup, 'function');
    return { data: { access_token: 'synthetic-token', expires_in: 3600 } };
  });
  const integration = { ...baseIntegration, ROWID: 'safety-test', oauth_accounts_domain: 'https://accounts.zoho.com.au' };
  assert.equal(await zoho.getAccessTokenForDealerZoho(oauthApp(integration), integration), 'synthetic-token');
  assert.equal(post.mock.callCount(), 1);
  await assert.rejects(() => zoho.getAccessTokenForDealerZoho({}, {
    ...integration, oauth_accounts_domain: 'https://attacker.example',
  }), { code: 'INVALID_CRM_CONFIGURATION' }, 'the warm cache cannot bypass endpoint checks');
});

test('dealer Zoho token 429 retains transient error and Retry-After while 401 stays auth', async (t) => {
  zoho._resetForTests();
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(auth, 'getDecryptedCredential', async () => 'synthetic-secret');
  let status = 429;
  t.mock.method(axios, 'post', async () => {
    throw Object.assign(new Error('synthetic-secret'), {
      response: { status, headers: { 'retry-after': '30' }, data: { error_description: 'synthetic-secret' } },
    });
  });
  const integration = { ...baseIntegration, ROWID: 'safety-test', oauth_accounts_domain: 'https://accounts.zoho.in' };
  const get = () => zoho.getAccessTokenForDealerZoho(oauthApp(integration), integration);
  await assert.rejects(get, (err) => {
    assert.equal(err.code, 'EXTERNAL_CRM_ERROR');
    assert.deepEqual(err.vendor, { status: 429, retryAfter: 30 });
    assert.ok(!JSON.stringify(err).includes('synthetic-secret'));
    return true;
  });
  status = 401;
  await assert.rejects(get, { code: 'AUTHENTICATION_FAILED' });
});
