'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const dealerSyncService = require('../services/dealerSyncService');
const operationClaims = require('../services/integrations/integrationOperationClaimService');
const zohoAuthService = require('../services/zohoAuthService');

// COST_OPTIMIZATION_PLAN.md (23 Oct 2026): a bulk edit of MG's Dealers module
// sends ~213 crm-notify calls in 4 minutes at 05:00 IST; each ran a full
// syncDealers (2 CRM calls + every dealers row) and none changed anything.
// Overlapping runs could also write a stale CRM read over a newer one.

const base = { Phone_Number: '1', Email: 'a@b.c', Dealer_Region: 'VIC', Dealer_State: 'VIC', City_Suburb: 'M', Dealer_Stage: 'Active' };
const OP = dealerSyncService._test.DEALER_SYNC_OPERATION;
const { keyFor, pendingKeyFor } = operationClaims._test;

function fixture(dealers = []) {
  return createInMemoryZcql({ dealers, outbound_sync_claims: [], sync_logs: [] }, { enforceUnique: true });
}

const live = (db, table) => db.tables[table].filter((row) => !row.__deleted);
const claimRow = (db, key) => live(db, 'outbound_sync_claims').find((row) => row.claim_key === key);
const expireLease = (db) => { claimRow(db, keyFor(OP)).claimed_at = '2000-01-01 00:00:00'; };

function mockCrm(t, respond) {
  zohoAuthService._resetForTests();
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  return t.mock.method(axios, 'get', async () => ({ data: { data: await respond(), info: { more_records: false } } }));
}

test('a burst of Dealers notifications runs one sync and leaves one pending marker', async (t) => {
  const db = fixture();
  const crm = mockCrm(t, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return [{ ...base, Name: 'Buckby MG', Dealer_Code: 725001, id: 'c1' }];
  });

  const results = await Promise.all(Array.from({ length: 25 }, () =>
    dealerSyncService.syncDealersCoalesced(db.app, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' })));

  assert.equal(results.filter((r) => r.skipped).length, 24);
  assert.equal(crm.mock.callCount(), 1, 'one CRM fetch for the whole burst');
  assert.equal(live(db, 'sync_logs').length, 1);
  assert.ok(claimRow(db, keyFor(OP)), 'the claim is kept for its lease');
  assert.equal(live(db, 'outbound_sync_claims').filter((r) => r.claim_key === pendingKeyFor(OP)).length, 1);

  // Later notifications inside the lease stay cheap: no CRM call, no dealers read.
  const before = db.queries.length;
  const late = await dealerSyncService.syncDealersCoalesced(db.app, { trigger: 'Webhook' });
  assert.equal(late.skipped, true);
  assert.equal(crm.mock.callCount(), 1);
  assert.equal(db.queries.slice(before).some((q) => /FROM dealers/.test(q)), false);
});

test('overlapping notifications can no longer write a stale CRM read over a newer one', async (t) => {
  const db = fixture([{ dealer_code: '725001', dealer_name: 'Old Name', phone_number: '1', email_address: 'a@b.c', region: 'VIC', state: 'VIC', city: 'M', status: 'Active', crm_record_id: 'c1', sync_status: 'Synced' }]);
  let release;
  const slowFirstRead = new Promise((resolve) => { release = resolve; });
  let call = 0;
  mockCrm(t, async () => {
    call += 1;
    if (call === 1) { await slowFirstRead; return [{ ...base, Name: 'Old Name', Dealer_Code: 725001, id: 'c1' }]; }
    return [
      { ...base, Name: 'New Name', Dealer_Code: 725001, id: 'c1' },
      { ...base, Name: 'Brand New Dealer', Dealer_Code: 411802, id: 'c2' },
    ];
  });

  const first = dealerSyncService.syncDealersCoalesced(db.app, { trigger: 'Webhook' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await dealerSyncService.syncDealersCoalesced(db.app, { trigger: 'Webhook' });
  assert.equal(second.skipped, true, 'the second notification waits for the trailing sync');
  release();
  await first;

  // fast-recover after the lease: the trailing sync applies Zoho's current data.
  expireLease(db);
  const trailing = await dealerSyncService.runPendingDealerSync(db.app);
  assert.equal(trailing.status, 'Success');
  assert.deepEqual(
    live(db, 'dealers').map((r) => [r.dealer_code, r.dealer_name, r.sync_status]),
    [['725001', 'New Name', 'Synced'], ['411802', 'Brand New Dealer', 'Synced']],
  );
  assert.equal(claimRow(db, pendingKeyFor(OP)), undefined, 'the pending marker is cleared');
});

test('fast-recover with nothing pending costs one query and no writes or CRM calls', async (t) => {
  const db = fixture();
  const crm = mockCrm(t, async () => []);
  const result = await dealerSyncService.runPendingDealerSync(db.app);
  assert.deepEqual(result, { pending: false });
  assert.equal(db.queries.length, 1);
  assert.equal(crm.mock.callCount(), 0);
  assert.equal(live(db, 'outbound_sync_claims').length, 0);
});

test('a pending sync waits while the lease is fresh, then runs once', async (t) => {
  const db = fixture();
  const crm = mockCrm(t, async () => [{ ...base, Name: 'Buckby MG', Dealer_Code: 725001, id: 'c1' }]);
  await dealerSyncService.syncDealersCoalesced(db.app, { trigger: 'Webhook' });
  await dealerSyncService.syncDealersCoalesced(db.app, { trigger: 'Webhook' }); // skipped -> pending
  assert.equal(crm.mock.callCount(), 1);

  const deferred = await dealerSyncService.runPendingDealerSync(db.app);
  assert.equal(deferred.skipped, true);
  assert.equal(crm.mock.callCount(), 1, 'no sync inside the lease');

  expireLease(db);
  const ran = await dealerSyncService.runPendingDealerSync(db.app);
  assert.equal(ran.status, 'Success');
  assert.equal(crm.mock.callCount(), 2);
  assert.deepEqual(await dealerSyncService.runPendingDealerSync(db.app), { pending: false });
});

test('a failed sync stays pending so fast-recover retries it after the lease', async (t) => {
  const db = fixture();
  zohoAuthService._resetForTests();
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'get', async () => { throw Object.assign(new Error('CRM down'), { response: { status: 503 } }); });

  await assert.rejects(dealerSyncService.syncDealersCoalesced(db.app, { trigger: 'Webhook' }));
  assert.ok(claimRow(db, pendingKeyFor(OP)), 'marked pending after the failure');
});
