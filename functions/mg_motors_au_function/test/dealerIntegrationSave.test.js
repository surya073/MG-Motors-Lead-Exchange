'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const routes = require('../routes/dealerCrmIntegrationRoutes');
const integrationAuthService = require('../services/integrations/integrationAuthService');

const SAVED_BASE_URL = 'https://8.8.8.8/api/leadapi';

async function setup(t) {
  const db = createInMemoryZcql({
    dealers: [{ dealer_code: 'AU999', dealer_name: 'Test Dealer' }],
    dealer_integrations: [{
      ROWID: '1000', dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: 'FUSION_SD',
      base_url: SAVED_BASE_URL, status: 'ACTIVE',
    }],
  });
  t.mock.method(catalyst, 'initialize', () => db.app);
  t.mock.method(integrationAuthService, 'saveCredential', async () => {});

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

  const saveIntegration = async (overrides) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/AU999/integration`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integration_type: 'EXTERNAL_CRM',
        crm_type: 'FUSION_SD',
        base_url: SAVED_BASE_URL,
        create_lead_endpoint: '/v1/leads',
        ...overrides,
      }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { db, saveIntegration };
}

test('saving an external CRM refuses a malformed, non-HTTPS, local or private base URL, for every CRM type', async (t) => {
  const { db, saveIntegration } = await setup(t);

  for (const crmType of ['FUSION_SD', 'GENERIC_REST']) {
    for (const baseUrl of ['http://8.8.8.8/api/leadapi', 'https://127.0.0.1/api', 'https://10.1.2.3/api', 'https://localhost/api', 'not a url']) {
      const result = await saveIntegration({ crm_type: crmType, base_url: baseUrl });
      assert.equal(result.status, 400, `${crmType} ${baseUrl}`);
      assert.equal(result.body.error, 'INVALID_CRM_CONFIGURATION');
      assert.equal(result.body.field, 'base_url');
      assert.equal(typeof result.body.message, 'string');
    }
  }
  assert.equal(db.tables.dealer_integrations[0].base_url, SAVED_BASE_URL, 'the saved configuration is untouched');
});

test('a public HTTPS base URL saves; so does one whose host does not resolve yet, and a portal dealer is not checked', async (t) => {
  const { db, saveIntegration } = await setup(t);

  const publicHost = await saveIntegration({ base_url: 'https://8.8.4.4/api/leadapi' });
  assert.equal(publicHost.status, 200, JSON.stringify(publicHost.body));
  assert.equal(db.tables.dealer_integrations[0].base_url, 'https://8.8.4.4/api/leadapi');

  // .invalid never resolves (RFC 2606). An unresolvable host is an outage, not
  // a bad configuration, and every request re-checks the URL anyway.
  const unresolvable = await saveIntegration({ base_url: 'https://dealer-host.invalid/api/leadapi' });
  assert.equal(unresolvable.status, 200, JSON.stringify(unresolvable.body));

  const portal = await saveIntegration({ integration_type: 'PORTAL', base_url: 'http://left-over.example.com' });
  assert.equal(portal.status, 200, JSON.stringify(portal.body));

  const noUrl = await saveIntegration({ base_url: '' });
  assert.equal(noUrl.status, 200, JSON.stringify(noUrl.body));
});
