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
const fixtures = require('./helpers/fusionFixtures');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const integrationAlertService = require('../services/integrations/integrationAlertService');

const { buildOutboundPayload, validateIntegrationConfiguration, classifyLogScenario } = crmIntegrationService._test;

// Outbound delivery to a Fusion SD dealer, end to end through the orchestrator
// with an in-memory datastore and a fake adapter.

const FIELD_MAPPINGS = Object.entries({
  enquiry_id: 'refID',
  customer_name: 'contact.firstName',
  mobile_number: 'contact.phone',
  email_address: 'contact.email',
  postcode: 'contact.areaCode',
  vehicle_model: 'requirement.model',
  nature_of_enquiry: 'enquiryType',
  lead_source: 'leadSource',
  dealer_code: 'campaign',
  accept_privacy_policy: 'privacy',
  lead_status: 'enquiryStatus',
}).map(([source_field, target_field]) => ({ source_field, target_field, data_type: 'string', required: true }));

// Not Contacted <-> Open both ways. Fusion "Won" is accepted as MG "Contacted",
// but MG "Contacted" is never sent out: an inbound-only row (preset of aa0045f).
const STATUS_MAPPINGS = [
  { source_status: 'Not Contacted', target_status: 'Open', direction: 'ZOHO_TO_EXTERNAL' },
  { source_status: 'Open', target_status: 'Not Contacted', direction: 'EXTERNAL_TO_ZOHO' },
  { source_status: 'Won', target_status: 'Contacted', direction: 'EXTERNAL_TO_ZOHO' },
];

const LEAD = {
  crm_record_id: 'ZL1', enquiry_id: 'ENQ-1', customer_name: 'Jane Citizen', mobile_number: '0412345678',
  email_address: 'jane@example.com', postcode: '3000', vehicle_model: 'MG ZS', nature_of_enquiry: 'Test Drive',
  lead_source: 'Website', dealer_code: 'AU999', accept_privacy_policy: true, lead_status: 'Not Contacted',
};

function setup(t, { mapping = {}, lead = {} } = {}) {
  const db = createInMemoryZcql({
    dealers: [{ dealer_code: 'AU999', dealer_name: 'Fusion Dealer' }],
    dealer_integrations: [{
      ROWID: '1000', dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: 'FUSION_SD',
      status: 'ACTIVE', outbound_enabled: true, base_url: 'https://8.8.8.8/api/leadapi', create_lead_endpoint: '/v1/leads',
    }],
    integration_field_mappings: FIELD_MAPPINGS.map((row) => ({ integration_id: '1000', ...row })),
    integration_status_mappings: STATUS_MAPPINGS.map((row) => ({ integration_id: '1000', ...row })),
    lead_integrations: [{
      integration_id: '1000', zoho_lead_id: 'ZL1', dealer_code: 'AU999',
      external_crm_lead_id: fixtures.FUSION_TEST_LEAD_ID, sync_status: 'SYNCED', ...mapping,
    }],
    leads: [{ ...LEAD, sync_status: 'SYNCED', ...lead }],
    integration_logs: [],
    outbound_sync_claims: [],
  });
  const alerts = t.mock.method(integrationAlertService, 'notifyScenario', async () => ({ sent: false }));
  return {
    db,
    alerts,
    integration: { ...db.tables.dealer_integrations[0] },
    leadRow: () => ({ ROWID: '1000', ...db.tables.leads[0] }),
    logs: () => db.tables.integration_logs,
  };
}

// A Fusion adapter whose updateLead answers with `respond(payload)`.
function fakeFusion(t, respond) {
  const sent = [];
  t.mock.method(crmAdapterFactory, 'getAdapter', () => ({
    createLead: async () => { throw new Error('createLead is not expected in these tests'); },
    updateLead: async (_app, _integration, externalLeadId, payload) => {
      sent.push(payload);
      return respond(externalLeadId, payload);
    },
  }));
  return sent;
}

const accepted = (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });

// --- New issue #2: inbound-only statuses must not block outbound delivery ---

test('an MG status with only an inbound mapping is left out of the payload; other fields still go to Fusion', async (t) => {
  const { db, integration, leadRow, logs } = setup(t, { lead: { lead_status: 'Contacted' } });
  const sent = fakeFusion(t, accepted);

  const result = await crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal('enquiryStatus' in sent[0], false, 'MG "Contacted" is never sent to Fusion');
  assert.equal(sent[0]['contact.firstName'], 'Jane Citizen');
  assert.equal(logs().at(-1).happy_unhappy_path_name, 'Happy 5');
});

test('an MG status with no mapping in either direction still holds the lead as Unhappy 5', async (t) => {
  const { db, integration, leadRow, logs } = setup(t, { lead: { lead_status: 'Follow-up 1' } });
  const sent = fakeFusion(t, accepted);

  await assert.rejects(
    () => crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow()),
    (err) => err.code === 'INVALID_CRM_CONFIGURATION'
  );
  assert.equal(sent.length, 0);
  assert.equal(logs().at(-1).happy_unhappy_path_name, 'Unhappy 5');
});

test('buildOutboundPayload and validateIntegrationConfiguration treat an inbound-only status like an MG-only one', () => {
  const integration = { crm_type: 'FUSION_SD', base_url: 'https://8.8.8.8/api/leadapi', create_lead_endpoint: '/v1/leads' };
  const lead = { ...LEAD, lead_status: 'Contacted' };

  assert.equal('enquiryStatus' in buildOutboundPayload(lead, FIELD_MAPPINGS, STATUS_MAPPINGS), false);
  assert.equal(buildOutboundPayload({ ...lead, lead_status: 'Not Contacted' }, FIELD_MAPPINGS, STATUS_MAPPINGS).enquiryStatus, 'Open');
  assert.deepEqual(validateIntegrationConfiguration(integration, FIELD_MAPPINGS, STATUS_MAPPINGS, 'Contacted'), { valid: true, missingConfig: [] });
  assert.deepEqual(
    validateIntegrationConfiguration(integration, FIELD_MAPPINGS, STATUS_MAPPINGS, 'Follow-up 1').missingConfig,
    ['status:Follow-up 1']
  );
  assert.throws(
    () => buildOutboundPayload({ ...lead, lead_status: 'Follow-up 1' }, FIELD_MAPPINGS, STATUS_MAPPINGS),
    (err) => err.code === 'STATUS_MAPPING_NOT_FOUND'
  );
});

test('the log classifier keeps Unhappy 4 for dealer -> MG status failures; outbound ones are Unhappy 5', () => {
  const failed = (direction) => ({ direction, operation: 'UPDATE_LEAD', status: 'FAILED', error_message: 'STATUS_MAPPING_NOT_FOUND' });

  assert.equal(classifyLogScenario(failed('ZOHO_TO_EXTERNAL_CRM')).code, 'Unhappy 5');
  assert.equal(classifyLogScenario(failed('EXTERNAL_CRM_TO_ZOHO')).code, 'Unhappy 4');
  assert.equal(
    classifyLogScenario({ direction: 'EXTERNAL_CRM_TO_ZOHO', status: 'FAILED' }, { unmappedStatusValue: 'Sold' }).code,
    'Unhappy 4'
  );
});
