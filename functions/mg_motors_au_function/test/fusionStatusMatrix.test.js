'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// 28 Oct 2026: every status form Fusion can send, through the inbound path,
// with the map now live for Buckby, Tynan, Hillcrest and Indooroopilly (the
// Fusion preset: 14 field rows, 16 status rows).

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const oemCrmService = require('../services/zohoCrmService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

function withFlag(t) {
  const before = process.env.FUSION_INBOUND_V2;
  process.env.FUSION_INBOUND_V2 = 'true';
  t.after(() => { if (before === undefined) delete process.env.FUSION_INBOUND_V2; else process.env.FUSION_INBOUND_V2 = before; });
}

function harnessAt(t, mgStatus) {
  withFlag(t);
  const harness = setupOutbound(t, { lead: { lead_status: mgStatus } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  return harness;
}

// Fusion's reworked body (28 Oct 2026).
const body = (enquiryStatus, extra = {}) => ({
  event_id: 'e1', lead_id: fixtures.FUSION_TEST_LEAD_ID, dealer_id: '725001', dealer_name: 'Buckby Motors',
  enquiry_id: 'enq', pushed_at: '2026-10-28T00:29:44.838Z', update_url: 'https://app.fusionamspro.com/x',
  enquiryStatus, lostReason: null, lostSubReason: null, leadId: fixtures.FUSION_TEST_LEAD_ID, ...extra,
});

const receive = (harness, payload) =>
  crmIntegrationService.processInboundWebhook(harness.db.app, harness.integration, payload, oemCrmService);

const APPLIED = [
  ['Not Contacted', 'Lost', 'Lost Lead'],
  ['Not Contacted', 'lost', 'Lost Lead'],
  ['Not Contacted', ' LOST ', 'Lost Lead'],
  ['Contacted', 'Lost', 'Lost Lead'],
  ['Not Contacted', 'Prospect Lost', 'Not Qualified'],
  ['Not Contacted', 'prospectLost', 'Not Qualified'],
  ['Not Contacted', 'prospect-lost', 'Not Qualified'],
  ['Follow-up 1', 'Prospect Lost', 'Not Qualified'],
];
for (const [mg, fusion, expected] of APPLIED) {
  test(`MG ${mg} + Fusion "${fusion}" → MG ${expected}`, async (t) => {
    const harness = harnessAt(t, mg);
    const result = await receive(harness, body(fusion, fusion.trim().toLowerCase() === 'lost' ? { lostReason: 'Bought-Another-Brand' } : {}));
    assert.equal(result.ok, true);
    assert.equal(result.held, undefined);
    const lost = expected === 'Lost Lead'
      ? { Reason_for_Lost: 'Bought Other Make', Reason_For_Loss_Other: 'Dealer (Fusion): Bought Another Brand', Lost_Date: '2026-10-28' }
      : {};
    assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: expected, ...lost } }]);
    assert.equal(harness.db.tables.leads[0].lead_status, expected);
  });
}

const KEPT = [
  ['Not Contacted', 'Open', 'FUSION_STATUS_KEPT_MG_STATUS'],
  ['Contacted', 'open', 'FUSION_STATUS_KEPT_MG_STATUS'],
  ['Follow-up 2', 'Open', 'FUSION_STATUS_KEPT_MG_STATUS'],
  ['Not Contacted', 'Won', 'FUSION_STATUS_NOT_APPLIED'],
  ['Not Contacted', 'won', 'FUSION_STATUS_NOT_APPLIED'],
  ['Contacted', 'Delivered', 'FUSION_STATUS_NOT_APPLIED'],
];
for (const [mg, fusion, reason] of KEPT) {
  test(`MG ${mg} + Fusion "${fusion}" → MG unchanged (${reason})`, async (t) => {
    const harness = harnessAt(t, mg);
    const result = await receive(harness, body(fusion));
    assert.equal(result.skipped, true);
    assert.equal(result.reason, reason);
    assert.equal(harness.oemWrites.length, 0);
    assert.equal(harness.db.tables.leads[0].lead_status, mg);
  });
}

for (const fusion of ['pendingLost', 'Test Drive Booked']) {
  test(`Fusion "${fusion}" (not in the map) is held and reported, MG unchanged`, async (t) => {
    const harness = harnessAt(t, 'Not Contacted');
    const result = await receive(harness, body(fusion));
    assert.equal(result.held, true);
    assert.equal(result.reason, 'STATUS_MAPPING_NOT_FOUND');
    assert.equal(harness.oemWrites.length, 0);
    assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'HELD');
    assert.ok(harness.logs().some((l) => l.status === 'FAILED' && l.error_message.includes(fusion)));
  });
}

