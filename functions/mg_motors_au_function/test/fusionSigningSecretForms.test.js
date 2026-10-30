'use strict';

// 27 Oct 2026: every webhook from Fusion's servers was rejected. Two gaps on
// our side: Fusion issues its signing secret as `lapi_whsec_<base64>`, which
// was only ever tried as raw text (never the Standard Webhooks key, the
// base64 after `whsec_`); and the shared secret we gave Fusion via LastPass
// was never tried for signatures, only for static tokens.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const integrationAuthService = require('../services/integrations/integrationAuthService');
const logger = require('../utils/logger');
const { verifyWebhook } = require('../services/integrations/webhookVerificationService');
const { signingSecretFingerprint } = require('../services/integrations/fusionReturnChannelProof');

const KEY = crypto.randomBytes(48);
const FUSION_SECRET = `lapi_whsec_${KEY.toString('base64')}`;
const SHARED = crypto.randomBytes(32).toString('hex');
const INTEGRATION = { ROWID: '1001', dealer_code: '411802', crm_type: 'FUSION_SD', webhook_enabled: true };
// Lost is documented by Fusion and appears in its 28 October sample.
// Authentication fixtures must not imply an undocumented business status.
const BODY = Buffer.from(JSON.stringify({ leadId: 'lead_1', enquiryStatus: 'Lost' }));

function sign(key, id = 'msg_1') {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.`).update(BODY).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
}

function setup(t, { secret = FUSION_SECRET, sharedCodes = '' } = {}) {
  const env = { FUSION_INBOUND_V2: 'true', FUSION_WEBHOOK_SECRET: SHARED, FUSION_WEBHOOK_DEALER_CODES: sharedCodes };
  for (const [name, value] of Object.entries(env)) {
    const before = process.env[name];
    process.env[name] = value;
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
  }
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => secret);
  const logs = [];
  t.mock.method(logger, 'error', (...args) => { logs.push(args.map(String).join(' ')); });
  t.mock.method(logger, 'info', (...args) => { logs.push(args.map(String).join(' ')); });
  return logs;
}

test('lapi_whsec_<base64>: a signature keyed by the decoded part after whsec_ is accepted', async (t) => {
  const logs = setup(t);
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(KEY));
  assert.equal(result.ok, true);
  assert.equal(result.signingSecretFingerprint, signingSecretFingerprint(FUSION_SECRET));
  assert.ok(logs.some((l) => l.includes('with dealer/prefixed-whsec')));
});

test('lapi_whsec_<base64>: the whole string as text still works', async (t) => {
  setup(t);
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from(FUSION_SECRET, 'utf8')));
  assert.equal(result.ok, true);
});

test('the shared secret is accepted for a dealer FUSION_WEBHOOK_DEALER_CODES lists', async (t) => {
  const logs = setup(t, { sharedCodes: '568026, 411802' });
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from(SHARED, 'utf8')));
  assert.equal(result.ok, true);
  // Proof of the dealer's own secret is not claimed for the shared one.
  assert.equal(result.signingSecretFingerprint, signingSecretFingerprint(SHARED));
  assert.ok(logs.some((l) => l.includes('with shared/text')));
});

test('the shared secret is NOT accepted for a dealer the env var does not list', async (t) => {
  setup(t, { sharedCodes: '568026' });
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from(SHARED, 'utf8')));
  assert.deepEqual(result, { ok: false, reason: 'INVALID_SIGNATURE' });
});

test('a wrong key is still rejected, and the log names the delivery without the secret or body', async (t) => {
  const logs = setup(t, { sharedCodes: '411802' });
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(crypto.randomBytes(32), 'msg_fusion_42'));
  assert.deepEqual(result, { ok: false, reason: 'INVALID_SIGNATURE' });
  const line = logs.find((l) => l.includes('Signature mismatch'));
  assert.match(line, /"webhookId":"msg_fusion_42"/);
  assert.match(line, /"bodySha256":"[0-9a-f]{16}"/);
  assert.match(line, /"candidates":\["dealer\/text","dealer\/prefixed-whsec","shared\/text","shared\/base64","shared\/hex"\]/);
  for (const secret of [FUSION_SECRET, KEY.toString('base64'), SHARED]) assert.equal(line.includes(secret), false);
  assert.equal(line.includes('lead_1'), false);
});
