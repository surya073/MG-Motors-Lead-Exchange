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

test('a lead with no snapshot records only what the dealer changed; the next MG edit sends the rest, never the status', async (t) => {
  const { harness, calls, mgEdit, dealerSets } = buckby(t);
  assert.equal(snapshot.read(harness.db.tables.lead_integrations[0]), null);
  await dealerSets('Lost');
  assert.deepEqual(snapshot.read(harness.db.tables.lead_integrations[0]), { enquiryStatus: 'Prospect Lost' });
  await mgEdit({ postcode: '7000' });
  const sent = calls.update.at(-1);
  assert.equal(sent['contact.areaCode'], '7000');
  assert.equal(sent['contact.email'], 'jane@example.com', 'fields Fusion may not have are sent once');
  assert.equal('enquiryStatus' in sent, false, 'the dealer\'s status is not overwritten');
});

test('review: an MG edit that never reached Fusion is not lost when a dealer change arrives first', async (t) => {
  const { harness, calls, mgEdit, dealerSets } = buckby(t);
  // MG changed the postcode, but the PATCH failed and the lead waits for a retry;
  // no snapshot exists yet (delivered before the switch).
  Object.assign(harness.db.tables.leads[0], { postcode: '7000' });
  harness.db.tables.lead_integrations[0].sync_status = 'FAILED';
  await dealerSets('Lost');
  await mgEdit({ vehicle_model: 'MG4' });
  const sent = calls.update.at(-1);
  assert.equal(sent['contact.areaCode'], '7000', 'the pending postcode still reaches Fusion');
  assert.equal(sent['requirement.model'], 'MG4');
  assert.equal('enquiryStatus' in sent, false);
});

test('flag off: the later MG edit re-sends the full lead, status included, as before', async (t) => {
  const { calls, mgEdit, dealerSets } = buckby(t, { flag: '' });
  await mgEdit();
  await dealerSets('Lost');
  await mgEdit({ postcode: '7000' });
  assert.equal(calls.update.at(-1).enquiryStatus, 'Prospect Lost');
  assert.equal(calls.update.at(-1)['contact.areaCode'], '7000');
});

// Q33 with Fusion: MG's postcode edit fails, the dealer marks the lead Lost
// before the retry. With KEEP_OUTBOUND_RETRY_ON_INBOUND the retry is kept;
// with changes-only it sends the postcode alone, never the status over the
// dealer's Lost.
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const { fakeAdapter: failingOnce } = require('./helpers/outboundHarness');

test('Q33: the kept retry delivers MG\'s pending postcode and leaves the dealer\'s Lost alone', async (t) => {
  withEnv(t, {
    FUSION_CHANGES_ONLY_PATCH: 'true',
    FUSION_INBOUND_V2: 'true',
    KEEP_OUTBOUND_RETRY_ON_INBOUND: 'true',
    INTEGRATION_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64'),
  });
  const harness = setupOutbound(t, { lead: { lead_status: 'Contacted', postcode: '7250' } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  let attempt = 0;
  const calls = failingOnce(t, {
    updateLead: async (id) => {
      attempt += 1;
      if (attempt === 2) throw Object.assign(new Error('Fusion unreachable'), { code: 'ECONNRESET' });
      return { externalLeadId: id, httpStatus: 200, raw: {} };
    },
  });
  const mgEdit = (changes = {}) => {
    Object.assign(harness.db.tables.leads[0], changes);
    return crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()).catch(() => null);
  };
  await mgEdit();                                 // 1: full payload, snapshot kept
  await mgEdit({ postcode: '7000' });             // 2: fails; waits for its retry
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'FAILED');
  const applied = await crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status: 'Lost' }), oemCrmService
  );
  assert.equal(applied.ok, true);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Lost Lead');
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'FAILED', 'retry kept');

  _resetForTests();
  const sweep = await outboundRetryScheduler.runOutboundRetrySweep(harness.db.app, { ignoreSchedule: true });
  assert.equal(sweep.recovered, 1);
  assert.deepEqual(calls.update.at(-1), { 'contact.areaCode': '7000' });
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'SYNCED');
});
