'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { parseTriState } = require('../services/integrations/leadMappingService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const fusionSdAdapter = require('../services/integrations/adapters/fusionSdAdapter');
const fusionSdOAuthHelper = require('../services/integrations/adapters/fusionSdOAuthHelper');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');

const { buildOutboundPayload } = crmIntegrationService._test;

// H1 (FUSION_REMEDIATION_PLAN.md Batch 4): Fusion records an opt-in that is
// left out as "unstated", so an unknown consent must never be sent as false;
// a create leaves out empty optional fields; a lost reason only goes with a
// lost status. Other CRM types keep today's payload exactly.

const FIELDS = [
  ['enquiry_id', 'refID', 'string', true],
  ['customer_name', 'contact.firstName', 'string', true],
  ['mobile_number', 'contact.phone', 'string', true],
  ['email_address', 'contact.email', 'string', true],
  ['postcode', 'contact.areaCode', 'string', true],
  ['vehicle_model', 'requirement.model', 'string', true],
  ['nature_of_enquiry', 'enquiryType', 'string', true],
  ['lead_source', 'leadSource', 'string', true],
  ['dealer_code', 'campaign', 'string', true],
  ['accept_privacy_policy', 'privacy', 'boolean', true],
  ['lead_status', 'enquiryStatus', 'string', true],
  ['receive_marketing_updates', 'contact.marketingOptinEmail', 'boolean', false],
  ['dealer_rejected_reason', 'lostReason', 'string', false],
  ['customer_message', 'notes', 'string', false],
].map(([source_field, target_field, data_type, required]) => ({ source_field, target_field, data_type, required }));

const STATUS_ROWS = [
  { source_status: 'Not Contacted', target_status: 'Open', direction: 'ZOHO_TO_EXTERNAL' },
  { source_status: 'Contacted', target_status: 'Open', direction: 'ZOHO_TO_EXTERNAL' },
  { source_status: 'Lost', target_status: 'Prospect Lost', direction: 'ZOHO_TO_EXTERNAL' },
  { source_status: 'Open', target_status: 'Not Contacted', direction: 'EXTERNAL_TO_ZOHO' },
];

const LEAD = {
  crm_record_id: 'ZL1', enquiry_id: 'ENQ-1', customer_name: 'Jane Citizen', mobile_number: '0412345678',
  email_address: 'jane@example.com', postcode: '7250', vehicle_model: 'MG4', nature_of_enquiry: 'Test Drive',
  lead_source: 'OEM AU Website', dealer_code: '725001', accept_privacy_policy: true, lead_status: 'Contacted',
  receive_marketing_updates: true, dealer_rejected_reason: '', customer_message: '',
};

const fusion = (lead, operation = 'CREATE_LEAD') =>
  buildOutboundPayload({ ...LEAD, ...lead }, FIELDS, STATUS_ROWS, { crmType: 'FUSION_SD', operation });

test('parseTriState reads true, false or unknown, and never guesses', () => {
  for (const value of [true, 'true', 'TRUE', 'yes', 'Y', 1, '1']) assert.equal(parseTriState(value), true, String(value));
  for (const value of [false, 'false', 'No', 'n', 0, '0']) assert.equal(parseTriState(value), false, String(value));
  for (const value of [null, undefined, '', ' ', 'maybe', 'unknown', {}, 2]) {
    assert.equal(parseTriState(value), undefined, String(value));
  }
});

test('Fusion: a consent is sent as true or false, and an unknown or unreadable one is left out', () => {
  assert.equal(fusion({ receive_marketing_updates: 'yes' })['contact.marketingOptinEmail'], true);
  assert.equal(fusion({ receive_marketing_updates: false })['contact.marketingOptinEmail'], false);
  for (const unknown of [null, undefined, '', 'maybe']) {
    assert.ok(!('contact.marketingOptinEmail' in fusion({ receive_marketing_updates: unknown })), String(unknown));
  }
  assert.equal(fusion({}).privacy, true);
});

test('Fusion create leaves out empty optional fields; an update still sends them', () => {
  const created = fusion({ customer_message: '', dealer_rejected_reason: '' });
  assert.ok(!('notes' in created));
  assert.ok(!('lostReason' in created));
  assert.equal(created['contact.firstName'], 'Jane Citizen', 'required fields are untouched');

  const updated = fusion({ customer_message: '' }, 'UPDATE_LEAD');
  assert.equal(updated.notes, '', 'clearing on update is Batch 10, unchanged here');
});

test('Fusion: a lost reason goes out only with a lost status, and only when it has a value', () => {
  const lost = fusion({ lead_status: 'Lost', dealer_rejected_reason: 'Bought Another Brand' });
  assert.equal(lost.enquiryStatus, 'Prospect Lost');
  assert.equal(lost.lostReason, 'Bought Another Brand');

  for (const operation of ['CREATE_LEAD', 'UPDATE_LEAD']) {
    assert.ok(!('lostReason' in fusion({ lead_status: 'Contacted', dealer_rejected_reason: 'Bought Another Brand' }, operation)), operation);
    assert.ok(!('lostReason' in fusion({ lead_status: 'Lost', dealer_rejected_reason: '  ' }, operation)), operation);
  }
});

test('other CRM types keep exactly today\'s payload', () => {
  const lead = { ...LEAD, receive_marketing_updates: 'maybe', dealer_rejected_reason: 'Bought Another Brand' };
  const today = buildOutboundPayload(lead, FIELDS, STATUS_ROWS);
  assert.equal(today['contact.marketingOptinEmail'], 'maybe');
  assert.equal(today.notes, '');
  for (const crmType of ['ZOHO_CRM', 'GENERIC_REST']) {
    for (const operation of ['CREATE_LEAD', 'UPDATE_LEAD']) {
      assert.deepEqual(buildOutboundPayload(lead, FIELDS, STATUS_ROWS, { crmType, operation }), today, `${crmType} ${operation}`);
    }
  }
});

