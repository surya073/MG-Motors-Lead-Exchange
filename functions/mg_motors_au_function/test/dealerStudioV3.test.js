'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Dealer Studio API mapping update (2 Nov 2026): outbound payload (category,
// provider, consent, transcript, nested targets) and webhook schema v3
// (appointments, test_drives, lost reason, provider).

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const leadMappingService = require('../services/integrations/leadMappingService');
const dealerStudioAdapter = require('../services/integrations/adapters/dealerStudioAdapter');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const oemCrmService = require('../services/zohoCrmService');
const { nestDottedKeys } = require('../services/integrations/adapters/nestDottedKeys');
const {
  resolveCategory, formatChatTranscript, applyDealerStudioPayloadRules, PROVIDER_NAME, SOURCE_NAME,
} = require('../services/integrations/adapters/dealerStudioPayload');
const {
  translateDealerStudioWebhook, mayApplyTestDriveOutcome,
} = require('../services/integrations/adapters/dealerStudioInbound');
const { FIELD_PRESET, INBOUND_STATUS_PRESET } = require('../services/integrations/adapters/dealerStudioMappings');
const { setupOutbound, LEAD } = require('./helpers/outboundHarness');

// ------------------------------------------------------------------ fixtures

const MAPPINGS = FIELD_PRESET.map(({ note, ...row }) => ({ integration_id: '1000', ...row }));

const SALES_LEAD = {
  crm_record_id: 'ZL1', enquiry_id: 'ENQ-1', first_name: 'Jane', last_name: 'Citizen', customer_name: 'Jane Citizen',
  mobile_number: '0412345678', email_address: 'jane@example.com', postcode: '3000', dealer_code: 'AU999',
  customer_message: 'Can I book a drive?', nature_of_enquiry: 'Test Drive', lead_department: 'Sales',
  accept_privacy_policy: true, receive_marketing_updates: true, enquiry_model: 'MG ZS', enquiry_variant: 'Essence',
  enquiry_powertrain: 'Hybrid', lead_status: 'Not Contacted', lead_source: 'Website',
  chat_transcript: 'Bot: Hello\nCustomer: I want a test drive',
};

const build = (lead = {}, { operation = 'CREATE_LEAD', mappings = MAPPINGS } = {}) =>
  crmIntegrationService._test.buildOutboundPayload({ ...SALES_LEAD, ...lead }, mappings, [], { crmType: 'DEALER_STUDIO', operation });

// -------------------------------------------------- 1. department -> category

test('category: every department and nature maps to the exact, case-sensitive Dealer Studio value', () => {
  const cases = [
    ['Sales', 'Test Drive', 'Test Drive Booking'],
    ['Sales', 'Product Enquiry', 'New Vehicle Enquiry'],
    ['Sales', 'Finance Enquiry', 'Finance Enquiry'],
    ['Service', '', 'Service Enquiry'],
    ['Parts', undefined, 'Parts Enquiry'],
    ['Customer Care', 'Test Drive', 'General Enquiry'],
    ['Marketing', null, 'General Enquiry'],
    ['Aftersales', '', 'General Enquiry'],
    ['General', '', 'General Enquiry'],
  ];
  cases.forEach(([department, nature, expected]) => {
    assert.equal(resolveCategory(department, nature), expected, `${department} + ${nature}`);
  });
});

test('category: input is matched ignoring case and spacing, but the output is always the exact value', () => {
  assert.equal(resolveCategory('  SALES ', 'test  drive'), 'Test Drive Booking');
  assert.equal(resolveCategory('service', ''), 'Service Enquiry');
});

test('category: an unknown department, a missing department or an unknown Sales nature is FIELD_MAPPING_INVALID', () => {
  for (const [department, nature] of [['Finance', ''], ['', 'Test Drive'], [undefined, undefined], ['Sales', 'Fleet'], ['Sales', '']]) {
    assert.throws(() => resolveCategory(department, nature), (err) => err.code === 'FIELD_MAPPING_INVALID', `${department}/${nature}`);
  }
});

test('category is sent in place of the raw Nature of Enquiry, and the department is kept in fields.lead_department', () => {
  const body = nestDottedKeys(build({ lead_department: 'Service', nature_of_enquiry: 'Test Drive' }));
  assert.equal(body.category, 'Service Enquiry');
  assert.equal(body.fields.lead_department, 'Service');
});

