'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 5 (FUSION_REMEDIATION_PLAN.md): Fusion's flat PushedLead body
// (lead-api-mg-motors-openapi 3.yaml) is translated into the record the
// shared inbound path expects. Q16: only the status comes back to MG; every
// other webhook field is ignored. A null value means "unknown", never "clear".

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const oemCrmService = require('../services/zohoCrmService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { translateFusionWebhook } = require('../services/integrations/adapters/fusionSdInbound');

// A whole-lead PushedLead, as Fusion sends it when the dealer picks "the whole lead".
const WHOLE_LEAD = {
  lead_id: fixtures.FUSION_TEST_LEAD_ID, dealer_id: 'AU999', dealer_name: 'Buckby MG', enquiry_id: 'enq_1',
  pushed_at: '2026-10-13T10:00:00Z', update_url: 'https://app.fusionamspro.com/api/leadapi/v1/leads/x',
  status: 'Lost', pipeline: 'Sales', stage: 'Negotiation', enquiry_type: 'Internet', origin: 'Manufacturer Lead',
  lead_source: 'Walk In', campaign: null, first_name: 'Janet', last_name: 'Citizen', name: 'Janet Citizen',
  email: 'other@example.com', phone: '+61 412 345 678', postcode: '7000', make: 'MG', model: 'MG4',
  optin_email: false, optin_phone: null, owner_name: 'Sam Sales', notes: [{ text: 'called' }],
};

test('translator: lead_id is the external id, and only the status is kept, under the status mapping target', () => {
  const { externalLeadId, record, dealerId } = translateFusionWebhook(WHOLE_LEAD, FIELD_PRESET);
  assert.equal(externalLeadId, fixtures.FUSION_TEST_LEAD_ID);
  assert.equal(dealerId, 'AU999');
  assert.deepEqual(record, { enquiryStatus: 'Lost', modified_at: '2026-10-13T10:00:00Z' });
});

test('translator: a null, empty or missing status is left out (unknown, not a change)', () => {
  for (const status of [null, '', '   ', undefined]) {
    const { record } = translateFusionWebhook({ lead_id: 'lead_1', status }, FIELD_PRESET);
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'enquiryStatus'), false, String(status));
  }
});

test('translator: the status is trimmed; a non-string status is ignored', () => {
  assert.equal(translateFusionWebhook({ lead_id: 'l', status: '  Open ' }, FIELD_PRESET).record.enquiryStatus, 'Open');
  assert.equal(translateFusionWebhook({ lead_id: 'l', status: { name: 'Open' } }, FIELD_PRESET).record.enquiryStatus, undefined);
});

test('translator: a dealer whose status mapping uses another target still gets its status', () => {
  const custom = [{ source_field: 'lead_status', target_field: 'status' }];
  assert.deepEqual(translateFusionWebhook({ lead_id: 'l', status: 'Open' }, custom).record, { status: 'Open' });
  assert.deepEqual(translateFusionWebhook({ lead_id: 'l', status: 'Open' }, []).record, { enquiryStatus: 'Open' });
});

test('translator: a missing or blank lead_id gives no external id; a body that is not an object is safe', () => {
  assert.equal(translateFusionWebhook({ status: 'Open' }, FIELD_PRESET).externalLeadId, null);
  assert.equal(translateFusionWebhook({ lead_id: '  ', status: 'Open' }, FIELD_PRESET).externalLeadId, null);
  assert.equal(translateFusionWebhook(null, FIELD_PRESET).externalLeadId, null);
  assert.equal(translateFusionWebhook([], FIELD_PRESET).externalLeadId, null);
});

function withFlag(t, value) {
  const before = process.env.FUSION_INBOUND_V2;
  if (value === null) delete process.env.FUSION_INBOUND_V2;
  else process.env.FUSION_INBOUND_V2 = value;
  t.after(() => {
    if (before === undefined) delete process.env.FUSION_INBOUND_V2;
    else process.env.FUSION_INBOUND_V2 = before;
  });
}

function withPresets(t, { lead = {} } = {}) {
  const harness = setupOutbound(t, { lead: { nature_of_enquiry: 'Test Drive', postcode: '7250', ...lead } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  return harness;
}

const receive = (harness, payload) =>
  crmIntegrationService.processInboundWebhook(harness.db.app, harness.integration, payload, oemCrmService);

test('flag on: a whole-lead webhook writes only the status to MG; name, Nature of Enquiry, contact and consent are untouched (Q16)', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  const result = await receive(harness, WHOLE_LEAD);
  assert.equal(result.ok, true);
  assert.equal(result.scenarioCode, 'Happy 2');
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Lost' } }]);
  const lead = harness.db.tables.leads[0];
  assert.equal(lead.lead_status, 'Lost');
  assert.equal(lead.nature_of_enquiry, 'Test Drive');
  assert.equal(lead.email_address, 'jane@example.com');
  assert.equal(lead.postcode, '7250');
  assert.equal(harness.logs().some((log) => log.error_message === 'OWNERSHIP_CONFLICT'), false, 'no Unhappy 6 for phone/email echoes');
});

test('flag on: a webhook without a status (e.g. notes only) is acknowledged with no MG write, no log and no hold', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  const result = await receive(harness, { lead_id: fixtures.FUSION_TEST_LEAD_ID, status: null, notes: [{ text: 'x' }] });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(result.held, undefined);
  assert.equal(harness.oemWrites.length, 0);
  assert.equal(harness.logs().length, 0);
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'SYNCED');
});

test('flag on: a webhook without lead_id is refused as FIELD_MAPPING_INVALID, as today', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  await assert.rejects(receive(harness, { status: 'Lost' }), { code: 'FIELD_MAPPING_INVALID' });
});

test('flag on: an unknown lead_id (a dealer-created lead) is held as Unhappy 7, as today (Q17)', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  await assert.rejects(receive(harness, { lead_id: 'lead_DEALER_OWN', status: 'Open' }), { code: 'LEAD_MAPPING_NOT_FOUND' });
  assert.equal(harness.logs()[0].happy_unhappy_path_name, 'Unhappy 7');
});

test('flag off: a flat Fusion body is not translated (lead_id is not read), exactly as today', async (t) => {
  withFlag(t, null);
  const harness = withPresets(t);
  await assert.rejects(receive(harness, { lead_id: fixtures.FUSION_TEST_LEAD_ID, status: 'Lost' }), { code: 'FIELD_MAPPING_INVALID' });
  assert.equal(harness.oemWrites.length, 0);
});

test('flag on: a GENERIC_REST dealer\'s body is processed exactly as before', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  const integration = { ...harness.integration, crm_type: 'GENERIC_REST' };
  const result = await crmIntegrationService.processInboundWebhook(
    harness.db.app, integration, { id: fixtures.FUSION_TEST_LEAD_ID, enquiryStatus: 'Lost', leadSource: 'Walk In' }, oemCrmService
  );
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Lost', Nature_of_enquiry: 'Walk In' });
});
