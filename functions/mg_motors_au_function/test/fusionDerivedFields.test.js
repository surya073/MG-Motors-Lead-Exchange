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
const { deriveSourceFields, missingDeliveryMappingFields } = require('../services/integrations/leadMappingService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const leadFingerprintService = require('../services/integrations/leadFingerprintService');

const { buildOutboundPayload, validateIntegrationConfiguration } = crmIntegrationService._test;

// Q2 (Fusion's guidance, 13 Oct 2026): Fusion only displays Enquiry Type,
// Origin, Source and Campaign when the value is on the dealer's list. Two
// computed mapping sources fill them: enquiry_channel (Internet / Phone /
// Walk In, from MG's lead source) and lead_origin (Manufacturer Lead). MG's
// Nature of Enquiry goes to Source; the dealer code is no longer sent.

// Mirrors FUSION_DEFAULT_FIELD_MAPPINGS in mg-motor-web DealerCRMConfig.jsx.
const FUSION_PRESET = [
  ['enquiry_id', 'refID', 'string', true],
  ['first_name', 'contact.firstName', 'string', false],
  ['last_name', 'contact.lastName', 'string', false],
  ['mobile_number', 'contact.phone', 'string', true],
  ['email_address', 'contact.email', 'string', true],
  ['postcode', 'contact.areaCode', 'string', true],
  ['vehicle_model', 'requirement.model', 'string', true],
  ['enquiry_channel', 'enquiryType', 'string', true],
  ['lead_origin', 'origin', 'string', true],
  ['nature_of_enquiry', 'leadSource', 'string', true],
  ['accept_privacy_policy', 'privacy', 'boolean', true],
  ['lead_status', 'enquiryStatus', 'string', true],
  ['receive_marketing_updates', 'contact.marketingOptinEmail', 'boolean', false],
  ['dealer_rejected_reason', 'lostReason', 'string', false],
].map(([source_field, target_field, data_type, required]) => ({ source_field, target_field, data_type, required }));

const STATUS_ROWS = [{ source_status: 'Not Contacted', target_status: 'Open', direction: 'ZOHO_TO_EXTERNAL' }];

const LEAD = {
  crm_record_id: 'ZL1', enquiry_id: 'ENQ-1', customer_name: 'Jane Citizen', mobile_number: '0412345678',
  email_address: 'jane@example.com', postcode: '7250', vehicle_model: 'MG4', nature_of_enquiry: 'Test Drive',
  lead_source: 'OEM AU Website', dealer_code: '725001', accept_privacy_policy: true, lead_status: 'Not Contacted',
  receive_marketing_updates: true, dealer_rejected_reason: '',
};

test('enquiry_channel turns MG lead sources into Fusion enquiry types; lead_origin is fixed', () => {
  const channel = (lead_source) => deriveSourceFields({ lead_source }).enquiry_channel;
  assert.equal(channel('Phone'), 'Phone');
  assert.equal(channel('phone'), 'Phone');
  assert.equal(channel('Walk-in'), 'Walk In');
  assert.equal(channel('Walk In'), 'Walk In');
  for (const web of ['OEM AU Website', 'Website', 'OEM Drivechat', 'OEM Marketing Activity', 'MG Dealer Website Chat', 'Referral', '', undefined]) {
    assert.equal(channel(web), 'Internet', String(web));
  }
  assert.equal(deriveSourceFields({}).lead_origin, 'Manufacturer Lead');
});

test('the Fusion preset sends enquiry type, origin and source on the dealer\'s lists, and no campaign', () => {
  const payload = buildOutboundPayload(LEAD, FUSION_PRESET, STATUS_ROWS, { crmType: 'FUSION_SD', operation: 'CREATE_LEAD' });
  assert.equal(payload.enquiryType, 'Internet');
  assert.equal(payload.origin, 'Manufacturer Lead');
  assert.equal(payload.leadSource, 'Test Drive');
  assert.ok(!('campaign' in payload));
  assert.equal(payload['contact.marketingOptinEmail'], true);

  const phone = buildOutboundPayload({ ...LEAD, lead_source: 'Phone' }, FUSION_PRESET, STATUS_ROWS, { crmType: 'FUSION_SD', operation: 'CREATE_LEAD' });
  assert.equal(phone.enquiryType, 'Phone');
});

test('Fusion needs no dealer code, and a derived source covers the field it comes from; other CRM types are unchanged', () => {
  const fusionSources = FUSION_PRESET.map((m) => m.source_field);
  assert.deepEqual(missingDeliveryMappingFields(fusionSources, 'FUSION_SD'), []);

  const withoutChannel = fusionSources.filter((f) => f !== 'enquiry_channel');
  assert.deepEqual(missingDeliveryMappingFields(withoutChannel, 'FUSION_SD'), ['lead_source']);

  for (const crmType of ['ZOHO_CRM', 'GENERIC_REST']) {
    assert.deepEqual(missingDeliveryMappingFields(fusionSources, crmType), ['customer_name', 'lead_source', 'dealer_code'], crmType);
  }

  const fusion = validateIntegrationConfiguration(
    { crm_type: 'FUSION_SD', base_url: 'https://8.8.8.8', create_lead_endpoint: '/v1/leads' },
    FUSION_PRESET, STATUS_ROWS, 'Not Contacted'
  );
  assert.deepEqual(fusion, { valid: true, missingConfig: [] });
  const zoho = validateIntegrationConfiguration(
    { crm_type: 'ZOHO_CRM', base_url: 'https://8.8.8.8', create_lead_endpoint: '/x', update_lead_endpoint: '/x/{id}' },
    FUSION_PRESET, STATUS_ROWS, 'Not Contacted'
  );
  assert.equal(zoho.valid, false);
  assert.deepEqual(zoho.missingConfig, ['field:customer_name', 'field:lead_source', 'field:dealer_code']);
});

test('a lead source change still changes the fingerprint when only enquiry_channel is mapped', () => {
  const keys = leadFingerprintService.fingerprintKeys(FUSION_PRESET);
  assert.ok(keys.includes('lead_source'));
  const before = leadFingerprintService.computeFingerprint(LEAD, FUSION_PRESET);
  const after = leadFingerprintService.computeFingerprint({ ...LEAD, lead_source: 'Phone' }, FUSION_PRESET);
  assert.notEqual(before, after);
});

// --- the save route ---

function setup(t, crmType) {
  const db = createInMemoryZcql({
    dealers: [{ dealer_code: '725001', dealer_name: 'Buckby MG' }],
    dealer_integrations: [{ ROWID: '1000', dealer_code: '725001', integration_type: 'EXTERNAL_CRM', crm_type: crmType }],
    integration_status_mappings: [],
    integration_field_mappings: [],
  });
  t.mock.method(catalyst, 'initialize', () => db.app);
  return db;
}

async function saveMappings(t, fieldMappings) {
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
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/725001/integration/mappings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldMappings, statusMappings: [{ source_status: 'Not Contacted', target_status: 'Open' }] }),
  });
  return { status: response.status, body: await response.json() };
}

test('the save route accepts the Fusion preset for a Fusion dealer, and still requires the dealer code elsewhere', async (t) => {
  setup(t, 'FUSION_SD');
  const fusion = await saveMappings(t, FUSION_PRESET);
  assert.equal(fusion.status, 200, JSON.stringify(fusion.body));

  setup(t, 'ZOHO_CRM');
  const zoho = await saveMappings(t, FUSION_PRESET);
  assert.equal(zoho.status, 400);
  assert.deepEqual(zoho.body.missingFields, ['customer_name', 'lead_source', 'dealer_code']);
});
