'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const axios = require('axios');
const fusionSdAdapter = require('../services/integrations/adapters/fusionSdAdapter');
const fusionSdOAuthHelper = require('../services/integrations/adapters/fusionSdOAuthHelper');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const fixtures = require('./helpers/fusionFixtures');
const { signStandardWebhook, generateSigningSecret } = require('./helpers/standardWebhooksSigner');

// Self-tests for the Fusion test helpers that later remediation batches build
// on. They pin the helpers to Fusion's documented contract and to the published
// Standard Webhooks algorithm, not to current adapter behaviour that a later
// batch is meant to change.

// Reference vector used by the official Standard Webhooks libraries' tests.
// The secret is split so secret scanners don't flag this public test value.
const REFERENCE = {
  secret: 'whsec_' + 'MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

test('signer reproduces the Standard Webhooks reference vector', () => {
  const { secret, id, timestamp, body } = REFERENCE;
  const signed = signStandardWebhook({ secret, id, timestamp, body });

  assert.equal(signed.body, REFERENCE.body);
  assert.deepEqual(signed.headers, {
    'webhook-id': REFERENCE.id,
    'webhook-timestamp': '1614265330',
    'webhook-signature': REFERENCE.signature,
  });
});

test('signer: raw key bytes and their whsec_ form sign identically; any other string is refused', () => {
  const key = crypto.randomBytes(24);
  const event = { id: 'msg_keys', timestamp: 1700000000, body: '{}' };

  const fromBytes = signStandardWebhook({ ...event, secret: key });
  const fromWhsec = signStandardWebhook({ ...event, secret: `whsec_${key.toString('base64')}` });

  assert.equal(fromBytes.headers['webhook-signature'], fromWhsec.headers['webhook-signature']);
  assert.throws(() => signStandardWebhook({ ...event, secret: 'plain-text-secret' }), TypeError);
});

test('signer: several secrets give one v1 signature each, in order (key rotation)', () => {
  const oldSecret = generateSigningSecret();
  const newSecret = generateSigningSecret();
  const event = { id: 'msg_rotation', timestamp: 1700000000, body: '{"lead_id":"x"}' };

  const both = signStandardWebhook({ ...event, secrets: [oldSecret, newSecret] });

  assert.deepEqual(both.headers['webhook-signature'].split(' '), [
    signStandardWebhook({ ...event, secret: oldSecret }).headers['webhook-signature'],
    signStandardWebhook({ ...event, secret: newSecret }).headers['webhook-signature'],
  ]);
});

test('signer: signs exactly the body it returns, and a changed body no longer matches', () => {
  const key = crypto.randomBytes(32);
  const payload = fixtures.inboundFlatWebhookPayload();

  const signed = signStandardWebhook({ secret: key, id: 'msg_body', timestamp: 1700000000, body: payload });
  const expected = crypto.createHmac('sha256', key).update(`msg_body.1700000000.${signed.body}`).digest('base64');
  assert.equal(signed.body, JSON.stringify(payload));
  assert.equal(signed.headers['webhook-signature'], `v1,${expected}`);

  const tampered = signStandardWebhook({
    secret: key,
    id: 'msg_body',
    timestamp: 1700000000,
    body: signed.body.replace('"Open"', '"Lost"'),
  });
  assert.notEqual(tampered.headers['webhook-signature'], signed.headers['webhook-signature']);
});

test('signer: defaults to a fresh msg_ id and the current Unix time in seconds', () => {
  const before = Math.floor(Date.now() / 1000);
  const a = signStandardWebhook({ secret: generateSigningSecret(), body: '{}' });
  const b = signStandardWebhook({ secret: generateSigningSecret(), body: '{}' });
  const after = Math.floor(Date.now() / 1000);

  assert.match(a.headers['webhook-id'], /^msg_/);
  assert.notEqual(a.headers['webhook-id'], b.headers['webhook-id']);
  assert.match(a.headers['webhook-timestamp'], /^\d+$/);
  const timestamp = Number(a.headers['webhook-timestamp']);
  assert.ok(timestamp >= before && timestamp <= after);
});

function mockFusionToken(t) {
  fusionSdOAuthHelper._resetForTests();
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => 'secret');
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 600 } }));
}

