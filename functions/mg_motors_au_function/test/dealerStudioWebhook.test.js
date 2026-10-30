'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Dealer Studio's Lead Cluster Webhook: translator, X-Signature verification
// and the inbound status path (https://dev.dealerstudio.com.au/guides/lms/
// lead-cluster-webhook/).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { translateDealerStudioWebhook } = require('../services/integrations/adapters/dealerStudioInbound');
const webhookVerificationService = require('../services/integrations/webhookVerificationService');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const { setupOutbound, LEAD } = require('./helpers/outboundHarness');

// ---------------------------------------------------------------- translator

const MAPPINGS = [{ source_field: 'lead_status', target_field: 'status' }];

test('translator: status type (lowercased) is preferred and the lead ids come from leads[]', () => {
  const out = translateDealerStudioWebhook({
    id: 200001, status: 'Contacted', status_type: 'Working', updated_at: '2026-10-30T01:00:00Z',
    leads: [{ id: 100001 }, { id: '100002' }, { id: 100001 }],
  }, MAPPINGS);
  assert.deepEqual(out.leadIds, ['100001', '100002']);
  assert.equal(out.clusterId, '200001');
  assert.equal(out.hasStatus, true);
  assert.deepEqual(out.record, { status: 'working', modified_at: '2026-10-30T01:00:00Z' });
});

test('translator: reads lead_status_option, then falls back to the status name', () => {
  assert.equal(translateDealerStudioWebhook({ id: 1, lead_status_option: { status_type: 'Lost', name: 'Gone' } }).record.status, 'lost');
  assert.equal(translateDealerStudioWebhook({ id: 1, status: 'Contacted' }).record.status, 'Contacted');
  assert.equal(translateDealerStudioWebhook({ id: 1, status: { id: 3, name: 'Test Drive Done' } }).record.status, 'Test Drive Done');
  assert.equal(translateDealerStudioWebhook({ id: 1, lead_status_option: { name: 'Hot' } }).record.status, 'Hot');
});

test('translator: no status means no record; the status key follows the dealer mapping, default "status"', () => {
  const none = translateDealerStudioWebhook({ id: 1, contact: { email: 'a@b.c' }, leads: [{ id: 9 }] }, MAPPINGS);
  assert.equal(none.hasStatus, false);
  assert.deepEqual(none.record, {});
  assert.deepEqual(translateDealerStudioWebhook({ id: 1, status_type: 'new' }, []).record, { status: 'new' });
  assert.deepEqual(translateDealerStudioWebhook({ id: 1, status_type: 'new' }, [{ source_field: 'lead_status', target_field: 'enquiryStatus' }]).record, { enquiryStatus: 'new' });
});

test('translator: tolerates junk bodies', () => {
  for (const body of [null, undefined, 'x', [], 5, { leads: 'nope' }, { leads: [null, 3, {}] }]) {
    const out = translateDealerStudioWebhook(body, MAPPINGS);
    assert.deepEqual(out.leadIds, []);
    assert.equal(out.hasStatus, false);
  }
});

// -------------------------------------------------------------- verification

const SECRET = 'ds-signing-secret-xyz';
const TOKEN = 'ds-token-123';
const BODY = Buffer.from(JSON.stringify({ id: 200001, status_type: 'working', leads: [{ id: 100001 }] }));
const sign = (secret, body = BODY) => crypto.createHmac('sha256', secret).update(body).digest('base64');
const dsIntegration = { ROWID: '1000', dealer_code: 'AU999', crm_type: 'DEALER_STUDIO', webhook_enabled: true };

function withCredentials(t, creds) {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (_app, _id, type) => creds[type] ?? null);
}
const verify = (headers, body = BODY) => webhookVerificationService.verifyWebhook({}, dsIntegration, body, headers);

test('verify: a correct Base64 HMAC-SHA256 X-Signature is accepted', async (t) => {
  withCredentials(t, { WEBHOOK_SIGNING_SECRET: SECRET });
  const result = await verify({ 'x-signature': sign(SECRET) });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'DEALER_STUDIO_HMAC');
});