// ------------------------------------------- 2. required / optional fields

test('a full lead builds the confirmed Dealer Studio body, with nested targets', () => {
  const body = nestDottedKeys(build());
  assert.deepEqual(body, {
    first_name: 'Jane',
    last_name: 'Citizen',
    email: 'jane@example.com',
    mobile: '0412345678',
    message: 'Can I book a drive?',
    category: 'Test Drive Booking',
    address_attributes: { postcode: '3000' },
    opt_in: true,
    fields: {
      privacy_policy_accepted: true,
      lead_department: 'Sales',
      model: 'MG ZS',
      vehicle_badge: 'Essence',
      powertrain: 'Hybrid',
    },
    chat_transcript: [{ message: 'Hello', type: 'bot' }, { message: 'I want a test drive', type: 'user' }],
    provider_id: 'ENQ-1',
    dealer_code: 'AU999',
    provider: 'MG Leads Exchange',
    source: 'Manufacturer',
  });
});

test('lead_state and subsource are never sent, even when a mapping or the lead carries them', () => {
  const mappings = [...MAPPINGS, { source_field: 'lead_origin', target_field: 'subsource', data_type: 'string', required: false },
    { source_field: 'lead_source', target_field: 'lead_state', data_type: 'string', required: false }];
  for (const operation of ['CREATE_LEAD', 'UPDATE_LEAD']) {
    const payload = build({}, { operation, mappings });
    assert.equal(Object.hasOwn(payload, 'lead_state'), false);
    assert.equal(Object.hasOwn(payload, 'subsource'), false);
    assert.equal(Object.hasOwn(payload, 'status'), false, 'the status is dealer-managed');
  }
});

test('missing optional fields are left out, not sent empty', () => {
  const payload = build({
    customer_message: '', enquiry_model: '', enquiry_variant: undefined, enquiry_powertrain: null, chat_transcript: '', last_name: undefined,
  });
  ['message', 'fields.model', 'fields.vehicle_badge', 'fields.powertrain', 'chat_transcript', 'last_name'].forEach((key) => {
    assert.equal(Object.hasOwn(payload, key), false, key);
  });
  assert.equal(payload.email, 'jane@example.com');
  assert.equal(payload.category, 'Test Drive Booking');
});

test('Make and Chat URL have no MG source yet: they are omitted rather than invented', () => {
  const payload = build();
  assert.equal(Object.hasOwn(payload, 'fields.make'), false);
  assert.equal(Object.hasOwn(payload, 'fields.chat_url'), false);
  const withValues = build({ vehicle_make: 'MG', chat_url: 'https://chat.example.com/c/1' });
  assert.equal(withValues['fields.make'], 'MG');
  assert.equal(withValues['fields.chat_url'], 'https://chat.example.com/c/1');
});

test('a missing required value still fails the existing validation', () => {
  assert.throws(() => build({ email_address: '' }), (err) => err.code === 'FIELD_MAPPING_INVALID');
  assert.throws(() => build({ postcode: '' }), (err) => err.code === 'FIELD_MAPPING_INVALID');
});

test('the default map satisfies the mandatory-mapping check for Dealer Studio only', () => {
  const sources = FIELD_PRESET.map((row) => row.source_field);
  assert.deepEqual(leadMappingService.missingDeliveryMappingFields(sources, 'DEALER_STUDIO'), []);
  assert.ok(leadMappingService.missingDeliveryMappingFields(sources, 'GENERIC_REST').length > 0);
  assert.ok(leadMappingService.missingDeliveryMappingFields(sources, 'FUSION_SD').length > 0);
});

test('no two default mappings share a target (the save route refuses duplicates) and none is unsafe', () => {
  const targets = FIELD_PRESET.map((row) => row.target_field.toLowerCase());
  assert.equal(new Set(targets).size, targets.length);
  assert.equal(leadMappingService.findTargetFieldProblem(FIELD_PRESET.map((row) => row.target_field), { nested: true }), null);
});

// ------------------------------------------------------- 3. consent booleans

test('marketing opt-in and privacy acceptance go out as real booleans', () => {
  for (const [input, expected] of [[true, true], [false, false], ['true', true], ['false', false], ['Yes', true], ['0', false]]) {
    const body = nestDottedKeys(build({ receive_marketing_updates: input, accept_privacy_policy: input }));
    assert.strictEqual(body.opt_in, expected, `opt_in ${input}`);
    assert.strictEqual(body.fields.privacy_policy_accepted, expected, `privacy ${input}`);
  }
});

