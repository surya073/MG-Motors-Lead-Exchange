'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 6 (FUSION_REMEDIATION_PLAN.md), audit L7: the admin out-of-order
// panel reads each held dealer record back for display. Fusion SD cannot be
// read back, so its records showed as "Not found at dealer". It now checks
// first and says the record is not readable from the dealer.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const routes = require('../routes/adminDashboardRoutes');
const aiAssistantToolService = require('../services/aiAssistantToolService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');

async function outOfOrder(t, { crmType, externalLeadId, getLead }) {
  t.mock.method(aiAssistantToolService, 'getOutOfOrderEvents', async () => [
    { dealerCode: 'D1', externalLeadId, integrationId: '1000', state: 'Held' },
  ]);
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({ ROWID: '1000', crm_type: crmType }));
  const realGetAdapter = crmAdapterFactory.getAdapter;
  const calls = [];
  t.mock.method(crmAdapterFactory, 'getAdapter', (type) => ({
    ...realGetAdapter(type),
    getLead: async (...args) => { calls.push(args); return getLead(); },
  }));

  const server = express();
  server.use((req, res, next) => {
    res.locals.catalystApp = {};
    res.locals.currentUser = { email_id: 'a@example.com', role_details: { role_id: ADMIN_ROLE_ID } };
    next();
  });
  server.use(routes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/admin/out-of-order-events`);
  return { status: response.status, body: await response.json(), calls };
}

test('a Fusion record is shown as not readable from the dealer, without a read attempt', async (t) => {
  const { status, body, calls } = await outOfOrder(t, {
    crmType: 'FUSION_SD', externalLeadId: 'lead_unreadable_1', getLead: async () => { throw new Error('unsupported'); },
  });
  assert.equal(status, 200);
  assert.equal(calls.length, 0);
  assert.equal(body.events[0].dealerRecordUnreadable, true);
  assert.equal(body.events[0].dealerRecordMissing, undefined);
});

test('a Zoho dealer record is still read for its name and status, as before', async (t) => {
  const { body, calls } = await outOfOrder(t, {
    crmType: 'ZOHO_CRM', externalLeadId: 'zoho_readable_1',
    getLead: async () => ({ raw: { data: [{ Full_Name: 'Jane Citizen', Lead_Status: 'Contacted' }] } }),
  });
  assert.equal(calls.length, 1);
  assert.equal(body.events[0].customerName, 'Jane Citizen');
  assert.equal(body.events[0].dealerStatus, 'Contacted');
  assert.equal(body.events[0].dealerRecordUnreadable, undefined);
});

test('a Zoho record the dealer no longer has is still "missing"', async (t) => {
  const { body } = await outOfOrder(t, {
    crmType: 'ZOHO_CRM', externalLeadId: 'zoho_missing_1', getLead: async () => { throw new Error('404'); },
  });
  assert.equal(body.events[0].dealerRecordMissing, true);
});