test('verify: a wrong signature, a tampered body or another secret is refused', async (t) => {
  withCredentials(t, { WEBHOOK_SIGNING_SECRET: SECRET });
  assert.deepEqual(await verify({ 'x-signature': sign('other-secret') }), { ok: false, reason: 'INVALID_SIGNATURE' });
  assert.deepEqual(await verify({ 'x-signature': sign(SECRET) }, Buffer.from('{"id":1}')), { ok: false, reason: 'INVALID_SIGNATURE' });
  assert.deepEqual(await verify({ 'x-signature': 'AAAA' }), { ok: false, reason: 'INVALID_SIGNATURE' });
});

test('verify: a base64 or hex shaped secret is also tried decoded', async (t) => {
  const raw = crypto.randomBytes(32);
  withCredentials(t, { WEBHOOK_SIGNING_SECRET: raw.toString('base64') });
  assert.equal((await verify({ 'x-signature': sign(raw) })).ok, true);
  t.mock.restoreAll();
  withCredentials(t, { WEBHOOK_SIGNING_SECRET: raw.toString('hex') });
  assert.equal((await verify({ 'x-signature': sign(raw) })).ok, true);
});

test('verify: once a signing secret is stored, an unsigned request is refused even with a valid token', async (t) => {
  withCredentials(t, { WEBHOOK_SIGNING_SECRET: SECRET, WEBHOOK_SECRET: TOKEN });
  assert.deepEqual(await verify({ 'x-authorization': TOKEN }), { ok: false, reason: 'MISSING_SIGNATURE' });
});

test('verify: a signature header with no stored secret is refused', async (t) => {
  withCredentials(t, { WEBHOOK_SECRET: TOKEN });
  assert.deepEqual(await verify({ 'x-signature': sign(SECRET) }), { ok: false, reason: 'WEBHOOK_SIGNING_SECRET_MISSING' });
});

test('verify: a token sent alongside a good signature must match the stored one', async (t) => {
  withCredentials(t, { WEBHOOK_SIGNING_SECRET: SECRET, WEBHOOK_SECRET: TOKEN });
  assert.equal((await verify({ 'x-signature': sign(SECRET), 'x-authorization': TOKEN })).ok, true);
  assert.equal((await verify({ 'x-signature': sign(SECRET), 'x-authorization': `Bearer ${TOKEN}` })).ok, true);
  assert.deepEqual(await verify({ 'x-signature': sign(SECRET), 'x-authorization': 'wrong' }), { ok: false, reason: 'INVALID_TOKEN' });
});

test('verify: without a signing secret, X-Authorization alone works when it matches', async (t) => {
  withCredentials(t, { WEBHOOK_SECRET: TOKEN });
  assert.equal((await verify({ 'x-authorization': TOKEN })).ok, true);
  assert.deepEqual(await verify({ 'x-authorization': 'nope' }), { ok: false, reason: 'INVALID_TOKEN' });
  assert.deepEqual(await verify({}), { ok: false, reason: 'MISSING_AUTH' });
});

function withEnvToken(t, value) {
  const saved = process.env.DEALER_STUDIO_WEBHOOK_SECRET;
  process.env.DEALER_STUDIO_WEBHOOK_SECRET = value;
  t.after(() => {
    if (saved === undefined) delete process.env.DEALER_STUDIO_WEBHOOK_SECRET;
    else process.env.DEALER_STUDIO_WEBHOOK_SECRET = saved;
  });
}

test('verify: DEALER_STUDIO_WEBHOOK_SECRET is accepted as the token for any Dealer Studio dealer', async (t) => {
  withCredentials(t, {});
  withEnvToken(t, 'env-token-abc');
  assert.deepEqual(await verify({ 'x-authorization': 'env-token-abc' }), { ok: true, method: 'DEALER_STUDIO_TOKEN' });
  assert.equal((await verify({ 'x-authorization': 'Bearer env-token-abc' })).ok, true);
  assert.deepEqual(await verify({ 'x-authorization': 'wrong' }), { ok: false, reason: 'INVALID_TOKEN' });
  assert.deepEqual(await verify({}), { ok: false, reason: 'MISSING_AUTH' });
});

test('verify: the env token is also checked beside a good signature, and does not replace a stored signing secret', async (t) => {
  withCredentials(t, { WEBHOOK_SIGNING_SECRET: SECRET });
  withEnvToken(t, 'env-token-abc');
  assert.equal((await verify({ 'x-signature': sign(SECRET), 'x-authorization': 'env-token-abc' })).ok, true);
  assert.deepEqual(await verify({ 'x-signature': sign(SECRET), 'x-authorization': 'wrong' }), { ok: false, reason: 'INVALID_TOKEN' });
  assert.deepEqual(await verify({ 'x-authorization': 'env-token-abc' }), { ok: false, reason: 'MISSING_SIGNATURE' });
});

