'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 5 (FUSION_REMEDIATION_PLAN.md), Q1 (13 Oct 2026): every MG status a
// dealer works on goes to Fusion as "Open", so Fusion "Open" coming back must
// never move a lead MG has progressed back to Not Contacted; and Fusion Won /
// Delivered leave MG unchanged. Fusion leads cannot be read back or replayed
// before Batch 6, so neither case is held: they are simply not applied.

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET, OPEN } = require('./helpers/fusionPresets');
const oemCrmService = require('../services/zohoCrmService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

function withFlag(t, value) {
  const before = process.env.FUSION_INBOUND_V2;
  if (value === null) delete process.env.FUSION_INBOUND_V2;
  else process.env.FUSION_INBOUND_V2 = value;
  t.after(() => {
    if (before === undefined) delete process.env.FUSION_INBOUND_V2;
    else process.env.FUSION_INBOUND_V2 = before;
  });
}

function buckby(t, mgStatus, { flag = 'true' } = {}) {
  withFlag(t, flag);
  const harness = setupOutbound(t, { lead: { lead_status: mgStatus } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  return harness;
}

const fusionStatus = (harness, status) => crmIntegrationService.processInboundWebhook(
  harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status }), oemCrmService
);

function assertUntouched(harness, mgStatus) {
  assert.equal(harness.oemWrites.length, 0, 'nothing written to MG');
  assert.equal(harness.db.tables.leads[0].lead_status, mgStatus);
  assert.equal(harness.logs().length, 0, 'no failure or hold logged');
  assert.equal(harness.alerts.mock.callCount(), 0, 'no alert');
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'SYNCED', 'not held');
}

for (const mgStatus of OPEN.filter((s) => s !== 'Not Contacted').concat(['Lost', 'Not Qualified', 'Dealer Unavailable', 'Unattended Alert'])) {
  test(`Fusion "Open" leaves an MG lead at ${mgStatus} unchanged, without a hold or alert`, async (t) => {
    const harness = buckby(t, mgStatus);
    const result = await fusionStatus(harness, 'Open');
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'FUSION_STATUS_KEPT_MG_STATUS');
    assertUntouched(harness, mgStatus);
  });
}

test('Fusion "Open" on a lead still at Update Pending moves it to Not Contacted (Happy 2)', async (t) => {
  const harness = buckby(t, 'Update Pending');
  const result = await fusionStatus(harness, 'Open');
  assert.equal(result.ok, true);
  assert.equal(result.scenarioCode, 'Happy 2');
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Not Contacted' } }]);
});

test('Fusion "Open" on a lead already at Not Contacted changes nothing', async (t) => {
  const harness = buckby(t, 'Not Contacted');
  const result = await fusionStatus(harness, 'Open');
  assert.equal(result.skipped, true);
  assert.equal(harness.oemWrites.length, 0);
});

for (const status of ['Won', 'Delivered', 'won', ' DELIVERED ']) {
  test(`Fusion "${status}" leaves MG unchanged, without a hold or alert (Q1)`, async (t) => {
    const harness = buckby(t, 'Contacted');
    const result = await fusionStatus(harness, status);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'FUSION_STATUS_NOT_APPLIED');
    assertUntouched(harness, 'Contacted');
  });
}

test('Happy 2: Fusion "Lost" on a progressed lead moves MG to Lost', async (t) => {
  const harness = buckby(t, 'Contacted');
  const result = await fusionStatus(harness, 'Lost');
  assert.equal(result.ok, true);
  assert.equal(result.scenarioCode, 'Happy 2');
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Lost' } }]);
  assert.equal(harness.db.tables.lead_integrations[0].last_sync_direction, 'EXTERNAL_CRM_TO_ZOHO');
  const log = harness.logs().find((row) => row.status === 'SUCCESS');
  assert.equal(log.happy_unhappy_path_name, 'Happy 2');
  const change = JSON.parse(log.field_changes)[0];
  assert.equal(change.raw_dealer_value, 'Lost');
  assert.equal(change.dealer_changed_at, '2026-10-12T10:00:00Z');
});

test('Happy 2: Fusion "Prospect Lost" moves MG to Not Qualified', async (t) => {
  const harness = buckby(t, 'Follow-up 1');
  const result = await fusionStatus(harness, 'Prospect Lost');
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Not Qualified' } }]);
});

test('a dealer status with no mapping row is still held for an MG decision (Unhappy 4), as today', async (t) => {
  const harness = buckby(t, 'Contacted');
  const result = await fusionStatus(harness, 'Sold - Awaiting Finance');
  assert.equal(result.held, true);
  assert.equal(result.reason, 'STATUS_MAPPING_NOT_FOUND');
  assert.equal(harness.oemWrites.length, 0);
  assert.equal(harness.logs()[0].happy_unhappy_path_name, 'Unhappy 4');
});

test('an admin-added inbound row for Won is honoured', async (t) => {
  const harness = buckby(t, 'Follow-up 1');
  harness.db.tables.integration_status_mappings.push({
    integration_id: '1000', source_status: 'Won', target_status: 'Contacted', direction: 'EXTERNAL_TO_ZOHO',
  });
  const result = await fusionStatus(harness, 'Won');
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Contacted' });
});

test('flag off: a Fusion status update on the old path behaves exactly as today (Open rolls a lead back)', async (t) => {
  const harness = buckby(t, 'Contacted', { flag: null });
  const result = await crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, { leadId: fixtures.FUSION_TEST_LEAD_ID, enquiryStatus: 'Open' }, oemCrmService
  );
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Not Contacted' });
});

test('flag on: a GENERIC_REST dealer keeps today\'s status handling (no Open guard)', async (t) => {
  const harness = buckby(t, 'Contacted');
  const integration = { ...harness.integration, crm_type: 'GENERIC_REST' };
  const result = await crmIntegrationService.processInboundWebhook(
    harness.db.app, integration, { id: fixtures.FUSION_TEST_LEAD_ID, enquiryStatus: 'Open' }, oemCrmService
  );
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Not Contacted' });
});

// Many MG statuses go out as one Fusion status (Q1). Fusion echoing back the
// status MG's current status is already sent as (e.g. after our own PATCH)
// is no news: MG Lost, sent as Prospect Lost, must not become Not Qualified.
for (const mgStatus of ['Lost', 'Dropped', 'Junk Lead', 'Lost Lead', 'Not Qualified']) {
  test(`Fusion "Prospect Lost" echoed back for an MG lead at ${mgStatus} changes nothing`, async (t) => {
    const harness = buckby(t, mgStatus);
    const result = await fusionStatus(harness, 'Prospect Lost');
    assert.equal(result.skipped, true);
    assertUntouched(harness, mgStatus);
  });
}

test('Fusion "Lost" for an MG lead at Dropped (sent as Prospect Lost) is a real change: MG becomes Lost', async (t) => {
  const harness = buckby(t, 'Dropped');
  const result = await fusionStatus(harness, 'Lost');
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Lost' });
});

test('Fusion "Prospect Lost" for a Contacted lead (sent as Open) is a real change', async (t) => {
  const harness = buckby(t, 'Contacted');
  const result = await fusionStatus(harness, 'Prospect Lost');
  assert.equal(result.ok, true);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Not Qualified' });
});