test('a body with only leadId (no lead_id) is still applied', async (t) => {
  const harness = harnessAt(t, 'Not Contacted');
  const { lead_id: _omit, ...rest } = body('Lost');
  const result = await receive(harness, rest);
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Lost Lead' });
});

test('after a Fusion Lost is applied, MG\'s own notification ("Lost" label) is not pushed back to Fusion', async (t) => {
  const harness = harnessAt(t, 'Not Contacted');
  await receive(harness, body('Lost'));
  const calls = fakeAdapter(t, { updateLead: async () => ({ httpStatus: 200, raw: {} }) });
  // MG's notification brings back the label, not the stored value.
  const leadRow = { ...harness.leadRow(), lead_status: 'Lost' };
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, leadRow);
  assert.equal(result.reason, 'ECHO_SUPPRESSED_OUTBOUND');
  assert.equal(calls.update.length, 0);
});

// Lead outcome (CRM fields for Exchange, Fusion SD Map): MG → Fusion only.
const OUTCOMES = [
  ['Contacted', 'Retail Order', 'Won'],
  ['Contacted', 'Fleet Order', 'Won'],
  ['Contacted', 'Purchase', 'Won'],
  ['Contacted', 'On-Sold', 'Won'],
  ['Contact in Future', 'On-Sold Demo', 'Won'],
  ['Contacted', 'Lost', 'Lost'],
  ['Contacted', 'Test Drive', 'Open'],
  ['Contacted', 'Outcome Pending', 'Open'],
  ['Not Qualified', '', 'Prospect Lost'],
];
for (const [mg, outcome, expected] of OUTCOMES) {
  test(`MG ${mg} with outcome "${outcome}" goes to Fusion as ${expected}`, async (t) => {
    const harness = harnessAt(t, mg);
    harness.db.tables.leads[0].enquiry_outcome = outcome;
    const calls = fakeAdapter(t, { updateLead: async () => ({ httpStatus: 200, raw: {} }) });
    await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].enquiryStatus, expected);
  });
}

test('an outcome set after a Fusion update is not mistaken for an echo', async (t) => {
  const harness = harnessAt(t, 'Not Contacted');
  await receive(harness, body('Prospect Lost'));
  const calls = fakeAdapter(t, { updateLead: async () => ({ httpStatus: 200, raw: {} }) });
  harness.db.tables.leads[0].enquiry_outcome = 'Lost';
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(calls.update.length, 1, JSON.stringify(result));
  assert.equal(calls.update[0].enquiryStatus, 'Lost');
});

// Lost reason (28 Oct 2026): onto MG's Reason_for_Lost picklist, Fusion's own
// wording and sub-reason into Reason_For_Loss_Other, and the dealer's date.
const REASONS = [
  ['Bought-Private', null, 'Bought Elsewhere', 'Dealer (Fusion): Bought Private'],
  ['Bought-From-Another-Dealer', null, 'Bought Elsewhere', 'Dealer (Fusion): Bought From Another Dealer'],
  ['Bought-Another-Brand', 'Kia', 'Bought Other Make', 'Dealer (Fusion): Bought Another Brand / Kia'],
  ['Trade-Value', null, 'Trade-In', 'Dealer (Fusion): Trade Value'],
  ['Unable-To-Contact', null, 'Other', 'Dealer (Fusion): Unable To Contact'],
  ['Some New Reason', null, 'Other', 'Dealer (Fusion): Some New Reason'],
];
for (const [reason, sub, mgReason, text] of REASONS) {
  test(`Fusion Lost with reason "${reason}"${sub ? ` / ${sub}` : ''} → MG Reason for Lost "${mgReason}"`, async (t) => {
    const harness = harnessAt(t, 'Not Contacted');
    await receive(harness, body('Lost', { lostReason: reason, lostSubReason: sub, pushed_at: '2026-10-28T05:20:24.046Z' }));
    assert.deepEqual(harness.oemWrites[0].fields, {
      Lead_Status: 'Lost Lead', Reason_for_Lost: mgReason, Reason_For_Loss_Other: text, Lost_Date: '2026-10-28',
    });
  });
}