test('verify: the env token never applies to a non-Dealer-Studio dealer', async (t) => {
  withCredentials(t, {});
  withEnvToken(t, 'env-token-abc');
  const generic = { ROWID: '1001', dealer_code: 'AU998', crm_type: 'GENERIC_REST', webhook_enabled: true };
  const result = await webhookVerificationService.verifyWebhook({}, generic, BODY, { 'x-webhook-token': 'env-token-abc' });
  assert.equal(result.ok, false);
});

test('verify: nothing configured is refused, and a disabled webhook is refused first', async (t) => {
  withCredentials(t, {});
  assert.deepEqual(await verify({ 'x-signature': sign(SECRET) }), { ok: false, reason: 'WEBHOOK_SIGNING_SECRET_MISSING' });
  assert.deepEqual(await verify({}), { ok: false, reason: 'WEBHOOK_AUTH_NOT_CONFIGURED' });
  const disabled = await webhookVerificationService.verifyWebhook({}, { ...dsIntegration, webhook_enabled: false }, BODY, {});
  assert.deepEqual(disabled, { ok: false, reason: 'WEBHOOK_DISABLED' });
});

test('verify: an unreadable stored secret is a 401-class failure, not a throw', async (t) => {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => { throw new Error('CREDENTIAL_DECRYPT_FAILED'); });
  assert.deepEqual(await verify({ 'x-signature': sign(SECRET) }), { ok: false, reason: 'WEBHOOK_SECRET_UNREADABLE' });
});

// ---------------------------------------------------------------- processing

const DS_LEAD_ID = '100001';

function dealerStudioHarness(t, { mgStatus = 'Not Contacted' } = {}) {
  const harness = setupOutbound(t, {
    integration: { crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads', inbound_enabled: true, webhook_enabled: true },
    mapping: { external_crm_lead_id: DS_LEAD_ID },
    lead: { lead_status: mgStatus },
  });
  harness.db.tables.integration_field_mappings.splice(0, Infinity,
    ...[['enquiry_id', 'fields.enquiry_id'], ['email_address', 'email'], ['mobile_number', 'phone'], ['lead_status', 'status']]
      .map(([source_field, target_field]) => ({ integration_id: '1000', source_field, target_field, data_type: 'string', required: false })));
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...[
    ['working', 'Contacted'], ['lost', 'Lost Lead'], ['new', 'Not Contacted'],
  ].map(([source_status, target_status]) => ({ integration_id: '1000', source_status, target_status, direction: 'EXTERNAL_TO_ZOHO' })));
  harness.db.tables.notifications = [];
  return harness;
}

const receive = (harness, payload) =>
  crmIntegrationService.processInboundWebhook(harness.db.app, harness.integration, payload, oemCrmService);

test('a cluster whose status type is Working moves the MG lead to Contacted', async (t) => {
  const harness = dealerStudioHarness(t);
  const result = await receive(harness, { id: 200001, status: 'Contacted', status_type: 'Working', leads: [{ id: Number(DS_LEAD_ID) }] });
  assert.equal(result.ok, true);
  assert.equal(result.held, undefined);
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Contacted' } }]);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Contacted');
});

test('a Lost cluster moves the MG lead to Lost Lead', async (t) => {
  const harness = dealerStudioHarness(t);
  await receive(harness, { id: 200001, status_type: 'lost', leads: [{ id: DS_LEAD_ID }] });
  assert.equal(harness.db.tables.leads[0].lead_status, 'Lost Lead');
});

test('a cluster post with no status (a contact edit, an event) is acknowledged and changes nothing', async (t) => {
  const harness = dealerStudioHarness(t);
  const result = await receive(harness, { id: 200001, contact: { first_name: 'Sam' }, leads: [{ id: DS_LEAD_ID }] });
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'NO_STATUS_IN_WEBHOOK' });
  assert.deepEqual(harness.oemWrites, []);
  assert.equal(harness.db.tables.leads[0].lead_status, 'Not Contacted');
});

