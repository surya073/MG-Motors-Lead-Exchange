'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const { deriveInboundEnabled } = require('../routes/dealerCrmIntegrationRoutes')._test;

test('Fusion SD: inbound follows the "send updates back" toggle; every other CRM type stays inbound-enabled', () => {
  assert.equal(deriveInboundEnabled('FUSION_SD', true), true);
  assert.equal(deriveInboundEnabled('FUSION_SD', false), false);
  assert.equal(deriveInboundEnabled('FUSION_SD', undefined), false);
  assert.equal(deriveInboundEnabled('ZOHO_CRM', false), true);
  assert.equal(deriveInboundEnabled('GENERIC_REST', undefined), true);
});

test('replay leaves held inbound rows of an unreadable CRM (Fusion SD) untouched and does not try to fetch them', async (t) => {
  _resetForTests();
  let fetched = 0;
  t.mock.method(crmIntegrationService, 'replayInboundLead', async () => { fetched += 1; return {}; });
  const db = createInMemoryZcql({
    dealer_integrations: [{ ROWID: '1000', dealer_code: '568026', crm_type: 'FUSION_SD', integration_type: 'EXTERNAL_CRM', inbound_enabled: true }],
    lead_integrations: [{ integration_id: '1000', external_crm_lead_id: 'lead_1', zoho_lead_id: 'z1', sync_status: 'SYNCED' }],
    integration_logs: [{
      integration_id: '1000', external_lead_id: 'lead_1', happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
      error_message: 'STATUS_MAPPING_NOT_FOUND',
    }],
  });
  const before = JSON.stringify(db.tables.integration_logs);

  const results = await inboundReplayScheduler.runInboundReplaySweep(db.app);

  assert.equal(fetched, 0, 'no read-back attempted against Fusion');
  assert.equal(results.attempted, 0);
  assert.equal(JSON.stringify(db.tables.integration_logs), before, 'held row not modified');
});