test('the dealer\'s date is used: late evening UTC is the next day in Australia', async (t) => {
  const harness = harnessAt(t, 'Not Contacted');
  await receive(harness, body('Lost', { lostReason: 'Bought-Private', pushed_at: '2026-10-28T20:00:00Z' }));
  assert.equal(harness.oemWrites[0].fields.Lost_Date, '2026-10-29');
});

test('Lost without a reason writes only the status', async (t) => {
  const harness = harnessAt(t, 'Not Contacted');
  await receive(harness, body('Lost'));
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Lost Lead' });
});

test('a reason sent with Prospect Lost or Open is not written (Fusion applies it only to Lost)', async (t) => {
  const harness = harnessAt(t, 'Not Contacted');
  await receive(harness, body('Prospect Lost', { lostReason: 'Bought-Private' }));
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Not Qualified' });
});

// MG, 28 Oct 2026: tick "Lead Exchanged" in MG when the dealer accepts the lead.
test('a lead the dealer accepts is marked Lead Exchanged in MG, with the acknowledgement', async (t) => {
  withFlag(t);
  const harness = setupOutbound(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  fakeAdapter(t, { createLead: async () => ({ externalLeadId: 'lead_new', httpStatus: 201, raw: {} }) });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Not Contacted', Lead_Exchanged: true } }]);
});

test('a lead the dealer refuses is not marked Lead Exchanged', async (t) => {
  withFlag(t);
  const harness = setupOutbound(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  fakeAdapter(t, { createLead: async () => { const err = new Error('bad'); err.response = { status: 400, data: {} }; throw err; } });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()).catch(() => {});
  assert.equal(harness.oemWrites.some((w) => w.fields.Lead_Exchanged), false);
});

test('the lost reason is recorded on the lead\'s log with the status change', async (t) => {
  const harness = harnessAt(t, 'Not Contacted');
  await receive(harness, body('Lost', { lostReason: 'Bought-Private' }));
  const log = harness.logs().find((l) => l.status === 'SUCCESS' && l.direction === 'EXTERNAL_CRM_TO_ZOHO');
  const changes = JSON.parse(log.field_changes);
  assert.deepEqual(changes.find((c) => c.field === 'lost_reason'), {
    field: 'lost_reason', to: 'Bought Elsewhere', raw_dealer_value: 'Bought-Private',
    mg_text: 'Dealer (Fusion): Bought Private', lost_date: '2026-10-28',
  });
});

test('already Lost in MG: Fusion Lost with a reason writes only the reason, and nothing goes back to Fusion', async (t) => {
  const harness = harnessAt(t, 'Lost Lead');
  const calls = fakeAdapter(t, {});
  const before = { ...harness.db.tables.lead_integrations[0] };
  const result = await receive(harness, body('Lost', { lostReason: 'Bought-Another-Brand', lostSubReason: 'Kia' }));
  assert.equal(result.reason, 'LOST_REASON_UPDATED');
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: {
    Reason_for_Lost: 'Bought Other Make', Reason_For_Loss_Other: 'Dealer (Fusion): Bought Another Brand / Kia', Lost_Date: '2026-10-28',
  } }]);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Lost Lead');
  assert.equal(harness.db.tables.lead_integrations[0].last_sync_source_hash, before.last_sync_source_hash);
  assert.equal(calls.update.length + calls.create.length, 0);
});

test('already Lost in MG: Fusion Lost without a reason changes nothing', async (t) => {
  const harness = harnessAt(t, 'Lost Lead');
  const result = await receive(harness, body('Lost'));
  assert.equal(result.reason, 'NO_CHANGES');
  assert.equal(harness.oemWrites.length, 0);
});

test('already Lost in MG as the label "Lost" (as MG notifications store it): the reason is still written, and MG\'s echo is not sent to Fusion', async (t) => {
  const harness = harnessAt(t, 'Lost');
  await receive(harness, body('Lost', { lostReason: 'Trade-Value' }));
  assert.equal(harness.oemWrites.length, 1);
  assert.equal(harness.oemWrites[0].fields.Reason_for_Lost, 'Trade-In');
  const calls = fakeAdapter(t, { updateLead: async () => ({ httpStatus: 200, raw: {} }) });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, { ...harness.leadRow(), lead_status: 'Lost' });
  assert.equal(result.reason, 'ECHO_SUPPRESSED_OUTBOUND');
  assert.equal(calls.update.length, 0);
});