test('a Fusion delivery applies the rules: an empty optional field is left out of the create', async (t) => {
  const harness = setupOutbound(t, { mapping: null, lead: { customer_message: '', receive_marketing_updates: 'maybe' } });
  harness.db.tables.integration_field_mappings.push(
    { integration_id: '1000', source_field: 'customer_message', target_field: 'notes', data_type: 'string', required: false },
    { integration_id: '1000', source_field: 'receive_marketing_updates', target_field: 'contact.marketingOptinEmail', data_type: 'boolean', required: false },
  );
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: fixtures.FUSION_TEST_LEAD_ID, httpStatus: 201, raw: {} }) });

  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.equal(calls.create.length, 1);
  assert.ok(!('notes' in calls.create[0]));
  assert.ok(!('contact.marketingOptinEmail' in calls.create[0]));
  assert.equal(calls.create[0]['contact.firstName'], 'Jane Citizen');
});

// --- 32 KB: Fusion refuses bodies over 32 KB; long text is trimmed, the lead still goes ---

function mockFusion(t) {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 600 } }));
  const sent = [];
  t.mock.method(axios, 'request', async (config) => {
    sent.push(config);
    return config.method === 'PATCH' ? fixtures.leadUpdatedResponse() : fixtures.leadAcceptedResponse();
  });
  return sent;
}

const INTEGRATION = {
  ROWID: '9001', dealer_code: '725001', crm_type: 'FUSION_SD',
  base_url: 'https://8.8.8.8/api/leadapi', create_lead_endpoint: '/v1/leads', http_method: 'POST',
};

test('a body over 32 KB has its longest text trimmed with a marker, and is still sent', async (t) => {
  const sent = mockFusion(t);
  const payload = {
    'contact.firstName': 'Jane', 'contact.phone': '0412345678',
    notes: 'n'.repeat(40000), 'contact.notes': 'short note',
  };

  await fusionSdAdapter.createLead({}, INTEGRATION, payload, { idempotencyKey: 'ZL1' });
  await fusionSdAdapter.updateLead({}, INTEGRATION, fixtures.FUSION_TEST_LEAD_ID, payload);

  assert.equal(sent.length, 2);
  for (const config of sent) {
    assert.ok(Buffer.byteLength(JSON.stringify(config.data)) <= 32000, `${config.method} body fits`);
    assert.match(config.data.notes, / \[truncated\]$/);
    assert.equal(config.data.contact.firstName, 'Jane');
    assert.equal(config.data.contact.notes, 'short note', 'only what is needed is trimmed');
  }
  assert.equal(payload.notes.length, 40000, 'the caller\'s payload is not modified');
});

test('a body within 32 KB is sent exactly as before', async (t) => {
  const sent = mockFusion(t);
  const payload = { 'contact.firstName': 'Jane', notes: 'n'.repeat(20000) };
  await fusionSdAdapter.createLead({}, INTEGRATION, payload, { idempotencyKey: 'ZL1' });
  assert.deepEqual(sent[0].data, fusionSdAdapter._test.nestDottedKeys(payload));
});

test('oversized structured messages are trimmed without changing contact, identifiers or caller data', async (t) => {
  const sent = mockFusion(t);
  const payload = {
    refID: 'MG-123', 'contact.firstName': 'Jane', 'contact.email': 'jane@example.invalid', enquiryStatus: 'Open',
    messages: [{ text: 'hello '.repeat(10000), external_id: 'message-123' }],
  };
  await fusionSdAdapter.createLead({}, INTEGRATION, payload);
  assert.ok(Buffer.byteLength(JSON.stringify(sent[0].data)) <= 32000);
  assert.equal(sent[0].data.contact.email, payload['contact.email']);
  assert.equal(sent[0].data.contact.firstName, 'Jane');
  assert.equal(sent[0].data.refID, 'MG-123');
  assert.equal(sent[0].data.enquiryStatus, 'Open');
  assert.equal(sent[0].data.messages[0].external_id, 'message-123');
  assert.match(sent[0].data.messages[0].text, / \[truncated\]$/);
  assert.equal(payload.messages[0].text.length, 60000, 'nested input is not mutated');
});

test('untrimmable oversized values fail before token acquisition or dealer request', async (t) => {
  const sent = mockFusion(t);
  const tokenRequest = axios.post.mock;
  await assert.rejects(() => fusionSdAdapter.createLead({}, INTEGRATION, {
    'contact.firstName': 'x'.repeat(40000), 'contact.email': 'jane@example.invalid',
  }), (err) => err.code === 'FIELD_MAPPING_INVALID' && /exceeds 32000 bytes/.test(err.message));
  assert.equal(tokenRequest.callCount(), 0);
  assert.equal(sent.length, 0);
});

test('UTF-8 and escaped note text fits the final JSON limit without splitting emoji', async (t) => {
  const sent = mockFusion(t);
  await fusionSdAdapter.updateLead({}, INTEGRATION, fixtures.FUSION_TEST_LEAD_ID, {
    notes: '😀"\\\n'.repeat(10000), 'contact.email': 'jane@example.invalid',
  });
  const body = sent[0].data;
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 32000);
  assert.match(body.notes, / \[truncated\]$/);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(body.notes));
  assert.equal(body.contact.email, 'jane@example.invalid');
});
