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

// Fusion's reworked webhook (Buckby, 28 Oct 2026): the status comes as
// enquiryStatus, and the id as leadId as well as lead_id. Before this was
// read, every live call was acknowledged as "no status" and MG never changed.
const REWORKED_BODY = {
  event_id: '8206852615287_f1xkkfm1', lead_id: fixtures.FUSION_TEST_LEAD_ID, dealer_id: '725001',
  dealer_name: 'Buckby Motors', enquiry_id: '0AK4E4nNuRsFRthSWJQb', pushed_at: '2026-10-28T00:29:44.838Z',
  update_url: 'https://app.fusionamspro.com/api/leadapi/v1/leads/x',
  enquiryStatus: 'Lost', lostReason: 'Bought-Another-Brand', lostSubReason: null, leadId: fixtures.FUSION_TEST_LEAD_ID,
};

test('translator: Fusion\'s enquiryStatus is read as the status; lostReason and the rest are ignored', () => {
  const { externalLeadId, record } = translateFusionWebhook(REWORKED_BODY, FIELD_PRESET);
  assert.equal(externalLeadId, fixtures.FUSION_TEST_LEAD_ID);
  assert.deepEqual(record, { enquiryStatus: 'Lost', modified_at: '2026-10-28T00:29:44.838Z' });
});

test('translator: status wins over enquiryStatus; leadId is used only without lead_id; blanks fall through', () => {
  assert.equal(translateFusionWebhook({ lead_id: 'l', status: 'Open', enquiryStatus: 'Lost' }, FIELD_PRESET).record.enquiryStatus, 'Open');
  assert.equal(translateFusionWebhook({ lead_id: 'l', status: ' ', enquiryStatus: 'Lost' }, FIELD_PRESET).record.enquiryStatus, 'Lost');
  assert.equal(translateFusionWebhook({ lead_id: 'l', enquiryStatus: null }, FIELD_PRESET).record.enquiryStatus, undefined);
  assert.equal(translateFusionWebhook({ leadId: 'lead_2', enquiryStatus: 'Open' }, FIELD_PRESET).externalLeadId, 'lead_2');
  assert.equal(translateFusionWebhook({ lead_id: 'lead_1', leadId: 'lead_2' }, FIELD_PRESET).externalLeadId, 'lead_1');
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
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Lost Lead' } }]);
  const lead = harness.db.tables.leads[0];
  assert.equal(lead.lead_status, 'Lost Lead');
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
  harness.db.tables.dealer_integrations[0].crm_type = 'GENERIC_REST';
  const integration = { ...harness.integration, crm_type: 'GENERIC_REST' };
  const result = await crmIntegrationService.processInboundWebhook(
    harness.db.app, integration, { id: fixtures.FUSION_TEST_LEAD_ID, enquiryStatus: 'Lost', leadSource: 'Walk In' }, oemCrmService
  );
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Lost Lead', Nature_of_enquiry: 'Walk In' });
});

test('flag on: Fusion\'s reworked body (enquiryStatus Lost) updates MG to Lost Lead', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  const result = await receive(harness, REWORKED_BODY);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, undefined);
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: {
    Lead_Status: 'Lost Lead', Reason_for_Lost: 'Bought Other Make',
    Reason_For_Loss_Other: 'Dealer (Fusion): Bought Another Brand', Lost_Date: '2026-10-28',
  } }]);
});

// 28 Oct 2026: keep a renamed status from being acknowledged unread again,
// and match Fusion's code-form statuses (the spec lists `prospectLost`).
test('flag on: Fusion\'s code form prospectLost maps like Prospect Lost (MG Not Qualified)', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  const result = await receive(harness, { ...REWORKED_BODY, enquiryStatus: 'prospectLost' });
  assert.equal(result.ok, true);
  assert.equal(result.held, undefined);
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Not Qualified' } }]);
});

test('flag on: a status under a name we do not read is logged as a mapping failure, without its value, and not written', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  const { enquiryStatus, ...rest } = REWORKED_BODY;
  const result = await receive(harness, { ...rest, enquiryStatus: null, enquiry_status: enquiryStatus });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'UNREAD_STATUS_FIELD');
  assert.equal(result.held, true, 'held, so the event is PENDING rather than SUCCESS');
  assert.deepEqual(result.fields, ['enquiry_status']);
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'HELD');
  assert.equal(harness.oemWrites.length, 0);
  const log = harness.logs().find((row) => row.error_message?.startsWith('UNREAD_STATUS_FIELD'));
  assert.ok(log, 'a FAILED log names the field');
  assert.equal(log.status, 'FAILED');
  assert.equal(log.error_message.includes('Lost'), false, 'the value is not logged');
});

test('flag on: null status-like fields (Fusion sends absent values as null) raise nothing', async (t) => {
  withFlag(t, 'true');
  const harness = withPresets(t);
  const result = await receive(harness, { ...REWORKED_BODY, enquiryStatus: null, testDriveStatus: null, lostReason: null });
  assert.equal(result.reason, 'NO_STATUS_IN_WEBHOOK');
  assert.equal(harness.logs().length, 0);
});

test('translator: a dealer whose status mapping names its own field is read from that field (per-dealer map)', () => {
  const mappings = FIELD_PRESET.map((m) => (m.source_field === 'lead_status' ? { ...m, target_field: 'dealerStage' } : m));
  const { record } = translateFusionWebhook({ lead_id: 'lead_1', dealerStage: 'Lost' }, mappings);
  assert.equal(record.dealerStage, 'Lost');
  // The standard names still win when present.
  assert.equal(translateFusionWebhook({ lead_id: 'lead_1', enquiryStatus: 'Open', dealerStage: 'Lost' }, mappings).record.dealerStage, 'Open');
});
