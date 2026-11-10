'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

const authError = (status) => Object.assign(new Error(`Dealer CRM rejected the request (HTTP ${status})`), {
  code: 'AUTHENTICATION_FAILED',
  response: { status },
  vendor: { status, detail: 'API key not authorised for this dealership' },
});

for (const status of [401, 403]) {
  test(`a lead delivery answered HTTP ${status} keeps the dealer connected and records the dealer's reason`, async (t) => {
    const harness = setupOutbound(t, { integration: { status: 'CONNECTED' }, mapping: null, lead: { sync_status: 'PENDING' } });
    fakeAdapter(t, { createLead: async () => { throw authError(status); } });

    await assert.rejects(() => crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()));

    assert.equal(harness.db.tables.dealer_integrations[0].status, 'CONNECTED', 'the dealer is not flipped to ERROR');
    const log = harness.logs().at(-1);
    assert.equal(log.status, 'FAILED');
    assert.equal(log.http_status, status);
    assert.equal(log.error_message, `AUTHENTICATION_FAILED: HTTP ${status} - API key not authorised for this dealership`);
    const changes = JSON.parse(log.field_changes);
    assert.deepEqual(changes.find((c) => c.field === 'dealer_error'), { field: 'dealer_error', status, detail: 'API key not authorised for this dealership' });
  });
}

test('a non-authentication failure keeps its plain error code', async (t) => {
  const harness = setupOutbound(t, { integration: { status: 'CONNECTED' }, mapping: null, lead: { sync_status: 'PENDING' } });
  fakeAdapter(t, { createLead: async () => { throw Object.assign(new Error('boom'), { code: 'EXTERNAL_CRM_ERROR', response: { status: 503 } }); } });
  await assert.rejects(() => crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()));
  assert.equal(harness.logs().at(-1).error_message, 'EXTERNAL_CRM_ERROR');
  assert.equal(harness.db.tables.dealer_integrations[0].status, 'CONNECTED');
});
