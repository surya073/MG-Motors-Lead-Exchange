'use strict';

// Batch 5 (FUSION_REMEDIATION_PLAN.md): Fusion SD signs webhooks the
// Standard Webhooks way (lead-api-mg-motors-openapi 3.yaml, `webhooks`):
// base64 HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}`, keyed by
// the dealer's signing secret, sent as `v1,<signature>` (space-separated
// when the secret is being rotated); anything over five minutes old is
// refused. Behind FUSION_INBOUND_V2, Fusion SD only (Q19: an X-Webhook-Token
// sent alongside must also match).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const integrationAuthService = require('../services/integrations/integrationAuthService');
const webhookVerificationService = require('../services/integrations/webhookVerificationService');
const { signingSecretFingerprint } = require('../services/integrations/fusionReturnChannelProof');

const KEY = crypto.randomBytes(24);
const SIGNING_SECRET = `whsec_${KEY.toString('base64')}`;
const TOKEN_SECRET = 'static-token-secret';
const accepted = (secret = SIGNING_SECRET) => ({ ok: true, method: 'STANDARD_WEBHOOKS', signingSecretFingerprint: signingSecretFingerprint(secret) });
const FUSION = { ROWID: '1000', dealer_code: '725001', crm_type: 'FUSION_SD', webhook_enabled: true };
const BODY = Buffer.from(JSON.stringify({ lead_id: 'lead_01ABC', status: 'Lost' }));

function sign(key, id, timestamp, body) {
  return crypto.createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest('base64');
}

