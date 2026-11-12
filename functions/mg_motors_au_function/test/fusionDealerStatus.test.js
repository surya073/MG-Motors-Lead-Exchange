'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';
process.env.FUSION_INBOUND_V2 = 'true';

// A Fusion dealer marks a lead Won, then Delivered. MG sets the outcome once; the dealer's own word
// is kept on the lead's inbound log rows, so the lead page can show Fusion's current status, and an
// MG update afterwards never sends Won over a lead the dealer has marked Delivered.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { signStandardWebhook, generateSigningSecret } = require('./helpers/standardWebhooksSigner');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const dealerStatusService = require('../services/integrations/dealerStatusService');
const webhookRoutes = require('../routes/webhookRoutes');

const SECRET = generateSigningSecret();

async function fusionLead(t) {
  const harness = setupOutbound(t, { lead: { lead_status: 'Contacted' } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  harness.db.tables.webhook_events = [];
  Object.assign(harness.db.tables.dealer_integrations[0], { inbound_enabled: true, webhook_enabled: true });
  t.mock.method(catalyst, 'initialize', () => harness.db.app);
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (app, id, type) =>
    (type === 'WEBHOOK_SIGNING_SECRET' ? SECRET : null));
  const server = express();
  server.use(webhookRoutes);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  const deliver = async (payload) => {
    const signed = signStandardWebhook({ secret: SECRET, body: payload });
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/AU999`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...signed.headers }, body: signed.body,
    });
    const body = await response.json();
    // The in-memory Data Store does not stamp CREATEDTIME; Catalyst does, to the millisecond.
    harness.logs().forEach((row) => { if (!row.CREATEDTIME) { stamp += 1000; row.CREATEDTIME = new Date(stamp).toISOString().slice(0, 23).replace('T', ' ').replace('.', ':'); } });
    return { status: response.status, body };
  };
  let stamp = Date.UTC(2026, 10, 12, 6, 0, 0);
  return { ...harness, deliver };
}

const latest = (h) => dealerStatusService.readLatestDealerStatus(h.db.app, 'ZL1');

test('Won sets the outcome and the lead records Fusion status Won', async (t) => {
  const h = await fusionLead(t);
  assert.equal((await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Won' }))).status, 200);
  assert.deepEqual(h.oemWrites.map((w) => w.fields), [{ Enquiry_Outcome: 'Purchase' }]);
  assert.equal((await latest(h)).status, 'Won');
});

test('Delivered after Won changes nothing in MG but is recorded, so the current status reads Delivered', async (t) => {
  const h = await fusionLead(t);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Won' }));
  h.db.tables.leads[0].enquiry_outcome = 'Purchase'; // the write-back to MG has arrived
  const logsBefore = h.logs().length;
  const result = await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Delivered' }));
  assert.equal(result.status, 200);
  assert.equal(h.oemWrites.length, 1, 'MG was written once, by Won');
  assert.equal(h.logs().length, logsBefore + 1, 'one new row for the new word');
  assert.equal((await latest(h)).status, 'Delivered');
});

test('the same word again is not recorded twice', async (t) => {
  const h = await fusionLead(t);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Won' }));
  h.db.tables.leads[0].enquiry_outcome = 'Purchase';
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Delivered' }));
  const rows = h.logs().length;
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Delivered' }));
  assert.equal(h.logs().length, rows);
});

test('an MG update after Delivered sends Delivered, not Won, to Fusion', async (t) => {
  const h = await fusionLead(t);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Won' }));
  h.db.tables.leads[0].enquiry_outcome = 'Purchase';
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Delivered' }));
  h.db.tables.leads[0].postcode = '3123'; // an MG edit that must go to the dealer
  const calls = fakeAdapter(t, { updateLead: async (id) => ({ externalLeadId: id, httpStatus: 200, raw: {} }) });
  await crmIntegrationService.syncLeadToExternalCrm(h.db.app, h.integration, h.leadRow());
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].enquiryStatus, 'Delivered');
});

test('an MG update after Won only (no Delivered) still sends Won', async (t) => {
  const h = await fusionLead(t);
  await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Won' }));
  h.db.tables.leads[0].enquiry_outcome = 'Purchase';
  h.db.tables.leads[0].postcode = '3123';
  const calls = fakeAdapter(t, { updateLead: async (id) => ({ externalLeadId: id, httpStatus: 200, raw: {} }) });
  await crmIntegrationService.syncLeadToExternalCrm(h.db.app, h.integration, h.leadRow());
  assert.equal(calls.update[0].enquiryStatus, 'Won');
});

test('latestFromRows takes the newest dealer word and ignores other fields', () => {
  const row = (changes, at) => ({ integration_logs: { field_changes: JSON.stringify(changes), CREATEDTIME: at } });
  const rows = [
    row([{ field: 'postcode', from: '2001', to: '3777' }], '2026-11-12 10:00:00:000'),
    row([{ field: 'dealer_status', raw_dealer_value: 'Delivered', received_at: '2026-11-12T06:51:00.000Z' }], '2026-11-12 09:00:00:000'),
    row([{ field: 'enquiry_outcome', raw_dealer_value: 'Won' }], '2026-11-12 08:00:00:000'),
  ];
  assert.deepEqual(dealerStatusService.latestFromRows(rows), { status: 'Delivered', at: '2026-11-12T06:51:00.000Z' });
  assert.equal(dealerStatusService.latestFromRows([row([{ field: 'lost_reason', raw_dealer_value: 'Trade Value' }], 'x')]), null);
  assert.equal(dealerStatusService.latestFromRows([{ integration_logs: { field_changes: 'not json' } }]), null);
});
