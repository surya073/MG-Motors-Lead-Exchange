'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 10 (FUSION_REMEDIATION_PLAN.md), field ownership: the dealer marks a
// lead Lost in Fusion, Batch 5 applies it to MG (Lost Lead), and later MG
// edits the postcode. A full PATCH re-sent MG's status mapped back to Fusion
// ("Prospect Lost") over the dealer's own "Lost". With
// FUSION_CHANGES_ONLY_PATCH on, applying the dealer's change also updates the
// snapshot of what Fusion holds, so the later edit sends only the postcode.
// A status MG itself changes afterwards is still sent: MG's own change wins.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const snapshot = require('../services/integrations/sentPayloadSnapshot');

function buckby(t, { flag = 'true' } = {}) {
  withEnv(t, {
    FUSION_CHANGES_ONLY_PATCH: flag,
    FUSION_INBOUND_V2: 'true',
    INTEGRATION_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64'),
  });
  const harness = setupOutbound(t, { lead: { lead_status: 'Contacted', postcode: '7250' } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  const calls = fakeAdapter(t, { updateLead: async (id) => ({ externalLeadId: id, httpStatus: 200, raw: {} }) });
  const mgEdit = async (changes = {}) => {
    Object.assign(harness.db.tables.leads[0], changes);
    return crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  };
  const dealerSets = (status) => crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status }), oemCrmService
  );
  return { harness, calls, mgEdit, dealerSets };
}

test('the dealer\'s Lost is not overwritten by a later MG edit of another field', async (t) => {
  const { harness, calls, mgEdit, dealerSets } = buckby(t);
  await mgEdit();                               // full payload; enquiryStatus Open
  const applied = await dealerSets('Lost');     // MG becomes Lost Lead
  assert.equal(applied.ok, true);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Lost Lead');
  assert.equal(snapshot.read(harness.db.tables.lead_integrations[0]).enquiryStatus, 'Prospect Lost');
  await mgEdit({ postcode: '7000' });
  assert.deepEqual(calls.update.at(-1), { 'contact.areaCode': '7000' });
});

test('a status MG itself changes afterwards is still sent (MG\'s own change wins)', async (t) => {
  const { calls, mgEdit, dealerSets } = buckby(t);
  await mgEdit();
  await dealerSets('Lost');
  await mgEdit({ lead_status: 'Contacted' });
  assert.deepEqual(calls.update.at(-1), { enquiryStatus: 'Open' });
});

test('a lead delivered before the switch (no snapshot) gets one when the dealer\'s change is applied', async (t) => {
  const { harness, calls, mgEdit, dealerSets } = buckby(t);
  assert.equal(snapshot.read(harness.db.tables.lead_integrations[0]), null);
  await dealerSets('Lost');
  await mgEdit({ postcode: '7000' });
  assert.deepEqual(calls.update.at(-1), { 'contact.areaCode': '7000' });
});

test('flag off: the later MG edit re-sends the full lead, status included, as before', async (t) => {
  const { calls, mgEdit, dealerSets } = buckby(t, { flag: '' });
  await mgEdit();
  await dealerSets('Lost');
  await mgEdit({ postcode: '7000' });
  assert.equal(calls.update.at(-1).enquiryStatus, 'Prospect Lost');
  assert.equal(calls.update.at(-1)['contact.areaCode'], '7000');
});
