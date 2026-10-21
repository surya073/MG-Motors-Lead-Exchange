'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 5 (FUSION_REMEDIATION_PLAN.md): the dealer webhook route for Fusion
// SD with FUSION_INBOUND_V2 on. Verification and processing are stubbed;
// these tests cover only what the route decides itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const webhookVerificationService = require('../services/integrations/webhookVerificationService');
const fusionReturnChannelProof = require('../services/integrations/fusionReturnChannelProof');
const webhookRoutes = require('../routes/webhookRoutes');

function withFlag(t, value) {
  const before = process.env.FUSION_INBOUND_V2;
  if (value === null) delete process.env.FUSION_INBOUND_V2;
  else process.env.FUSION_INBOUND_V2 = value;
  t.after(() => {
    if (before === undefined) delete process.env.FUSION_INBOUND_V2;
    else process.env.FUSION_INBOUND_V2 = before;
  });
}

async function setup(t, { crmType = 'FUSION_SD', flag = 'true', duplicate = false, knownDealerCodes = ['725001', 'AU008'] } = {}) {
  withFlag(t, flag);
  t.mock.method(catalyst, 'initialize', () => ({}));
  t.mock.method(crmIntegrationService, 'findDealerByCode', async (app, code) =>
    (knownDealerCodes.includes(code) ? { dealer_code: code } : null));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async (app, code) => ({
    ROWID: '1000', dealer_code: code, crm_type: crmType, integration_type: 'EXTERNAL_CRM',
    inbound_enabled: true, webhook_enabled: true,
  }));
  t.mock.method(webhookVerificationService, 'verifyWebhook', async () => ({ ok: true }));
  const recorded = [];
  t.mock.method(crmIntegrationService, 'checkAndRecordWebhookEvent', async (app, integration, rawBody, eventId) => {
    recorded.push(eventId);
    return { isDuplicate: duplicate, eventRowId: 'ev1' };
  });
  const processed = [];
  t.mock.method(crmIntegrationService, 'processInboundWebhook', async (app, integration, payload) => {
    processed.push(payload);
    return { ok: true };
  });
  t.mock.method(crmIntegrationService, 'markWebhookEventStatus', async () => {});

  const server = express();
  server.use(webhookRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());

  const post = async (dealerCode, payload, headers = {}) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/${dealerCode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  return { post, recorded, processed };
}

const FUSION_HEADERS = { 'webhook-id': 'msg_2Lh0', 'webhook-timestamp': '1760000000', 'webhook-signature': 'v1,abc' };

test('Fusion, flag on: the webhook-id header is the event id, so a Fusion retry is recognised', async (t) => {
  const { post, recorded } = await setup(t);
  const result = await post('725001', { lead_id: 'lead_1', status: 'Lost' }, FUSION_HEADERS);
  assert.equal(result.status, 200);
  assert.deepEqual(recorded, ['msg_2Lh0']);
});

test('Fusion, flag on: a repeated webhook-id answers 200 DUPLICATE without processing', async (t) => {
  const { post, processed } = await setup(t, { duplicate: true });
  const result = await post('725001', { lead_id: 'lead_1', status: 'Lost' }, FUSION_HEADERS);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'DUPLICATE');
  assert.equal(processed.length, 0);
});

test('flag off: the webhook-id header is not used, as today', async (t) => {
  const { post, recorded } = await setup(t, { flag: null });
  await post('725001', { leadId: 'lead_1', enquiryStatus: 'Lost' }, FUSION_HEADERS);
  assert.deepEqual(recorded, [null]);
});

test('flag on: ZOHO_CRM and GENERIC_REST dealers do not use the webhook-id header', async (t) => {
  for (const crmType of ['ZOHO_CRM', 'GENERIC_REST']) {
    await t.test(crmType, async (st) => {
      const { post, recorded } = await setup(st, { crmType });
      await post('AU008', { module: 'Leads', ids: ['1'], id: 'x' }, FUSION_HEADERS);
      assert.deepEqual(recorded, [null]);
    });
  }
});