function signedHeaders({ key = KEY, id = 'msg_1', timestamp = Math.floor(Date.now() / 1000), body = BODY } = {}) {
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${sign(key, id, timestamp, body)}`,
  };
}

function setup(t, { flag = 'true', credentials = { WEBHOOK_SIGNING_SECRET: SIGNING_SECRET } } = {}) {
  const before = process.env.FUSION_INBOUND_V2;
  if (flag === null) delete process.env.FUSION_INBOUND_V2;
  else process.env.FUSION_INBOUND_V2 = flag;
  t.after(() => {
    if (before === undefined) delete process.env.FUSION_INBOUND_V2;
    else process.env.FUSION_INBOUND_V2 = before;
  });
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (app, id, type) => {
    const value = credentials[type];
    if (value instanceof Error) throw value;
    return value ?? null;
  });
}

const verify = (headers, body = BODY, integration = FUSION) =>
  webhookVerificationService.verifyWebhook({}, integration, body, headers);

test('a correctly signed, fresh Fusion webhook is accepted', async (t) => {
  setup(t);
  assert.deepEqual(await verify(signedHeaders()), accepted());
});

test('a tampered body is refused', async (t) => {
  setup(t);
  const headers = signedHeaders();
  const tampered = Buffer.from(JSON.stringify({ lead_id: 'lead_01ABC', status: 'Open' }));
  assert.deepEqual(await verify(headers, tampered), { ok: false, reason: 'INVALID_SIGNATURE' });
});

test('a signature made with a different secret is refused', async (t) => {
  setup(t);
  assert.deepEqual(await verify(signedHeaders({ key: crypto.randomBytes(24) })), { ok: false, reason: 'INVALID_SIGNATURE' });
});

test('a changed webhook-id or timestamp breaks the signature', async (t) => {
  setup(t);
  const headers = signedHeaders();
  assert.equal((await verify({ ...headers, 'webhook-id': 'msg_2' })).reason, 'INVALID_SIGNATURE');
  const now = Number(headers['webhook-timestamp']);
  assert.equal((await verify({ ...headers, 'webhook-timestamp': String(now - 1) })).reason, 'INVALID_SIGNATURE');
});

test('a timestamp more than five minutes old, or ahead, is refused even when signed', async (t) => {
  setup(t);
  const now = Math.floor(Date.now() / 1000);
  assert.deepEqual(await verify(signedHeaders({ timestamp: now - 301 })), { ok: false, reason: 'STALE_TIMESTAMP' });
  assert.deepEqual(await verify(signedHeaders({ timestamp: now + 301 })), { ok: false, reason: 'STALE_TIMESTAMP' });
  assert.deepEqual(await verify(signedHeaders({ timestamp: now - 290 })), accepted());
});

test('a missing or non-numeric webhook-id / webhook-timestamp is refused', async (t) => {
  setup(t);
  const headers = signedHeaders();
  const { 'webhook-id': _id, ...noId } = headers;
  assert.equal((await verify(noId)).ok, false);
  assert.equal((await verify({ ...headers, 'webhook-timestamp': 'yesterday' })).reason, 'STALE_TIMESTAMP');
});

test('during secret rotation any listed v1 signature is accepted; other schemes are ignored', async (t) => {
  setup(t);
  const headers = signedHeaders();
  const good = headers['webhook-signature'];
  const otherKey = `v1,${sign(crypto.randomBytes(24), 'msg_1', headers['webhook-timestamp'], BODY)}`;
  assert.deepEqual(await verify({ ...headers, 'webhook-signature': `${otherKey} ${good}` }), accepted());
  const asV2 = good.replace(/^v1,/, 'v2,');
  assert.equal((await verify({ ...headers, 'webhook-signature': `${otherKey} ${asV2}` })).reason, 'INVALID_SIGNATURE');
});

test('a signing secret saved without the whsec_ prefix is used as given', async (t) => {
  const plain = 'a-plain-signing-secret';
  setup(t, { credentials: { WEBHOOK_SIGNING_SECRET: plain } });
  assert.deepEqual(await verify(signedHeaders({ key: Buffer.from(plain, 'utf8') })), accepted(plain));
});

test('a base64 signing secret saved without the prefix also works decoded (encoding unconfirmed, Q20)', async (t) => {
  setup(t, { credentials: { WEBHOOK_SIGNING_SECRET: KEY.toString('base64') } });
  assert.deepEqual(await verify(signedHeaders()), accepted(KEY.toString('base64')));
});

test('a Fusion dealer with no signing secret is refused with a clear reason', async (t) => {
  setup(t, { credentials: { WEBHOOK_SECRET: TOKEN_SECRET } });
  assert.deepEqual(await verify(signedHeaders()), { ok: false, reason: 'WEBHOOK_SIGNING_SECRET_MISSING' });
});

test('an unreadable signing secret is a 401 reason, not a crash', async (t) => {
  setup(t, { credentials: { WEBHOOK_SIGNING_SECRET: new Error('CREDENTIAL_DECRYPT_FAILED') } });
  assert.deepEqual(await verify(signedHeaders()), { ok: false, reason: 'WEBHOOK_SECRET_UNREADABLE' });
});

test('Q19: an X-Webhook-Token sent with a valid signature must also match', async (t) => {
  setup(t, { credentials: { WEBHOOK_SIGNING_SECRET: SIGNING_SECRET, WEBHOOK_SECRET: TOKEN_SECRET } });
  const headers = signedHeaders();
  assert.deepEqual(await verify({ ...headers, 'x-webhook-token': TOKEN_SECRET }), accepted());
  assert.deepEqual(await verify({ ...headers, 'x-webhook-token': 'wrong' }), { ok: false, reason: 'INVALID_TOKEN' });
  assert.deepEqual(await verify(headers), accepted(), 'the token is optional when not sent');
});

test('a webhook disabled on the integration is refused before any signature check', async (t) => {
  setup(t);
  assert.deepEqual(await verify(signedHeaders(), BODY, { ...FUSION, webhook_enabled: false }), { ok: false, reason: 'WEBHOOK_DISABLED' });
});

test('flag off: a Fusion webhook with only Standard Webhooks headers is refused as today (MISSING_AUTH)', async (t) => {
  setup(t, { flag: null, credentials: { WEBHOOK_SIGNING_SECRET: SIGNING_SECRET, WEBHOOK_SECRET: TOKEN_SECRET } });
  assert.deepEqual(await verify(signedHeaders()), { ok: false, reason: 'MISSING_AUTH' });
  assert.deepEqual(await verify({ 'x-webhook-token': TOKEN_SECRET }), { ok: true }, 'the token path is unchanged');
});

test('flag on: a static token cannot bypass the required Fusion signature', async (t) => {
  setup(t, { credentials: { WEBHOOK_SECRET: TOKEN_SECRET } });
  assert.deepEqual(await verify({ 'x-webhook-token': TOKEN_SECRET }), { ok: false, reason: 'MISSING_AUTH' });
  assert.deepEqual(await verify({ 'x-webhook-token': 'wrong' }), { ok: false, reason: 'MISSING_AUTH' });
  const withoutSignature = signedHeaders();
  delete withoutSignature['webhook-signature'];
  assert.deepEqual(await verify({ ...withoutSignature, 'x-webhook-token': TOKEN_SECRET }), { ok: false, reason: 'MISSING_AUTH' });
});

test('flag on: ZOHO_CRM and GENERIC_REST dealers never use the Standard Webhooks check', async (t) => {
  setup(t, { credentials: { WEBHOOK_SIGNING_SECRET: SIGNING_SECRET, WEBHOOK_SECRET: TOKEN_SECRET } });
  for (const crmType of ['ZOHO_CRM', 'GENERIC_REST']) {
    const integration = { ...FUSION, crm_type: crmType };
    assert.deepEqual(await verify(signedHeaders(), BODY, integration), { ok: false, reason: 'MISSING_AUTH' }, crmType);
    assert.deepEqual(await verify({ 'x-webhook-token': TOKEN_SECRET }, BODY, integration), { ok: true }, crmType);
  }
});
