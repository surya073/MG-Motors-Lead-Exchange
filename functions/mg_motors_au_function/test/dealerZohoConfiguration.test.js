'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const catalyst = require('zcatalyst-sdk-node');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const auth = require('../services/integrations/integrationAuthService');
const oauth = require('../services/integrations/adapters/zohoCrmOAuthHelper');
const routes = require('../routes/dealerCrmIntegrationRoutes');
const handler = (method, path) => routes.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]).route.stack.at(-1).handle;
const integration = {
  ROWID: '1000', dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: 'ZOHO_CRM',
  status: 'ACTIVE', inbound_enabled: true, base_url: 'https://www.zohoapis.in', oauth_accounts_domain: 'https://accounts.zoho.in',
};
function setup(t, linked = false) {
  const db = createInMemoryZcql({
    dealers: [{ ROWID: '500', dealer_code: 'AU999', sync_status: 'Synced' }],
    dealer_integrations: [{ ...integration }],
    lead_integrations: linked ? [{ ROWID: '2000', integration_id: '1000', external_lead_id: 'old-org-lead' }] : [],
  });
  t.mock.method(catalyst, 'initialize', () => db.app);
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(auth, 'getDecryptedCredential', async (_app, _id, type) => `old-${type}`);
  const save = t.mock.method(auth, 'saveCredential', async () => {});
  const invalidated = t.mock.method(oauth, 'invalidateToken', () => {});
  async function invoke(body, method = 'put', path = '/:dealerCode/integration') {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(result) { this.body = result; return this; } };
    await handler(method, path)({ params: { dealerCode: 'AU999' }, body: { ...integration, ...body } }, res);
    return res;
  }
  return { db, save, invalidated, invoke };
}

test('saving Zoho refuses nonofficial API/accounts hosts before changing stored configuration', async (t) => {
  const { db, save, invoke } = setup(t);
  for (const changes of [{ base_url: 'https://outside.example' }, { oauth_accounts_domain: 'https://outside.example' }, { base_url: '' }]) {
    const res = await invoke(changes);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'INVALID_CRM_CONFIGURATION');
  }
  assert.equal(save.mock.callCount(), 0);
  assert.equal(db.tables.dealer_integrations[0].status, 'ACTIVE');
});

test('linked Zoho lead IDs cannot follow an account/host/client/refresh-token switch', async (t) => {
  const { db, save, invalidated, invoke } = setup(t, true);
  for (const changes of [{ base_url: 'https://www.zohoapis.com.au' }, { oauth_accounts_domain: 'https://accounts.zoho.com.au' },
    { oauth_client_id: 'new-client' }, { oauth_refresh_token: 'new-org-refresh' }, { crm_type: 'GENERIC_REST' }]) {
    const res = await invoke(changes);
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.error, 'CRM_ACCOUNT_MIGRATION_REQUIRED');
  }
  assert.equal(save.mock.callCount(), 0);
  assert.equal(invalidated.mock.callCount(), 0);
  assert.equal(db.tables.dealer_integrations[0].status, 'ACTIVE');
});

test('same-org client-secret rotation and unchanged identity credentials preserve linked mappings', async (t) => {
  const { db, save, invalidated, invoke } = setup(t, true);
  const res = await invoke({ oauth_client_secret: 'new-secret', oauth_refresh_token: 'old-OAUTH2_REFRESH_TOKEN', oauth_client_id: 'old-OAUTH2_CLIENT_ID' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(save.mock.callCount(), 3);
  assert.equal(invalidated.mock.callCount(), 2, 'invalidate both before and after credential writes');
  assert.equal(db.tables.lead_integrations[0].external_lead_id, 'old-org-lead');
});

test('an unlinked integration can switch official datacenters and refresh credentials', async (t) => {
  const { invoke } = setup(t);
  const res = await invoke({ base_url: 'https://www.zohoapis.com.au', oauth_accounts_domain: 'https://accounts.zoho.com.au', oauth_refresh_token: 'new-token' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('manual watch registration rejects a removed dealer before credential access', async (t) => {
  const { db, invoke } = setup(t);
  db.tables.dealers[0].sync_status = 'Removed';
  const res = await invoke({}, 'post', '/:dealerCode/register-webhook');
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'DEALER_NOT_ACTIVE');
});


test('switching a linked non-Zoho integration to Zoho also requires migration', async (t) => {
  const { db, invoke } = setup(t, true);
  db.tables.dealer_integrations[0].crm_type = 'GENERIC_REST';
  const res = await invoke({});
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'CRM_ACCOUNT_MIGRATION_REQUIRED');
});
