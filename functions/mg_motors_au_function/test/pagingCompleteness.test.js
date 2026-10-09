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
const zohoAuthService = require('../services/zohoAuthService');
const dealerSyncService = require('../services/dealerSyncService');
const leadSyncService = require('../services/leadSyncService');
const adminDashboardService = require('../services/adminDashboardService');

// Services that must see EVERY row of a table (to decide what is new, changed
// or removed) used either a bare SELECT — which silently stops at 300 rows — or
// an unordered loop with Catalyst's 1-based LIMIT offset, which re-reads a row
// at the first page boundary. These tests run them on tables larger than one
// page and check that every row is seen exactly once.

const DEALER_COUNT = 350;

function dealerFixtures(count) {
  const crm = Array.from({ length: count }, (_, i) => ({
    id: `crm-${i}`, Name: `Dealer ${i}`, Dealer_Code: 100000 + i, Phone_Number: '0300000000',
    Email: `d${i}@example.com`, Dealer_Region: 'VIC', Dealer_State: 'VIC', City_Suburb: 'Melbourne', Dealer_Stage: 'Active',
  }));
  const rows = crm.map((r) => ({
    dealer_code: String(r.Dealer_Code), dealer_name: r.Name, phone_number: r.Phone_Number, email_address: r.Email,
    region: r.Dealer_Region, state: r.Dealer_State, city: r.City_Suburb, status: r.Dealer_Stage,
    crm_record_id: r.id, sync_status: 'Synced', last_synced_at: '2026-10-01 00:00:00',
  }));
  return { crm, rows };
}

function mockZoho(t, crmRecords) {
  zohoAuthService._resetForTests();
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'get', async () => ({ data: { data: crmRecords, info: { more_records: false } } }));
}

test('a bare SELECT of the dealers table really does stop at 300 (the cut-off being fixed)', async () => {
  const { rows } = dealerFixtures(DEALER_COUNT);
  const db = createInMemoryZcql({ dealers: rows });
  const bare = await db.app.zcql().executeZCQLQuery('SELECT * FROM dealers');
  assert.equal(bare.length, 300);
});

test('dealer sync with 350 dealers sees all of them: nothing re-inserted, nothing wrongly changed', async (t) => {
  const { crm, rows } = dealerFixtures(DEALER_COUNT);
  mockZoho(t, crm);
  const db = createInMemoryZcql({ dealers: rows, sync_logs: [], notifications: [] });

  const result = await dealerSyncService.syncDealers(db.app, { trigger: 'Manual', triggeredBy: 'test' });

  assert.equal(result.recordsInserted, 0, 'dealers beyond the 300th must not look new');
  assert.equal(result.recordsFailed, 0, 'and so must not fail on the unique dealer_code');
  assert.equal(result.recordsUpdated, 0);
  assert.equal(result.recordsRemoved, 0);
  assert.equal(result.totalRecordsFetched, DEALER_COUNT);
  assert.equal(db.tables.dealers.length, DEALER_COUNT, 'no duplicate rows were created');
});

test('dealer sync can soft-remove a dealer beyond the 300th row when the CRM no longer has it', async (t) => {
  const { crm, rows } = dealerFixtures(DEALER_COUNT);
  const gone = crm.pop(); // the 350th dealer disappears from the CRM
  mockZoho(t, crm);
  const db = createInMemoryZcql({ dealers: rows, sync_logs: [], notifications: [] });

  const result = await dealerSyncService.syncDealers(db.app, { trigger: 'Manual', triggeredBy: 'test' });

  assert.equal(result.recordsRemoved, 1);
  const removed = db.tables.dealers.find((d) => d.dealer_code === String(gone.Dealer_Code));
  assert.equal(removed.sync_status, 'Removed');
  assert.equal(db.tables.dealers.filter((d) => d.sync_status === 'Removed').length, 1);
});

test('full lead sync loader: every lead exactly once, in a stable order, with no re-read row', async () => {
  const leads = Array.from({ length: 650 }, (_, i) => ({ crm_record_id: `crm-${i}`, dealer_code: 'D1' }));
  const db = createInMemoryZcql({ leads });

  const map = await leadSyncService._test.loadExistingLeadsByCrmId(db.app);

  assert.equal(map.size, 650);
  const pageQueries = db.queries.filter((q) => q.startsWith('SELECT * FROM leads'));
  assert.ok(pageQueries.every((q) => /ORDER BY ROWID ASC LIMIT \d+, \d+$/.test(q)), 'ordered and bounded');
  assert.deepEqual(
    pageQueries.map((q) => Number(/LIMIT (\d+),/.exec(q)[1]) - 1),
    [0, 300, 600],
    'true 0-based offsets, contiguous'
  );
});

test('the shared full-table reader returns each dealer once, in ROWID order, past 300 rows', async () => {
  const dealers = Array.from({ length: 650 }, (_, i) => ({
    dealer_code: `Z${i}`, dealer_name: `Dealer ${i}`, status: 'Active', sync_status: 'Synced',
  }));
  const db = createInMemoryZcql({ dealers, leads: [], dealer_integrations: [] });

  const result = await adminDashboardService.getAllDealersWithLeadCounts(db.app);

  assert.equal(result.length, 650);
  assert.equal(new Set(result.map((d) => d.dealer_code)).size, 650);
  assert.ok(db.queries.filter((q) => q.includes('FROM dealers')).every((q) => q.includes('ORDER BY ROWID ASC')));
});
