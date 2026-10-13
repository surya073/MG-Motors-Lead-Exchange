'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 5 (FUSION_REMEDIATION_PLAN.md): the FUSION_INBOUND_V2 switch, and the
// Fusion webhook signing secret stored as its own credential type.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const routes = require('../routes/dealerCrmIntegrationRoutes');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const { isFusionInboundV2Enabled } = require('../config/env');

function withEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

test('FUSION_INBOUND_V2 is off unless set to true', (t) => {
  withEnv(t, 'FUSION_INBOUND_V2', undefined);
  assert.equal(isFusionInboundV2Enabled(), false);
  process.env.FUSION_INBOUND_V2 = 'false';
  assert.equal(isFusionInboundV2Enabled(), false);
  process.env.FUSION_INBOUND_V2 = 'yes';
  assert.equal(isFusionInboundV2Enabled(), false);
  process.env.FUSION_INBOUND_V2 = ' TRUE ';
  assert.equal(isFusionInboundV2Enabled(), true);
});

async function setup(t, crmType, storedTypes = []) {
  const db = createInMemoryZcql({
    dealers: [{ dealer_code: 'AU999', dealer_name: 'Test Dealer' }],
    dealer_integrations: [{
      ROWID: '1000', dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: crmType,
      base_url: 'https://8.8.8.8/api/leadapi', status: 'ACTIVE',
    }],
  });
  t.mock.method(catalyst, 'initialize', () => db.app);
  const saved = [];
  t.mock.method(integrationAuthService, 'saveCredential', async (app, id, type, value) => {
    saved.push({ id, type, value });
  });
  t.mock.method(integrationAuthService, 'hasCredential', async (app, id, type) => storedTypes.includes(type));

  const server = express();
  server.use(express.json());
  server.use((req, res, next) => {
    res.locals.currentUser = { email_id: 'a@example.com', role_details: { role_id: ADMIN_ROLE_ID } };
    next();
  });
  server.use(routes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const url = `http://127.0.0.1:${listener.address().port}/AU999/integration`;

  const save = async (body) => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_type: 'EXTERNAL_CRM',
        crm_type: crmType,
        base_url: 'https://8.8.8.8/api/leadapi',
        create_lead_endpoint: '/v1/leads',
        oauth_accounts_domain: crmType === 'ZOHO_CRM' ? 'https://accounts.zoho.in' : undefined,
        ...body,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  const read = async () => {
    const response = await fetch(url);
    return { status: response.status, body: await response.json() };
  };
  return { save, read, saved };
}

test('a Fusion dealer\'s webhook signing secret is stored as WEBHOOK_SIGNING_SECRET, trimmed', async (t) => {
  const { save, saved } = await setup(t, 'FUSION_SD');
  const result = await save({ fusion_webhook_signing_secret: '  whsec_c2VjcmV0  ' });
  assert.equal(result.status, 200);
  assert.deepEqual(saved, [{ id: '1000', type: 'WEBHOOK_SIGNING_SECRET', value: 'whsec_c2VjcmV0' }]);
  assert.equal(JSON.stringify(result.body).includes('c2VjcmV0'), false, 'the secret is never echoed');
});

test('saving a Fusion dealer without a signing secret leaves the stored one alone', async (t) => {
  const { save, saved } = await setup(t, 'FUSION_SD');
  await save({ fusion_webhook_signing_secret: '   ' });
  await save({});
  assert.deepEqual(saved, []);
});

test('the signing secret field is ignored for ZOHO_CRM and GENERIC_REST dealers', async (t) => {
  for (const crmType of ['ZOHO_CRM', 'GENERIC_REST']) {
    await t.test(crmType, async (st) => {
      const { save, saved } = await setup(st, crmType);
      await save({ fusion_webhook_signing_secret: 'whsec_c2VjcmV0' });
      assert.equal(saved.some((row) => row.type === 'WEBHOOK_SIGNING_SECRET'), false);
    });
  }
});

test('reading a Fusion integration says whether a signing secret is stored, never its value', async (t) => {
  const withSecret = await setup(t, 'FUSION_SD', ['FUSION_ACCESS_KEY', 'FUSION_SECRET_KEY', 'WEBHOOK_SIGNING_SECRET']);
  const read = await withSecret.read();
  assert.equal(read.status, 200);
  assert.equal(read.body.hasCredential, true);
  assert.equal(read.body.hasWebhookSigningSecret, true);
});

test('a Fusion integration without a signing secret reads as not stored', async (t) => {
  const { read } = await setup(t, 'FUSION_SD', ['FUSION_ACCESS_KEY', 'FUSION_SECRET_KEY']);
  const result = await read();
  assert.equal(result.body.hasWebhookSigningSecret, false);
  assert.equal(result.body.hasCredential, true);
});

test('the GET response for a ZOHO_CRM dealer is unchanged (no signing-secret key)', async (t) => {
  const { read } = await setup(t, 'ZOHO_CRM', ['OAUTH2_CLIENT_ID', 'OAUTH2_CLIENT_SECRET', 'OAUTH2_REFRESH_TOKEN']);
  const result = await read();
  assert.equal(result.body.hasCredential, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result.body, 'hasWebhookSigningSecret'), false);
});