test('an unreadable consent value is left out, never guessed as false', () => {
  const payload = build({ receive_marketing_updates: 'maybe', accept_privacy_policy: 'unknown' });
  assert.equal(Object.hasOwn(payload, 'opt_in'), false);
  assert.equal(Object.hasOwn(payload, 'fields.privacy_policy_accepted'), false);
});

// -------------------------------------------------- 4. provider / provider id

test('provider and source are fixed, and the MG Enquiry ID is sent as provider_id', () => {
  const payload = build({ provider: 'someone else', source: 'Website' });
  assert.equal(payload.provider, PROVIDER_NAME);
  assert.equal(payload.provider, 'MG Leads Exchange');
  assert.equal(payload.source, SOURCE_NAME);
  assert.equal(payload.source, 'Manufacturer');
  assert.equal(payload.provider_id, 'ENQ-1');
});

test('provider_id falls back to the CRM record id when the enquiry id is missing, and is always a string', () => {
  assert.equal(build({ enquiry_id: '', crm_record_id: '99' }).provider_id, '99');
  assert.equal(build({ enquiry_id: 12345 }).provider_id, '12345');
});

// ------------------------------------------------------ 5. chat transcript

test('chat transcript: speaker lines become { message, type } entries', () => {
  assert.deepEqual(formatChatTranscript('Bot: Hi, how can I help?\nCustomer: A test drive\nplease\nBot: Sure'), [
    { message: 'Hi, how can I help?', type: 'bot' },
    { message: 'A test drive\nplease', type: 'user' },
    { message: 'Sure', type: 'bot' },
  ]);
  assert.deepEqual(formatChatTranscript('User: hello\r\nAssistant: hi'), [
    { message: 'hello', type: 'user' }, { message: 'hi', type: 'bot' },
  ]);
});

test('chat transcript: an array or a JSON array is normalised, unknown speakers dropped', () => {
  const entries = [{ text: 'a', role: 'bot' }, { message: 'b', type: 'USER' }, { message: 'c', type: 'agent' }, null, 'x', { type: 'bot' }];
  const expected = [{ message: 'a', type: 'bot' }, { message: 'b', type: 'user' }];
  assert.deepEqual(formatChatTranscript(entries), expected);
  assert.deepEqual(formatChatTranscript(JSON.stringify(entries)), expected);
});

test('chat transcript: text with no recognised speaker, blanks and junk give nothing (never guessed)', () => {
  for (const raw of ['just some words', '', '   ', null, undefined, 42, {}, '[not json', 'Manager: hello']) {
    assert.deepEqual(formatChatTranscript(raw), [], String(raw));
  }
});

test('chat transcript: a very long chat keeps the latest entries and stays within the size budget', () => {
  const raw = Array.from({ length: 400 }, (_, i) => `${i % 2 ? 'Bot' : 'Customer'}: ${'x'.repeat(200)} ${i}`).join('\n');
  const entries = formatChatTranscript(raw);
  assert.ok(entries.length > 0 && entries.length <= 200);
  assert.ok(Buffer.byteLength(JSON.stringify(entries)) <= 20000);
  assert.ok(entries[entries.length - 1].message.endsWith('399'));
});

// ---------------------------------------------------------- the adapter body

test('createLead sends the nested lead body to /api/v1/leads', async (t) => {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'ds-key');
  const calls = [];
  t.mock.method(axios, 'request', async (config) => {
    calls.push(config);
    return { status: 201, data: { id: 100001, lead_cluster_id: 200001 }, headers: {} };
  });
  const integration = { ROWID: '2001', dealer_code: 'AU999', crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads' };

  const result = await dealerStudioAdapter.createLead({}, integration, build());

  const sent = JSON.parse(calls[0].data);
  assert.equal(sent.lead.address_attributes.postcode, '3000');
  assert.equal(sent.lead.fields.vehicle_badge, 'Essence');
  assert.equal(sent.lead.category, 'Test Drive Booking');
  assert.equal(Object.hasOwn(sent.lead, 'lead_state'), false);
  assert.equal(Object.hasOwn(sent.lead, 'subsource'), false);
  assert.equal(result.externalLeadId, '100001');
});