test('the cluster id is used only when none of the lead ids match', async (t) => {
  const harness = dealerStudioHarness(t);
  // MG stored the cluster id for this lead; leads[] carries other ids.
  harness.db.tables.lead_integrations[0].external_crm_lead_id = '200001';
  await receive(harness, { id: 200001, status_type: 'working', leads: [{ id: 999 }] });
  assert.equal(harness.db.tables.leads[0].lead_status, 'Contacted');
});

test('a cluster id that equals another lead id does not hijack it when a lead id matches', async (t) => {
  const harness = dealerStudioHarness(t);
  // A different MG lead (ZL2) happens to hold the id that is this cluster's root id.
  harness.db.tables.lead_integrations.push({
    integration_id: '1000', zoho_lead_id: 'ZL2', dealer_code: 'AU999', external_crm_lead_id: '555', sync_status: 'SYNCED',
  });
  harness.db.tables.leads.push({ ...LEAD, crm_record_id: 'ZL2', enquiry_id: 'ENQ-2', sync_status: 'SYNCED' });
  await receive(harness, { id: 555, status_type: 'working', leads: [{ id: DS_LEAD_ID }] });
  assert.deepEqual(harness.oemWrites.map((w) => w.zohoLeadId), ['ZL1']);
  assert.equal(harness.db.tables.leads[1].lead_status, 'Not Contacted');
});

test('a cluster with several of our leads applies the status to each', async (t) => {
  const harness = dealerStudioHarness(t);
  harness.db.tables.lead_integrations.push({
    integration_id: '1000', zoho_lead_id: 'ZL2', dealer_code: 'AU999', external_crm_lead_id: '100002', sync_status: 'SYNCED',
  });
  harness.db.tables.leads.push({ ...LEAD, crm_record_id: 'ZL2', enquiry_id: 'ENQ-2', sync_status: 'SYNCED' });
  const result = await receive(harness, { id: 200001, status_type: 'working', leads: [{ id: DS_LEAD_ID }, { id: '100002' }] });
  assert.equal(result.leads, 2);
  assert.deepEqual(harness.oemWrites.map((w) => w.zohoLeadId).sort(), ['ZL1', 'ZL2']);
});

test('a body with no lead or cluster id is a FIELD_MAPPING_INVALID error', async (t) => {
  const harness = dealerStudioHarness(t);
  await assert.rejects(() => receive(harness, { status_type: 'working' }), (err) => err.code === 'FIELD_MAPPING_INVALID');
  assert.deepEqual(harness.oemWrites, []);
});

test('a cluster MG has no lead for is LEAD_MAPPING_NOT_FOUND (the route holds it as pending) and writes nothing to MG', async (t) => {
  const harness = dealerStudioHarness(t);
  await assert.rejects(
    () => receive(harness, { id: 424242, status_type: 'working', leads: [{ id: 888888 }] }),
    (err) => err.code === 'LEAD_MAPPING_NOT_FOUND'
  );
  assert.deepEqual(harness.oemWrites, []);
});

// --------------------------------------------------------------------- route

const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const webhookRoutes = require('../routes/webhookRoutes');

