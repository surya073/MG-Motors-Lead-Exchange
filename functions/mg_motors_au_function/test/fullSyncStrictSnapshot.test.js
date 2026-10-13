'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 9a (FUSION_REMEDIATION_PLAN.md), audit S5: the full lead sync reads
// every local lead into memory, up to FULL_SYNC_LEAD_ROW_BOUND (500,000).
// Reaching the bound was only logged, and the sync carried on: every lead
// past it looked new and would be inserted again. With
// FULL_SYNC_STRICT_SNAPSHOT on, a snapshot that may be cut off stops the run,
// and any failure to read the snapshot is recorded as a Failed sync run.

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const zohoAuthService = require('../services/zohoAuthService');
const leadSyncService = require('../services/leadSyncService');

const { loadExistingLeadsByCrmId } = leadSyncService._test;

function withFlag(t, value) {
  const before = process.env.FULL_SYNC_STRICT_SNAPSHOT;
  if (value === null) delete process.env.FULL_SYNC_STRICT_SNAPSHOT; else process.env.FULL_SYNC_STRICT_SNAPSHOT = value;
  t.after(() => { if (before === undefined) delete process.env.FULL_SYNC_STRICT_SNAPSHOT; else process.env.FULL_SYNC_STRICT_SNAPSHOT = before; });
}

const leads = (n) => Array.from({ length: n }, (_, i) => ({ crm_record_id: `Z${i}` }));

test('flag on: a snapshot that reaches its bound stops the run (it may be cut off)', async (t) => {
  withFlag(t, 'true');
  const db = createInMemoryZcql({ leads: leads(3) });
  await assert.rejects(loadExistingLeadsByCrmId(db.app, { bound: 3 }), { code: 'FULL_SYNC_SNAPSHOT_INCOMPLETE' });
});

test('flag on: a snapshot under its bound is used as before', async (t) => {
  withFlag(t, 'true');
  const db = createInMemoryZcql({ leads: leads(2) });
  const map = await loadExistingLeadsByCrmId(db.app, { bound: 3 });
  assert.equal(map.size, 2);
});

test('flag off: reaching the bound is only logged and the rows read are used, as before', async (t) => {
  withFlag(t, null);
  const db = createInMemoryZcql({ leads: leads(3) });
  const map = await loadExistingLeadsByCrmId(db.app, { bound: 3 });
  assert.equal(map.size, 3);
});

function zohoReturnsNoLeads(t) {
  zohoAuthService._resetForTests();
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'get', async () => ({ data: { data: [], info: { more_records: false } } }));
}

test('flag on: a snapshot that cannot be read is recorded as a Failed sync run, then the error is raised', async (t) => {
  withFlag(t, 'true');
  zohoReturnsNoLeads(t);
  const db = createInMemoryZcql({ sync_logs: [] }); // no leads table: the read fails
  await assert.rejects(leadSyncService.syncLeads(db.app, { trigger: 'Manual', triggeredBy: 'test' }));
  const log = db.tables.sync_logs[0];
  assert.equal(log.status, 'Failed');
  assert.match(log.error_details, /Local lead snapshot/);
});

test('flag off: the same failure raises without a sync run, as before', async (t) => {
  withFlag(t, null);
  zohoReturnsNoLeads(t);
  const db = createInMemoryZcql({ sync_logs: [] });
  await assert.rejects(leadSyncService.syncLeads(db.app, { trigger: 'Manual', triggeredBy: 'test' }));
  assert.equal(db.tables.sync_logs.length, 0);
});
