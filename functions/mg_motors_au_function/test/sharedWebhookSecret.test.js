'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const integrationAuthService = require('../services/integrations/integrationAuthService');
const { verifyWebhook, computeHmac } = require('../services/integrations/webhookVerificationService');

const SHARED = 'shared-secret-for-fusion-0123456789abcdef';
const OWN = 'own-secret-of-the-dealer-0123456789abcdef';
const body = Buffer.from(JSON.stringify({ leadId: 'lead_1', enquiryStatus: 'Won' }));
const integration = (dealer_code) => ({ ROWID: '1', dealer_code, webhook_enabled: true });

function setup(t, { own = OWN, unreadable = false, shared = SHARED, codes = 'AU999' } = {}) {
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async () => {
    if (unreadable) throw new Error('decrypt failed');
    return own;
  });
  const saved = { s: process.env.FUSION_WEBHOOK_SECRET, c: process.env.FUSION_WEBHOOK_DEALER_CODES };
  if (shared) process.env.FUSION_WEBHOOK_SECRET = shared; else delete process.env.FUSION_WEBHOOK_SECRET;
  process.env.FUSION_WEBHOOK_DEALER_CODES = codes;
  t.after(() => {
    if (saved.s === undefined) delete process.env.FUSION_WEBHOOK_SECRET; else process.env.FUSION_WEBHOOK_SECRET = saved.s;
    if (saved.c === undefined) delete process.env.FUSION_WEBHOOK_DEALER_CODES; else process.env.FUSION_WEBHOOK_DEALER_CODES = saved.c;
  });
}
const bearer = (s) => ({ authorization: `Bearer ${s}` });
const signed = (s) => ({ 'x-webhook-signature': `sha256=${computeHmac(s, body)}` });

test('the shared secret is accepted (bearer and HMAC) for a dealer listed in FUSION_WEBHOOK_DEALER_CODES, case-insensitively', async (t) => {
  setup(t, { codes: 'au1, AU999 ' });
  assert.equal((await verifyWebhook({}, integration('au999'), body, bearer(SHARED))).ok, true);
  assert.equal((await verifyWebhook({}, integration('AU999'), body, signed(SHARED))).ok, true);
});

test('the dealer\'s own secret keeps working alongside the shared one', async (t) => {
  setup(t);
  assert.equal((await verifyWebhook({}, integration('AU999'), body, bearer(OWN))).ok, true);
});

test('the shared secret is NOT accepted for a dealer that is not listed', async (t) => {
  setup(t, { codes: 'AU999' });
  const result = await verifyWebhook({}, integration('AU008'), body, bearer(SHARED));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INVALID_TOKEN');
  assert.equal((await verifyWebhook({}, integration('AU008'), body, signed(SHARED))).ok, false);
});

test('a wrong secret is rejected for a listed dealer', async (t) => {
  setup(t);
  assert.equal((await verifyWebhook({}, integration('AU999'), body, bearer('nope'))).ok, false);
  assert.equal((await verifyWebhook({}, integration('AU999'), body, signed('nope'))).ok, false);
});

test('feature off: no shared secret set means nothing changes', async (t) => {
  setup(t, { shared: '', codes: 'AU999' });
  assert.equal((await verifyWebhook({}, integration('AU999'), body, bearer(SHARED))).ok, false);
  assert.equal((await verifyWebhook({}, integration('AU999'), body, bearer(OWN))).ok, true);
});

test('a listed dealer with no own secret (or an unreadable one) can still authenticate with the shared secret', async (t) => {
  setup(t, { own: null });
  assert.equal((await verifyWebhook({}, integration('AU999'), body, bearer(SHARED))).ok, true);
});

test('an unlisted dealer with no secret at all is still refused, with the same reasons as before', async (t) => {
  setup(t, { own: null, codes: 'AU999' });
  assert.equal((await verifyWebhook({}, integration('AU008'), body, bearer(SHARED))).reason, 'WEBHOOK_AUTH_NOT_CONFIGURED');
  setup(t, { unreadable: true, codes: 'AU999' });
  assert.equal((await verifyWebhook({}, integration('AU008'), body, bearer(SHARED))).reason, 'WEBHOOK_SECRET_UNREADABLE');
});

test('X-Webhook-Token (and X-Api-Key) carry the secret, because Catalyst blocks Authorization: Bearer before our code runs', async (t) => {
  setup(t);
  const viaToken = (s) => ({ 'x-webhook-token': s });
  assert.equal((await verifyWebhook({}, integration('AU999'), body, viaToken(SHARED))).ok, true);
  assert.equal((await verifyWebhook({}, integration('AU999'), body, { 'x-api-key': SHARED })).ok, true);
  assert.equal((await verifyWebhook({}, integration('AU999'), body, viaToken(OWN))).ok, true);
  assert.equal((await verifyWebhook({}, integration('AU999'), body, viaToken('nope'))).reason, 'INVALID_TOKEN');
  // Not accepted for a dealer the shared secret is not scoped to.
  assert.equal((await verifyWebhook({}, integration('AU008'), body, viaToken(SHARED))).ok, false);
});