test('rules do not modify the payload they are given', () => {
  const flat = { category: 'Test Drive', 'fields.lead_department': 'Sales' };
  const frozen = Object.freeze({ ...flat });
  const out = applyDealerStudioPayloadRules(frozen, SALES_LEAD, MAPPINGS);
  assert.deepEqual(frozen, flat);
  assert.notEqual(out, frozen);
});

// ------------------------------------- 6. webhook v3: translator

const V3 = {
  id: 200001,
  status: 'Test Drive Booked',
  status_type: 'Working',
  updated_at: '2026-11-02T01:00:00Z',
  leads: [{ id: 100001 }],
  provider: { name: 'MG Leads Exchange', provider_id: 'ENQ-1' },
  appointments: [{ purpose: 'Test Drive', status: 'Booked', starts_at: '2026-11-05T23:00:00Z' }],
  test_drives: [{ status: 'Completed', checked_out_at: '2026-11-05T23:05:00Z', checked_in_at: '2026-11-05T23:35:00Z' }],
};

test('v3: appointments, test drives, status type and provider are all read', () => {
  const out = translateDealerStudioWebhook(V3, [{ source_field: 'lead_status', target_field: 'status' }]);
  assert.deepEqual(out.appointments, [{ purpose: 'Test Drive', status: 'Booked', startsAt: '2026-11-05T23:00:00Z' }]);
  assert.deepEqual(out.testDrives, [{ status: 'Completed', checkedOutAt: '2026-11-05T23:05:00Z', checkedInAt: '2026-11-05T23:35:00Z' }]);
  assert.equal(out.statusType, 'working');
  assert.deepEqual(out.provider, { name: 'MG Leads Exchange', providerId: 'ENQ-1' });
  assert.equal(out.outcome, 'Test Drive');
  assert.deepEqual(out.record, { status: 'working', modified_at: '2026-11-02T01:00:00Z', enquiry_outcome: 'Test Drive' });
});

test('v3: every status type is read case-insensitively', () => {
  ['New', 'Working', 'Converted', 'Delivered', 'Lost', 'Invalid'].forEach((type) => {
    assert.equal(translateDealerStudioWebhook({ id: 1, status_type: type }).record.status, type.toLowerCase());
  });
});

test('v3: only a Completed test drive is an outcome; booked, in-progress or cancelled ones are not', () => {
  for (const status of ['Booked', 'In Progress', 'Cancelled', 'No Show', '', undefined]) {
    const out = translateDealerStudioWebhook({ id: 1, test_drives: [{ status }] });
    assert.equal(out.outcome, null, String(status));
    assert.equal(out.hasUpdate, false);
  }
  assert.equal(translateDealerStudioWebhook({ id: 1, test_drives: [{ status: 'completed' }] }).outcome, 'Test Drive');
  assert.equal(translateDealerStudioWebhook({ id: 1, test_drives: [{ status: 'Booked' }, { status: 'Completed' }] }).outcome, 'Test Drive');
});

test('v3: the outcome key follows the dealer mapping for enquiry_outcome', () => {
  const out = translateDealerStudioWebhook({ id: 1, test_drives: [{ status: 'Completed' }] }, [{ source_field: 'enquiry_outcome', target_field: 'outcome' }]);
  assert.deepEqual(out.record, { outcome: 'Test Drive' });
});

test('v3: lost_reason and lost_reason_comment map to the MG reason, with the dealer wording kept', () => {
  const bought = translateDealerStudioWebhook({ id: 1, status_type: 'lost', lost_reason: 'bought_elsewhere', lost_reason_comment: 'Went to a Kia dealer', updated_at: '2026-11-02T01:00:00Z' });
  assert.deepEqual(bought.lost, {
    reason: 'Bought elsewhere', subReason: 'Went to a Kia dealer', at: '2026-11-02T01:00:00Z',
    mgReason: 'Bought Elsewhere', dealerLabel: 'Dealer Studio', verbatim: true,
  });
  const finance = translateDealerStudioWebhook({ id: 1, status_type: 'lost', lost_reason: 'failed_on_finance' });
  assert.equal(finance.lost.mgReason, 'Other');
  assert.equal(finance.lost.reason, "Couldn't get finance");
  const unknown = translateDealerStudioWebhook({ id: 1, status_type: 'lost', lost_reason: 'new_reason_code' });
  assert.equal(unknown.lost.mgReason, 'Other');
  assert.equal(unknown.lost.reason, 'new reason code');
  assert.equal(translateDealerStudioWebhook({ id: 1, status_type: 'lost' }).lost, null);
  assert.equal(translateDealerStudioWebhook({ id: 1, status_type: 'lost', lost_reason_comment: 'x' }).lost.mgReason, 'Other');
});

