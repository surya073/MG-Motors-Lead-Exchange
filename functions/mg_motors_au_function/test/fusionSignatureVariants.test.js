'use strict';

// 23 Oct 2026: Fusion's webhooks for Hillcrest MG reached us with a
// Standard Webhooks signature, but it matched none of the key forms we tried
// for the stored 64-character hex secret (as text, base64-decoded). A hex
// secret is now also tried hex-decoded, and a failed signature logs which
// common slip would have produced it - a variant name only, never the secret,
// the signature or the body.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const integrationAuthService = require('../services/integrations/integrationAuthService');
const logger = require('../utils/logger');
const { verifyWebhook } = require('../services/integrations/webhookVerificationService');

const SECRET = 'ed0a398100ed3bd3ecee94991a4032e0537f41861d88583ec73294c04af15fa7'.replace(/./g, (c, i) => (i % 7 === 0 ? 'b' : c));
const INTEGRATION = { ROWID: '1001', dealer_code: '411802', crm_type: 'FUSION_SD', webhook_enabled: true };
const BODY = Buffer.from(JSON.stringify({ lead_id: 'lead_1', status: 'Open' }));

function sign(key, { id = 'msg_1', ts = String(Math.floor(Date.now() / 1000)), content } = {}) {
  const h = crypto.createHmac('sha256', key);
  (content || ((m) => m.update(`${id}.${ts}.`).update(BODY)))(h, id, ts);
  return { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${h.digest('base64')}` };
}

function setup(t, secret = SECRET) {
  const before = process.env.FUSION_INBOUND_V2;
  process.env.FUSION_INBOUND_V2 = 'true';
  t.after(() => { if (before === undefined) delete process.env.FUSION_INBOUND_V2; else process.env.FUSION_INBOUND_V2 = before; });
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => secret);
  const errors = [];
  t.mock.method(logger, 'error', (...args) => { errors.push(args.map(String).join(' ')); });
  return errors;
}

test('a signature keyed by the hex-decoded secret is accepted', async (t) => {
  setup(t);
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from(SECRET, 'hex')));
  assert.equal(result.ok, true);
});

test('the forms accepted before still are (secret as text)', async (t) => {
  setup(t);
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from(SECRET, 'utf8')));
  assert.equal(result.ok, true);
});

test('a signature from a different secret is still rejected', async (t) => {
  setup(t);
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from('another-secret-entirely', 'utf8')));
  assert.deepEqual(result, { ok: false, reason: 'INVALID_SIGNATURE' });
});

test('a pasted note label is diagnosed by name but NOT accepted; nothing secret is logged', async (t) => {
  const errors = setup(t);
  const result = await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from(`FUSIONWEBHOOKSECRET=\n${SECRET}`, 'utf8')));
  assert.deepEqual(result, { ok: false, reason: 'INVALID_SIGNATURE' });
  const line = errors.find((e) => e.includes('Signature mismatch'));
  assert.match(line, /"wouldMatch":"note-label-prefix-newline\/id\.timestamp\.body"/);
  assert.equal(line.includes(SECRET), false, 'secret never logged');
  assert.equal(line.includes('lead_1'), false, 'body never logged');
});

test('signing the body alone is diagnosed', async (t) => {
  const errors = setup(t);
  await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from(SECRET, 'utf8'), { content: (h) => h.update(BODY) }));
  assert.match(errors.find((e) => e.includes('Signature mismatch')), /"wouldMatch":"secret-as-text\/body-only"/);
});

test('an unrelated signature reports wouldMatch none with the header shape', async (t) => {
  const errors = setup(t);
  await verifyWebhook({}, INTEGRATION, BODY, sign(Buffer.from('nope', 'utf8')));
  const line = errors.find((e) => e.includes('Signature mismatch'));
  assert.match(line, /"wouldMatch":"none"/);
  assert.match(line, /"v1Entries":1/);
  assert.match(line, /"bodyBytes":\d+/);
});
