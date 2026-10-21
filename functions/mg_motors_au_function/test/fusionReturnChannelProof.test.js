'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const proof = require('../services/integrations/fusionReturnChannelProof');
const auth = require('../services/integrations/integrationAuthService');
const claim = require('../services/integrations/outboundSyncClaimService');

const INTEGRATION = { ROWID: '1000', dealer_code: 'AU999', crm_type: 'FUSION_SD' };
const SECRET = 'synthetic-signing-secret';
const AUTH = { ok: true, method: 'STANDARD_WEBHOOKS', signingSecretFingerprint: proof.signingSecretFingerprint(SECRET) };
const key = 'proof:fusion-return-channel:1000';
function database() { return createInMemoryZcql({ outbound_sync_claims: [], webhook_events: [] }); }
function row(db) { return db.tables.outbound_sync_claims.find((r) => !r.__deleted && r.claim_key === key); }
function currentSecret(t, secret = SECRET) { t.mock.method(auth, 'getDecryptedCredential', async () => secret); }

test('unsigned/token-only verification cannot create return-channel proof or issue datastore reads', async () => {
  const db = database();
  assert.equal(await proof.recordVerifiedSuccess(db.app, INTEGRATION, { ok: true }), false);
  assert.equal(await proof.recordVerifiedSuccess(db.app, { ...INTEGRATION, crm_type: 'ZOHO_CRM' }, AUTH), false);
  assert.equal(db.queries.length, 0);
  assert.equal(row(db), undefined);
});

test('signed successful processing persists small durable proof without a secret, and steady traffic never rewrites it', async (t) => {
  currentSecret(t);
  const db = database();
  assert.equal(await proof.recordVerifiedSuccess(db.app, INTEGRATION, AUTH), true);
  const stored = row(db);
  assert.ok(stored);
  assert.ok(stored.request_reference.length < 255);
  assert.ok(!stored.request_reference.includes(SECRET));
  const initial = stored.request_reference;
  // A receipt is permanent, not a five-minute operation lease.
  stored.claimed_at = '2000-01-01 00:00:00';
  assert.equal(await proof.getReturnChannelGap(db.app, INTEGRATION), null);
  const table = db.app.datastore;
  db.app.datastore = () => ({ table: () => { throw new Error('matching proof must not rewrite'); } });
  const reads = db.queries.length;
  assert.equal(await proof.recordVerifiedSuccess(db.app, INTEGRATION, AUTH), true);
  assert.equal(db.queries.length - reads, 1);
  assert.equal(stored.request_reference, initial);
  db.app.datastore = table;
});

test('proof survives successful-event retention and an independent operation claim release', async (t) => {
  currentSecret(t);
  const db = database();
  await proof.recordVerifiedSuccess(db.app, INTEGRATION, AUTH);
  db.tables.webhook_events = [];
  await claim.withOutboundSyncClaim(db.app, '1000', 'ZL1', 'operation-test', async () => true);
  assert.ok(row(db), 'the operation only releases its own namespaced key');
  assert.equal(await proof.getReturnChannelGap(db.app, INTEGRATION), null);
});

test('rotation and dealer reassignment invalidate old proof until a new signed success', async (t) => {
  let secret = SECRET;
  t.mock.method(auth, 'getDecryptedCredential', async () => secret);
  const db = database();
  await proof.recordVerifiedSuccess(db.app, INTEGRATION, AUTH);
  secret = 'new-synthetic-secret';
  assert.equal(await proof.getReturnChannelGap(db.app, INTEGRATION), 'NO_VERIFIED_WEBHOOK');
  await proof.recordVerifiedSuccess(db.app, INTEGRATION, { ...AUTH, signingSecretFingerprint: proof.signingSecretFingerprint(secret) });
  assert.equal(await proof.getReturnChannelGap(db.app, INTEGRATION), null);
  assert.equal(await proof.getReturnChannelGap(db.app, { ...INTEGRATION, dealer_code: 'OTHER' }), 'NO_VERIFIED_WEBHOOK');
  secret = null;
  assert.equal(await proof.getReturnChannelGap(db.app, INTEGRATION), 'NO_SIGNING_SECRET');
});

test('malformed and missing proofs fail closed while database read errors propagate to the SLA gate', async (t) => {
  currentSecret(t);
  const db = database();
  assert.equal(await proof.getReturnChannelGap(db.app, INTEGRATION), 'NO_VERIFIED_WEBHOOK');
  await proof.recordVerifiedSuccess(db.app, INTEGRATION, AUTH);
  row(db).request_reference = '{bad-json';
  assert.equal(await proof.getReturnChannelGap(db.app, INTEGRATION), 'NO_VERIFIED_WEBHOOK');
  db.app.zcql = () => ({ executeZCQLQuery: async () => { throw new Error('proof read unavailable'); } });
  await assert.rejects(() => proof.getReturnChannelGap(db.app, INTEGRATION), /proof read unavailable/);
  assert.equal(await proof.recordVerifiedSuccess(db.app, INTEGRATION, AUTH), false, 'proof write failure is ancillary to delivery');
});

test('concurrent unique-key insert races re-read the winner instead of duplicating proof', async () => {
  const db = database();
  const datastore = db.app.datastore;
  let attempts = 0;
  db.app.datastore = () => ({ table: (name) => {
    const real = datastore().table(name);
    return { ...real, insertRow: async (fields) => {
      attempts += 1;
      if (row(db)) throw new Error('synthetic unique collision');
      return real.insertRow(fields);
    } };
  } });
  assert.deepEqual(await Promise.all([
    proof.recordVerifiedSuccess(db.app, INTEGRATION, AUTH),
    proof.recordVerifiedSuccess(db.app, INTEGRATION, AUTH),
  ]), [true, true]);
  assert.equal(attempts, 2);
  assert.equal(db.tables.outbound_sync_claims.length, 1);
});

test('a signed duplicate proves the channel only when the identical stored event is SUCCESS', async () => {
  const db = database();
  const body = Buffer.from('{"lead_id":"lead_example","status":"Lost"}');
  const event = {
    integration_id: '1000', event_id: 'msg-1', processing_status: 'FAILED',
    payload_hash: crypto.createHash('sha256').update(body).digest('hex'),
  };
  db.tables.webhook_events.push(event);
  assert.equal(await proof.recordVerifiedDuplicate(db.app, INTEGRATION, AUTH, 'msg-1', body), false);
  assert.equal(row(db), undefined);
  event.processing_status = 'SUCCESS';
  assert.equal(await proof.recordVerifiedDuplicate(db.app, INTEGRATION, AUTH, 'msg-1', Buffer.from('different body')), false);
  assert.equal(await proof.recordVerifiedDuplicate(db.app, INTEGRATION, AUTH, 'msg-1', body), true);
  assert.ok(row(db));
});

test('an acknowledged terminal old-lead event does not establish return-channel proof on redelivery', async () => {
  const db = database();
  const body = Buffer.from('{"lead_id":"retired-lead","status":"Lost"}');
  db.tables.webhook_events.push({
    integration_id: '1000', event_id: 'msg-retired', processing_status: 'SUCCESS',
    error_message: 'TERMINAL:LEAD_REMOVED', payload_hash: crypto.createHash('sha256').update(body).digest('hex'),
  });
  assert.equal(await proof.recordVerifiedDuplicate(db.app, INTEGRATION, AUTH, 'msg-retired', body), false);
  assert.equal(row(db), undefined);
});