async function routeSetup(t, { inboundEnabled = true, creds = { WEBHOOK_SIGNING_SECRET: SECRET } } = {}) {
  t.mock.method(catalyst, 'initialize', () => ({}));
  t.mock.method(crmIntegrationService, 'findDealerByCode', async (app, code) => ({ dealer_code: code }));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async (app, code) => ({
    ...dsIntegration, dealer_code: code, integration_type: 'EXTERNAL_CRM', status: 'ACTIVE', inbound_enabled: inboundEnabled,
  }));
  withCredentials(t, creds);
  t.mock.method(crmIntegrationService, 'checkAndRecordWebhookEvent', async () => ({ isDuplicate: false, eventRowId: 'ev1' }));
  t.mock.method(crmIntegrationService, 'markWebhookEventStatus', async () => {});
  const processed = [];
  t.mock.method(crmIntegrationService, 'processInboundWebhook', async (app, integration, payload) => {
    processed.push(payload);
    return { ok: true };
  });
  const server = express();
  server.use(webhookRoutes);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  const post = async (raw, headers) => {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/AU999`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: raw,
    });
    return { status: response.status, body: await response.json() };
  };
  return { post, processed };
}

test('route: a signed cluster post is accepted, answered in JSON and processed', async (t) => {
  const { post, processed } = await routeSetup(t);
  const raw = JSON.stringify({ id: 200001, status_type: 'working', leads: [{ id: 100001 }] });
  const res = await post(raw, { 'X-Signature': sign(SECRET, Buffer.from(raw)) });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, result: { ok: true } });
  assert.equal(processed.length, 1);
  assert.equal(processed[0].id, 200001);
});

test('route: a bad signature is a 401 and nothing is processed', async (t) => {
  const { post, processed } = await routeSetup(t);
  const raw = JSON.stringify({ id: 1, status_type: 'working' });
  const res = await post(raw, { 'X-Signature': sign('wrong', Buffer.from(raw)) });
  assert.equal(res.status, 401);
  assert.equal(res.body.error, 'WEBHOOK_AUTH_FAILED');
  assert.equal(processed.length, 0);
});

test('route: an unsigned post is a 401 once a signing secret is stored', async (t) => {
  const { post, processed } = await routeSetup(t, { creds: { WEBHOOK_SIGNING_SECRET: SECRET, WEBHOOK_SECRET: TOKEN } });
  const res = await post(JSON.stringify({ id: 1, status_type: 'working' }), { 'X-Authorization': TOKEN });
  assert.equal(res.status, 401);
  assert.equal(processed.length, 0);
});

test('route: a dealer with inbound switched off is a 404', async (t) => {
  const { post, processed } = await routeSetup(t, { inboundEnabled: false });
  const raw = JSON.stringify({ id: 1, status_type: 'working' });
  const res = await post(raw, { 'X-Signature': sign(SECRET, Buffer.from(raw)) });
  assert.equal(res.status, 404);
  assert.equal(processed.length, 0);
});

// -------------------------------------------------- saving the configuration

const dealerCrmIntegrationRoutes = require('../routes/dealerCrmIntegrationRoutes');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');

async function saveConfig(t, db, body) {
  t.mock.method(catalyst, 'initialize', () => db.app);
  const saved = [];
  t.mock.method(integrationAuthService, 'saveCredential', async (app, id, type, value) => { saved.push({ type, value }); });
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => {
    res.locals.currentUser = { email_id: 'a@example.com', role_details: { role_id: ADMIN_ROLE_ID } };
    next();
  });
  server.use(dealerCrmIntegrationRoutes);
  const listener = await new Promise((resolve) => { const l = server.listen(0, '127.0.0.1', () => resolve(l)); });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/AU999/integration`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json(), saved };
}

const dsConfig = {
  integration_type: 'EXTERNAL_CRM', crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8',
  auth_type: 'API_KEY', credential: 'the-api-key', webhook_enabled: true, webhook_signing_secret: '  the-signing-secret  ',
};

test('saving a Dealer Studio dealer: Bearer key, default paths, inbound on, API key and signing secret stored', async (t) => {
  const { db } = dealerStudioHarness(t);
  const res = await saveConfig(t, db, dsConfig);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const row = db.tables.dealer_integrations[0];
  assert.equal(row.crm_type, 'DEALER_STUDIO');
  assert.equal(row.auth_type, 'BEARER_TOKEN');
  assert.equal(row.create_lead_endpoint, '/api/v1/leads');
  assert.equal(row.inbound_enabled, true);
  assert.deepEqual(res.saved, [
    { type: 'BEARER_TOKEN', value: 'the-api-key' },
    { type: 'WEBHOOK_SIGNING_SECRET', value: 'the-signing-secret' },
  ]);
});

test('saving with the webhook toggle off turns inbound off; a blank signing secret leaves the stored one alone', async (t) => {
  const { db } = dealerStudioHarness(t);
  const res = await saveConfig(t, db, { ...dsConfig, webhook_enabled: false, webhook_signing_secret: '   ' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(db.tables.dealer_integrations[0].inbound_enabled, false);
  assert.deepEqual(res.saved.map((c) => c.type), ['BEARER_TOKEN']);
});

test('an over-long signing secret is refused before anything is written', async (t) => {
  const { db } = dealerStudioHarness(t);
  const res = await saveConfig(t, db, { ...dsConfig, webhook_signing_secret: 'x'.repeat(600) });
  assert.equal(res.status, 400);
  assert.equal(res.body.field, 'webhook_signing_secret');
  assert.deepEqual(res.saved, []);
});