test('v3: malformed lists and objects are skipped without throwing', () => {
  const bodies = [
    { id: 1, appointments: 'nope', test_drives: 7, provider: 'x', leads: 'y' },
    { id: 1, appointments: [null, 1, 'a', [], {}], test_drives: [null, {}, { status: 5 }], provider: [] },
    { id: 1, provider: {}, lost_reason: { a: 1 }, status_type: { x: 1 } },
    { id: 1, appointments: Array.from({ length: 500 }, () => ({ purpose: 'x' })) },
  ];
  bodies.forEach((body) => {
    const out = translateDealerStudioWebhook(body, []);
    assert.equal(out.outcome, null);
    assert.equal(out.provider, null);
    assert.ok(out.appointments.length <= 50);
  });
  assert.equal(translateDealerStudioWebhook({ id: 1, status_type: { x: 1 } }).hasStatus, false);
});

test('outcome guard: a Completed test drive never replaces an outcome the lead has moved past', () => {
  for (const open of ['', undefined, null, '-None-', 'Outcome Pending', 'No Outcome', 'Test Drive']) {
    assert.equal(mayApplyTestDriveOutcome(open), true, String(open));
  }
  for (const closed of ['Retail Order', 'Fleet Order', 'On-Sold Demo', 'Lost']) {
    assert.equal(mayApplyTestDriveOutcome(closed), false, closed);
  }
});

// ------------------------------------------- 7/8. webhook v3: end to end

const DS_LEAD_ID = '100001';

function harnessFor(t, { lead = {} } = {}) {
  const harness = setupOutbound(t, {
    integration: { crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads', inbound_enabled: true, webhook_enabled: true },
    mapping: { external_crm_lead_id: DS_LEAD_ID },
    lead: { lead_status: 'Not Contacted', ...lead },
  });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...MAPPINGS);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...INBOUND_STATUS_PRESET.map(({ dealer_status, mg_status }) => ({
    integration_id: '1000', source_status: dealer_status, target_status: mg_status, direction: 'EXTERNAL_TO_ZOHO',
  })));
  harness.db.tables.notifications = [];
  return harness;
}

const receive = (harness, payload) =>
  crmIntegrationService.processInboundWebhook(harness.db.app, harness.integration, payload, oemCrmService);

test('a Completed test drive sets MG Enquiry Outcome to Test Drive (with the status in the same post)', async (t) => {
  const harness = harnessFor(t);
  const result = await receive(harness, V3);
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Contacted', Enquiry_Outcome: 'Test Drive' } }]);
  assert.equal(harness.db.tables.leads[0].enquiry_outcome, 'Test Drive');
  assert.equal(harness.db.tables.leads[0].lead_status, 'Contacted');
});

test('a Completed test drive on its own (no status in the post) still sets the outcome', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, { id: 200001, leads: [{ id: DS_LEAD_ID }], test_drives: [{ status: 'Completed' }] });
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Enquiry_Outcome: 'Test Drive' } }]);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Not Contacted');
});

test('the same Completed test drive posted again changes nothing', async (t) => {
  const harness = harnessFor(t, { lead: { enquiry_outcome: 'Test Drive' } });
  const result = await receive(harness, { id: 200001, leads: [{ id: DS_LEAD_ID }], test_drives: [{ status: 'Completed' }] });
  assert.equal(result.skipped, true);
  assert.deepEqual(harness.oemWrites, []);
});

test('a re-posted Completed test drive does not move a Retail Order back to Test Drive', async (t) => {
  const harness = harnessFor(t, { lead: { enquiry_outcome: 'Retail Order' } });
  const result = await receive(harness, { id: 200001, leads: [{ id: DS_LEAD_ID }], test_drives: [{ status: 'Completed' }] });
  assert.deepEqual(result, { skipped: true, reason: 'OUTCOME_NOT_MOVED_BACKWARDS' });
  assert.deepEqual(harness.oemWrites, []);
  assert.equal(harness.db.tables.leads[0].enquiry_outcome, 'Retail Order');
});

