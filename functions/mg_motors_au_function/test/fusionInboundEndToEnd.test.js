'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Acceptance for Batch 5 (FUSION_REMEDIATION_PLAN.md): Happy 2 for a Fusion
// dealer (Buckby MG, 725001, and every other Fusion dealer) re-saved with the
// Batch 4 presets. A webhook signed the Standard Webhooks way (by the Batch 0
// test signer, written independently of the verifier) goes through the real
// route, verifier, translator and inbound path to MG.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { signStandardWebhook, generateSigningSecret } = require('./helpers/standardWebhooksSigner');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const fusionSdAdapter = require('../services/integrations/adapters/fusionSdAdapter');
const webhookRoutes = require('../routes/webhookRoutes');

const SECRET = generateSigningSecret();

function withFlag(t, value) {
  const before = process.env.FUSION_INBOUND_V2;
  if (value === null) delete process.env.FUSION_INBOUND_V2;
  else process.env.FUSION_INBOUND_V2 = value;
  t.after(() => {
    if (before === undefined) delete process.env.FUSION_INBOUND_V2;
    else process.env.FUSION_INBOUND_V2 = before;
  });
}

async function buckby(t, { mgStatus = 'Contacted', flag = 'true' } = {}) {
  withFlag(t, flag);
  const harness = setupOutbound(t, { lead: { lead_status: mgStatus } });
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
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());

  const deliver = async (payload, { secret = SECRET, timestamp, tamper, contentType = 'application/json' } = {}) => {
    const signed = signStandardWebhook({ secret, timestamp, body: payload });
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/AU999`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...signed.headers },
      body: tamper ? tamper(signed.body) : signed.body,
    });
    return { status: response.status, body: await response.json(), id: signed.headers['webhook-id'] };
  };
  return { ...harness, deliver };
}

test('Happy 2: a signed Fusion "Lost" reaches MG; the event is stored under its webhook-id', async (t) => {
  const h = await buckby(t);
  const result = await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost', first_name: 'Other', lead_source: 'Walk In' }));
  assert.equal(result.status, 200);
  assert.equal(result.body.result.scenarioCode, 'Happy 2');
  assert.deepEqual(h.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Lost Lead' } }]);
  assert.equal(h.db.tables.leads[0].nature_of_enquiry, 'Test Drive');
  assert.equal(h.logs().find((log) => log.status === 'SUCCESS').happy_unhappy_path_name, 'Happy 2');
  const event = h.db.tables.webhook_events[0];
  assert.equal(event.event_id, result.id);
  assert.equal(event.processing_status, 'SUCCESS');
});

test('Happy 2: a signed "Prospect Lost" sets MG to Not Qualified', async (t) => {
  const h = await buckby(t, { mgStatus: 'Follow-up 2' });
  const result = await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Prospect Lost' }));
  assert.equal(result.status, 200);
  assert.deepEqual(h.oemWrites[0].fields, { Lead_Status: 'Not Qualified' });
});

test('a signed Fusion "Open" or "Won" for a progressed lead is acknowledged and changes nothing', async (t) => {
  const h = await buckby(t);
  for (const status of ['Open', 'Won', 'Delivered']) {
    const result = await h.deliver(fixtures.inboundFlatWebhookPayload({ status }));
    assert.equal(result.status, 200, status);
  }
  assert.equal(h.oemWrites.length, 0);
  assert.equal(h.logs().length, 0);
  assert.equal(h.alerts.mock.callCount(), 0);
});

test('a tampered body, another secret or a stale timestamp is refused with 401 and nothing is written', async (t) => {
  const h = await buckby(t);
  const payload = fixtures.inboundFlatWebhookPayload({ status: 'Lost' });
  const tampered = await h.deliver(payload, { tamper: (body) => body.replace('Lost', 'Open') });
  const otherSecret = await h.deliver(payload, { secret: generateSigningSecret() });
  const stale = await h.deliver(payload, { timestamp: Math.floor(Date.now() / 1000) - 600 });
  assert.deepEqual([tampered.status, otherSecret.status, stale.status], [401, 401, 401]);
  assert.equal(h.oemWrites.length, 0);
  assert.equal(h.db.tables.webhook_events.length, 0, 'refused before anything is recorded');
});

test('a webhook for a lead MG never sent (dealer-created) is held as Unhappy 7 and answered 202 (Q17)', async (t) => {
  const h = await buckby(t);
  const result = await h.deliver(fixtures.inboundFlatWebhookPayload({ lead_id: 'lead_DEALER_OWN', status: 'Open' }));
  assert.equal(result.status, 202);
  assert.equal(h.logs()[0].happy_unhappy_path_name, 'Unhappy 7');
  assert.equal(h.db.tables.webhook_events[0].processing_status, 'PENDING');
});

test('flag off: a Standard Webhooks delivery is refused (401) and nothing changes, as today', async (t) => {
  const h = await buckby(t, { flag: null });
  const result = await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost' }));
  assert.equal(result.status, 401);
  assert.equal(h.oemWrites.length, 0);
});

test('fusionSdAdapter declares webhook support only with FUSION_INBOUND_V2 on; getLead stays unsupported', (t) => {
  withFlag(t, null);
  assert.equal(fusionSdAdapter.capabilities.webhook, false);
  assert.equal(crmAdapterFactory.supports('FUSION_SD', 'webhook'), false);
  process.env.FUSION_INBOUND_V2 = 'true';
  assert.equal(fusionSdAdapter.capabilities.webhook, true);
  assert.equal(crmAdapterFactory.supports('FUSION_SD', 'webhook'), true);
  assert.equal(crmAdapterFactory.supports('FUSION_SD', 'getLead'), false);
  assert.equal(crmAdapterFactory.supports('ZOHO_CRM', 'webhook'), true);
});

// Review edge cases: Fusion may send a charset with its JSON content type; a
// request whose body is not JSON at all fails closed.
test('a signed webhook sent as application/json; charset=utf-8 is verified and applied', async (t) => {
  const h = await buckby(t);
  const result = await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost' }), { contentType: 'application/json; charset=utf-8' });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.scenarioCode, 'Happy 2');
});

test('a webhook sent with a non-JSON content type is refused (401) and changes nothing', async (t) => {
  const h = await buckby(t);
  const result = await h.deliver(fixtures.inboundFlatWebhookPayload({ status: 'Lost' }), { contentType: 'text/plain' });
  assert.equal(result.status, 401);
  assert.equal(h.oemWrites.length, 0);
  assert.equal(h.db.tables.webhook_events.length, 0);
});
