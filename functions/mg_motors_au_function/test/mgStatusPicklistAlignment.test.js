'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Q26 (FUSION_REMEDIATION_PLAN.md): MG's Lead_Status picklist, as the app
// read it from MG's CRM on 9 Oct 2026 (oem_status_picklist), stores the
// labels "Dropped" and "Lost" as `Junk Lead` and `Lost Lead`, and has two
// values the code did not know: `PMA Unassigned` and `Finance Intro`.
//   - Both new values are valid MG statuses (additive: `Dropped` and `Lost`
//     stay valid for older leads and AU008's map).
//   - The Fusion preset maps Fusion "Lost" to MG `Lost Lead`, the value MG's
//     "Lost" label stores (568026's live map already does).
//   - Fusion only: `PMA Unassigned` (no dealer; MG's field matrix sends
//     nothing) is never sent as a Fusion status; `Finance Intro`, a worked
//     status, goes out as Open like the others (Q1).

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const pathPolicy = require('../services/integrations/pathPolicyService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');

test('PMA Unassigned and Finance Intro are valid MG statuses; Dropped and Lost still are', () => {
  const valid = pathPolicy.getMgLeadStatusSet();
  for (const status of ['PMA Unassigned', 'Finance Intro', 'Junk Lead', 'Lost Lead', 'Dropped', 'Lost']) {
    assert.ok(valid.has(pathPolicy.normalizeStatus(status)), status);
  }
});

function withPresets(t, options) {
  const harness = setupOutbound(t, options);
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  return harness;
}
const updated = async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });

test('Fusion "Lost" comes back as MG Lost Lead (what MG\'s "Lost" label stores)', async (t) => {
  withEnv(t, { FUSION_INBOUND_V2: 'true' });
  const harness = withPresets(t, { lead: { lead_status: 'Contacted' } });
  const result = await crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status: 'Lost' }), oemCrmService
  );
  assert.equal(result.scenarioCode, 'Happy 2');
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Lost Lead' } }]);
});

test('an MG lead at Lost Lead, echoed back by Fusion as Lost, is no change', async (t) => {
  withEnv(t, { FUSION_INBOUND_V2: 'true' });
  const harness = withPresets(t, { lead: { lead_status: 'Lost Lead' } });
  const result = await crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status: 'Lost' }), oemCrmService
  );
  assert.equal(result.skipped, true);
  assert.equal(harness.oemWrites.length, 0);
});

test('Fusion: a lead at Finance Intro goes out as Open', async (t) => {
  const harness = withPresets(t, { lead: { lead_status: 'Finance Intro' } });
  const calls = fakeAdapter(t, { updateLead: updated });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(result.ok, true);
  assert.equal(calls.update[0].enquiryStatus, 'Open');
});

test('Fusion: a lead at PMA Unassigned is delivered without a status, not held for a missing mapping', async (t) => {
  const harness = withPresets(t, { lead: { lead_status: 'PMA Unassigned', postcode: '7000' } });
  const calls = fakeAdapter(t, { updateLead: updated });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(result.ok, true);
  assert.equal('enquiryStatus' in calls.update[0], false);
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'SYNCED');
});

test('a non-Fusion dealer still needs a mapping for PMA Unassigned, as before', async (t) => {
  const harness = setupOutbound(t, { integration: { crm_type: 'GENERIC_REST', update_lead_endpoint: '/x/{externalLeadId}' }, lead: { lead_status: 'PMA Unassigned' } });
  const calls = fakeAdapter(t, { updateLead: updated });
  // Refused as an incomplete configuration (status:PMA Unassigned), as today.
  await assert.rejects(
    crmIntegrationService.syncLeadToExternalCrm(harness.db.app, { ...harness.integration }, harness.leadRow()),
    /status:PMA Unassigned/
  );
  assert.equal(calls.update.length, 0);
});