test('an explicit X-Webhook-Id still wins for every dealer, as today', async (t) => {
  const { post, recorded } = await setup(t);
  await post('725001', { lead_id: 'lead_1' }, { ...FUSION_HEADERS, 'x-webhook-id': 'legacy-id' });
  assert.deepEqual(recorded, ['legacy-id']);
});

// Q18: Fusion's dealer_id is "your own id for this dealer if you gave them
// one, otherwise ours". A mismatch is logged; only a different MG dealer's
// code is refused, since the per-dealer signing secret proves the sender.
test('Q18: dealer_id equal to the route\'s dealer code (any case), absent or null is processed', async (t) => {
  const { post, processed } = await setup(t);
  for (const dealerId of ['725001', undefined, null]) {
    const result = await post('725001', { lead_id: 'lead_1', status: 'Lost', dealer_id: dealerId }, FUSION_HEADERS);
    assert.equal(result.status, 200, String(dealerId));
  }
  assert.equal(processed.length, 3);
});

test('Q18: Fusion\'s own dealer id (not an MG dealer code) is processed, not rejected', async (t) => {
  const { post, processed } = await setup(t);
  const result = await post('725001', { lead_id: 'lead_1', status: 'Lost', dealer_id: 'dlr_01M4FUSIONOWNID' }, FUSION_HEADERS);
  assert.equal(result.status, 200);
  assert.equal(processed.length, 1);
});

test('Q18: dealer_id naming a different MG dealer is refused with 401 and not recorded or processed', async (t) => {
  const { post, processed, recorded } = await setup(t);
  const result = await post('725001', { lead_id: 'lead_1', status: 'Lost', dealer_id: 'au008' }, FUSION_HEADERS);
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'WEBHOOK_DEALER_MISMATCH');
  assert.equal(processed.length, 0);
  assert.equal(recorded.length, 0);
});

test('Q18, flag off: dealer_id is not checked, as today', async (t) => {
  const { post, processed } = await setup(t, { flag: null });
  const result = await post('725001', { leadId: 'lead_1', enquiryStatus: 'Lost', dealer_id: 'AU008' }, FUSION_HEADERS);
  assert.equal(result.status, 200);
  assert.equal(processed.length, 1);
});

test('Batch 6: an event still in progress is answered 202 IN_PROGRESS and not processed again', async (t) => {
  const { post, processed } = await setup(t);
  crmIntegrationService.checkAndRecordWebhookEvent.mock.mockImplementation(async () => ({ isDuplicate: true, inProgress: true }));
  const result = await post('725001', { lead_id: 'lead_1', status: 'Lost' }, FUSION_HEADERS);
  assert.equal(result.status, 202);
  assert.equal(result.body.status, 'IN_PROGRESS');
  assert.equal(processed.length, 0);
});

test('Batch 6: the dealer lead id is passed along to be stored with the event', async (t) => {
  const { post } = await setup(t);
  await post('725001', { lead_id: 'lead_XYZ', status: 'Lost' }, FUSION_HEADERS);
  const call = crmIntegrationService.checkAndRecordWebhookEvent.mock.calls[0];
  assert.deepEqual(call.arguments[4], { externalLeadId: 'lead_XYZ' });
});

test('review, Batch 6: the dealer lead id is stored trimmed, as replay looks it up', async (t) => {
  const { post } = await setup(t);
  await post('725001', { lead_id: '  lead_XYZ  ', status: 'Lost' }, FUSION_HEADERS);
  const call = crmIntegrationService.checkAndRecordWebhookEvent.mock.calls[0];
  assert.deepEqual(call.arguments[4], { externalLeadId: 'lead_XYZ' });
});

test('review, Batch 6: a blank lead id is stored as none', async (t) => {
  const { post } = await setup(t);
  await post('725001', { lead_id: '   ', status: 'Lost' }, FUSION_HEADERS);
  const call = crmIntegrationService.checkAndRecordWebhookEvent.mock.calls[0];
  assert.deepEqual(call.arguments[4], { externalLeadId: null });
});

const PROVEN_AUTH = {
  ok: true,
  method: 'STANDARD_WEBHOOKS',
  signingSecretFingerprint: fusionReturnChannelProof.signingSecretFingerprint('synthetic-signing-secret'),
};