test('booked appointments and in-progress test drives are acknowledged and change nothing', async (t) => {
  const harness = harnessFor(t);
  const result = await receive(harness, {
    id: 200001, leads: [{ id: DS_LEAD_ID }],
    appointments: [{ purpose: 'Test Drive', status: 'Booked', starts_at: '2026-11-05T23:00:00Z' }],
    test_drives: [{ status: 'In Progress', checked_out_at: '2026-11-05T23:05:00Z' }],
  });
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'NO_STATUS_IN_WEBHOOK' });
  assert.deepEqual(harness.oemWrites, []);
});

test('status mapping: new, working, lost and invalid reach MG; converted and delivered are held for an MG decision', async (t) => {
  const expectations = { new: 'Not Contacted', working: 'Contacted', lost: 'Lost Lead', invalid: 'Not Qualified' };
  for (const [type, mg] of Object.entries(expectations)) {
    const harness = harnessFor(t, { lead: { lead_status: type === 'new' ? 'Contacted' : 'Not Contacted' } });
    await receive(harness, { id: 200001, status_type: type, leads: [{ id: DS_LEAD_ID }] });
    assert.equal(harness.db.tables.leads[0].lead_status, mg, type);
  }
  for (const type of ['converted', 'delivered']) {
    const harness = harnessFor(t);
    const result = await receive(harness, { id: 200001, status_type: type, leads: [{ id: DS_LEAD_ID }] });
    assert.equal(result.held, true, type);
    assert.equal(result.reason, 'STATUS_MAPPING_NOT_FOUND');
    assert.deepEqual(harness.oemWrites, []);
  }
});

test('a Lost post writes the mapped Reason_for_Lost, Dealer Studio wording and the lost date', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, { id: 200001, status_type: 'lost', lost_reason: 'bought_elsewhere', lost_reason_comment: 'Went to a Kia dealer - cheaper', updated_at: '2026-11-02T01:00:00Z', leads: [{ id: DS_LEAD_ID }] });
  const [write] = harness.oemWrites;
  assert.equal(write.fields.Lead_Status, 'Lost Lead');
  assert.equal(write.fields.Reason_for_Lost, 'Bought Elsewhere');
  assert.equal(write.fields.Reason_For_Loss_Other, 'Dealer (Dealer Studio): Bought elsewhere / Went to a Kia dealer - cheaper');
  assert.equal(write.fields.Lost_Date, '2026-11-02');
});

test('an unlisted lost reason is recorded as Other with the dealer wording', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, { id: 200001, status_type: 'lost', lost_reason: 'too_expensive', leads: [{ id: DS_LEAD_ID }] });
  const [write] = harness.oemWrites;
  assert.equal(write.fields.Reason_for_Lost, 'Other');
  assert.equal(write.fields.Reason_For_Loss_Other, 'Dealer (Dealer Studio): Car too expensive');
});

test('a lost reason on a post that is not Lost is not applied', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, { id: 200001, status_type: 'working', lost_reason: 'bought_elsewhere', leads: [{ id: DS_LEAD_ID }] });
  assert.equal(Object.hasOwn(harness.oemWrites[0].fields, 'Reason_for_Lost'), false);
});

// ---------------------------------------------------- 4. provider reconciliation

test('provider reconciliation: unknown lead ids are matched through provider_id (the MG Enquiry ID)', async (t) => {
  const harness = harnessFor(t);
  await receive(harness, { id: 424242, status_type: 'working', leads: [{ id: 888888 }], provider: { name: 'MG Leads Exchange', provider_id: 'ENQ-1' } });
  assert.deepEqual(harness.oemWrites.map((w) => w.zohoLeadId), ['ZL1']);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Contacted');
});

test('provider reconciliation: another provider, or an unknown enquiry id, is not matched', async (t) => {
  for (const provider of [{ name: 'Some Other Provider', provider_id: 'ENQ-1' }, { name: 'MG Leads Exchange', provider_id: 'ENQ-404' }]) {
    const harness = harnessFor(t);
    await assert.rejects(
      () => receive(harness, { id: 424242, status_type: 'working', leads: [{ id: 888888 }], provider }),
      (err) => err.code === 'LEAD_MAPPING_NOT_FOUND'
    );
    assert.deepEqual(harness.oemWrites, []);
  }
});