test('fixtures: the 201 response follows LeadAccepted, and createLead reads its lead_id', async (t) => {
  const accepted = fixtures.leadAcceptedResponse();
  assert.equal(accepted.status, 201);
  assert.equal(accepted.data.status, 'received');
  // Same shape as the OpenAPI example id (lead_01M3CAF4DNERA16PYPNN063E4P).
  assert.match(accepted.data.lead_id, /^lead_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(!Number.isNaN(Date.parse(accepted.data.received_at)));

  mockFusionToken(t);
  t.mock.method(axios, 'request', async () => fixtures.leadAcceptedResponse());
  const result = await fusionSdAdapter.createLead(
    {},
    {
      ROWID: '9001',
      dealer_code: fixtures.FUSION_TEST_DEALER_ID,
      crm_type: 'FUSION_SD',
      // Public IP literal so the SSRF guard needs no DNS lookup (offline-safe).
      base_url: 'https://8.8.8.8/api/leadapi',
      create_lead_endpoint: '/v1/leads',
      http_method: 'POST',
    },
    { 'contact.lastName': 'Testing' }
  );

  assert.equal(result.externalLeadId, fixtures.FUSION_TEST_LEAD_ID);
  assert.equal(result.httpStatus, 201);
});

test('fixtures: LeadUpdated defaults to an applied update; overrides give manual mode and ignored fields', () => {
  const applied = fixtures.leadUpdatedResponse();
  assert.equal(applied.status, 200);
  assert.equal(applied.data.lead_id, fixtures.FUSION_TEST_LEAD_ID);
  assert.equal(applied.data.status, 'updated');
  assert.deepEqual(applied.data.updated_fields, ['status']);
  assert.equal(applied.data.update_mode, 'auto');
  assert.equal(applied.data.enquiry_linked, true);
  assert.equal('ignored_fields' in applied.data, false, 'Fusion sends ignored_fields only when it ignored something');

  assert.equal(fixtures.leadUpdatedResponse({ update_mode: 'manual' }).data.update_mode, 'manual');
  const ignored = fixtures.leadUpdatedResponse({ ignored_fields: ['privacy'] });
  assert.deepEqual(ignored.data.ignored_fields, ['privacy']);
  assert.equal(ignored.data.update_mode, 'auto');
});

test('fixtures: 403 updates_not_enabled is an axios error carrying the documented problem body', () => {
  const err = fixtures.updatesNotEnabledError();

  assert.ok(axios.isAxiosError(err));
  assert.equal(err.response.status, 403);
  assert.equal(err.response.headers['content-type'], 'application/problem+json');
  assert.deepEqual(err.response.data, {
    type: 'https://docs.fusionamspro.com/lead-api/errors/updates_not_enabled',
    title: 'Updates not enabled',
    status: 403,
    detail: 'This dealer has not enabled lead updates for this provider.',
    instance: err.response.data.instance,
  });
  assert.match(err.response.data.instance, /^lreq_/);
});

test('fixtures: 429 rate_limited carries Retry-After in seconds; every documented problem type builds', () => {
  const err = fixtures.rateLimitedError({ retryAfter: 30 });
  assert.ok(axios.isAxiosError(err));
  assert.equal(err.response.status, 429);
  assert.equal(err.response.headers['retry-after'], '30');
  assert.equal(err.response.headers.get('Retry-After'), '30');
  assert.equal(err.response.data.type, 'https://docs.fusionamspro.com/lead-api/errors/rate_limited');
  assert.equal(fixtures.rateLimitedError().response.headers['retry-after'], '60');

  for (const [slug, { status, title }] of Object.entries(fixtures.FUSION_PROBLEM_TYPES)) {
    const problem = fixtures.fusionProblemError(slug);
    assert.equal(problem.response.status, status, slug);
    assert.equal(problem.response.data.status, status, slug);
    assert.equal(problem.response.data.title, title, slug);
    assert.equal(problem.response.data.type, `https://docs.fusionamspro.com/lead-api/errors/${slug}`);
  }
  assert.throws(() => fixtures.fusionProblemError('not_a_documented_type'));
});

test('fixtures: the inbound webhook body is flat like PushedLead and matches the 201 lead_id', () => {
  const payload = fixtures.inboundFlatWebhookPayload();

  assert.deepEqual(Object.keys(payload).sort(), ['dealer_id', 'lead_id', 'pushed_at', 'status']);
  assert.ok(Object.values(payload).every((value) => typeof value === 'string'), 'no envelope or nesting');
  assert.equal(payload.lead_id, fixtures.leadAcceptedResponse().data.lead_id);
  assert.ok(!Number.isNaN(Date.parse(payload.pushed_at)));
  assert.deepEqual(
    fixtures.inboundFlatWebhookPayload({ status: 'Won', email: null }),
    { ...payload, status: 'Won', email: null }
  );
});

test('fixtures: every call builds new objects, so one test cannot leak into another', () => {
  const first = fixtures.leadUpdatedResponse();
  first.data.updated_fields.push('contact.email');
  first.data.lead_id = 'changed';
  assert.deepEqual(fixtures.leadUpdatedResponse().data.updated_fields, ['status']);
  assert.equal(fixtures.leadUpdatedResponse().data.lead_id, fixtures.FUSION_TEST_LEAD_ID);

  const payload = fixtures.inboundFlatWebhookPayload();
  payload.status = 'Lost';
  assert.equal(fixtures.inboundFlatWebhookPayload().status, 'Open');

  assert.notEqual(fixtures.rateLimitedError().response.headers, fixtures.rateLimitedError().response.headers);
});