test('signed successful processing records channel proof only after the event is marked SUCCESS', async (t) => {
  const { post } = await setup(t);
  webhookVerificationService.verifyWebhook.mock.mockImplementation(async () => PROVEN_AUTH);
  const order = [];
  crmIntegrationService.markWebhookEventStatus.mock.mockImplementation(async (_app, _id, status) => { order.push(status); });
  const record = t.mock.method(fusionReturnChannelProof, 'recordVerifiedSuccess', async (_app, integration, result) => {
    assert.equal(integration.ROWID, '1000');
    assert.equal(result, PROVEN_AUTH);
    order.push('proof');
    return true;
  });
  const result = await post('725001', { lead_id: 'lead_1', status: 'Lost' }, FUSION_HEADERS);
  assert.equal(result.status, 200);
  assert.deepEqual(order, ['SUCCESS', 'proof']);
  assert.equal(record.mock.callCount(), 1);
  assert.ok(!JSON.stringify(result.body).includes('signingSecretFingerprint'), 'authentication provenance stays internal');
});

test('a signed duplicate asks the proof store to confirm the stored event succeeded', async (t) => {
  const { post, processed } = await setup(t, { duplicate: true });
  webhookVerificationService.verifyWebhook.mock.mockImplementation(async () => PROVEN_AUTH);
  const record = t.mock.method(fusionReturnChannelProof, 'recordVerifiedDuplicate', async () => true);
  const result = await post('725001', { lead_id: 'lead_1', status: 'Lost' }, FUSION_HEADERS);
  assert.equal(result.body.status, 'DUPLICATE');
  assert.equal(processed.length, 0);
  const args = record.mock.calls[0].arguments;
  assert.equal(args[2], PROVEN_AUTH);
  assert.equal(args[3], FUSION_HEADERS['webhook-id']);
  assert.ok(Buffer.isBuffer(args[4]));
});

test('held, failed and in-progress signed events do not establish return-channel proof', async (t) => {
  const { post } = await setup(t);
  webhookVerificationService.verifyWebhook.mock.mockImplementation(async () => PROVEN_AUTH);
  const record = t.mock.method(fusionReturnChannelProof, 'recordVerifiedSuccess', async () => true);
  const duplicate = t.mock.method(fusionReturnChannelProof, 'recordVerifiedDuplicate', async () => true);
  crmIntegrationService.processInboundWebhook.mock.mockImplementation(async () => ({ held: true, reason: 'MAPPING_NOT_READY' }));
  assert.equal((await post('725001', { lead_id: 'lead_1' }, FUSION_HEADERS)).status, 202);
  crmIntegrationService.processInboundWebhook.mock.mockImplementation(async () => { throw Object.assign(new Error('invalid mapping'), { code: 'FIELD_MAPPING_INVALID' }); });
  assert.equal((await post('725001', { lead_id: 'lead_1' }, FUSION_HEADERS)).status, 422);
  crmIntegrationService.checkAndRecordWebhookEvent.mock.mockImplementation(async () => ({ inProgress: true, isDuplicate: true }));
  assert.equal((await post('725001', { lead_id: 'lead_1' }, FUSION_HEADERS)).status, 202);
  assert.equal(record.mock.callCount(), 0);
  assert.equal(duplicate.mock.callCount(), 0);
});

test('a channel-proof store failure preserves a completed successful webhook acknowledgement', async (t) => {
  const { post } = await setup(t);
  webhookVerificationService.verifyWebhook.mock.mockImplementation(async () => PROVEN_AUTH);
  t.mock.method(fusionReturnChannelProof, 'recordVerifiedSuccess', async () => { throw new Error('proof store unavailable'); });
  const result = await post('725001', { lead_id: 'lead_1', status: 'Lost' }, FUSION_HEADERS);
  assert.equal(result.status, 200);
  assert.equal(crmIntegrationService.markWebhookEventStatus.mock.callCount(), 1);
  assert.equal(crmIntegrationService.markWebhookEventStatus.mock.calls[0].arguments[2], 'SUCCESS');
});