test('provider reconciliation: lead ids still win over provider_id', async (t) => {
  const harness = harnessFor(t);
  harness.db.tables.lead_integrations.push({ integration_id: '1000', zoho_lead_id: 'ZL2', dealer_code: 'AU999', external_crm_lead_id: '100002', sync_status: 'SYNCED' });
  harness.db.tables.leads.push({ ...LEAD, crm_record_id: 'ZL2', enquiry_id: 'ENQ-2', sync_status: 'SYNCED' });
  await receive(harness, { id: 200001, status_type: 'working', leads: [{ id: '100002' }], provider: { name: 'MG Leads Exchange', provider_id: 'ENQ-1' } });
  assert.deepEqual(harness.oemWrites.map((w) => w.zohoLeadId), ['ZL2']);
});

// --------------------------------------------------------------- 10. regression

test('other CRM types are untouched by the Dealer Studio rules', () => {
  const genericMappings = [
    { source_field: 'nature_of_enquiry', target_field: 'category', data_type: 'string', required: true },
    { source_field: 'email_address', target_field: 'email', data_type: 'string', required: true },
    { source_field: 'lead_status', target_field: 'status', data_type: 'string', required: true },
  ];
  const statusMappings = [{ source_status: 'Not Contacted', target_status: 'New', direction: 'ZOHO_TO_EXTERNAL' }];
  for (const crmType of ['GENERIC_REST', 'ZOHO_CRM']) {
    const payload = crmIntegrationService._test.buildOutboundPayload({ ...SALES_LEAD }, genericMappings, statusMappings, { crmType, operation: 'CREATE_LEAD' });
    assert.deepEqual(payload, { category: 'Test Drive', email: 'jane@example.com', status: 'New' }, crmType);
  }
});

test('other CRM types still send their status; only Dealer Studio treats every status as MG-only', () => {
  const pathPolicy = require('../services/integrations/pathPolicyService');
  assert.equal(pathPolicy.isMgOnlyStatusFor('Contacted', 'DEALER_STUDIO'), true);
  assert.equal(pathPolicy.isMgOnlyStatusFor('Contacted', 'GENERIC_REST'), false);
  assert.equal(pathPolicy.isMgOnlyStatusFor('Contacted', 'FUSION_SD'), false);
  assert.equal(pathPolicy.isMgOnlyStatusFor('Update Pending', 'GENERIC_REST'), true);
});

test('nestDottedKeys: the shared helper keeps Fusion behaviour and refuses unsafe paths', () => {
  assert.deepEqual(nestDottedKeys({ a: 1, 'b.c': 2, 'b.d': 3 }), { a: 1, b: { c: 2, d: 3 } });
  assert.deepEqual(nestDottedKeys({ 'x.__proto__.y': 1, 'constructor.prototype.z': 2 }), {});
  assert.equal(({}).y, undefined);
});

// ------------------------------------------------ the UI preset mirrors the backend

test('the admin UI default map mirrors dealerStudioMappings.js (the two deployables share no code)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const jsx = fs.readFileSync(path.join(__dirname, '../../../mg-motor-web/src/pages/Dealers/DealerCRMConfig.jsx'), 'utf8');
  const block = (name) => jsx.slice(jsx.indexOf(`const ${name} = [`), jsx.indexOf('];', jsx.indexOf(`const ${name} = [`)));
  const fields = block('DEALER_STUDIO_DEFAULT_FIELD_MAPPINGS');
  const uiFields = [...fields.matchAll(/source_field: "([^"]+)", target_field: "([^"]+)", data_type: "([^"]+)", required: (true|false)/g)]
    .map(([, source_field, target_field, data_type, required]) => ({ source_field, target_field, data_type, required: required === 'true' }));
  assert.deepEqual(uiFields, FIELD_PRESET.map(({ source_field, target_field, data_type, required }) => ({ source_field, target_field, data_type, required })));

  const statuses = block('DEALER_STUDIO_DEFAULT_STATUS_MAPPINGS');
  const uiStatuses = [...statuses.matchAll(/source_status: "([^"]+)", target_status: "([^"]+)", inbound_only: true/g)]
    .map(([, mg_status, dealer_status]) => ({ dealer_status, mg_status }));
  assert.deepEqual(uiStatuses, INBOUND_STATUS_PRESET.map(({ dealer_status, mg_status }) => ({ dealer_status, mg_status })));
});
