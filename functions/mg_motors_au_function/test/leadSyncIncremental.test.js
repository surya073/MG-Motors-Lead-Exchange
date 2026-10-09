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
const zohoAuthService = require('../services/zohoAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const leadSyncService = require('../services/leadSyncService');

// Webhook-triggered lead sync must touch only the affected OEM records and
// never read the whole OEM lead history or the whole Catalyst leads table.
// The fake datastore below THROWS on any `FROM leads` query that is not one
// of the targeted lookups, so a regression to a full-table scan fails the
// test instead of silently passing.

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFakeCatalystApp({ existingLeads = [], syncLogRows = [] } = {}) {
  const leads = existingLeads.map((l, i) => ({ ROWID: `seed-${i + 1}`, ...l }));
  const inserted = [];
  const updated = [];
  const syncLogsWritten = [];
  const queries = [];
  const claims = new Map();
  let claimSeq = 0;

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        queries.push(sql);
        if (sql.includes('FROM leads')) {
          if (/crm_record_id IN \(/.test(sql)) {
            const ids = [...sql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
            return leads.filter((l) => ids.includes(l.crm_record_id)).map((l) => ({ leads: l }));
          }
          const mobile = /mobile_number = '([^']*)'/.exec(sql);
          if (mobile) return leads.filter((l) => l.mobile_number === mobile[1]).map((l) => ({ leads: l }));
          const dealer = /dealer_code = '([^']*)' AND postcode = '([^']*)'/.exec(sql);
          if (dealer) {
            return leads.filter((l) => l.dealer_code === dealer[1] && l.postcode === dealer[2]).map((l) => ({ leads: l }));
          }
          throw new Error(`FULL TABLE SCAN attempted: ${sql}`);
        }
        if (sql.includes('FROM sync_logs')) return syncLogRows.map((r) => ({ sync_logs: r }));
        if (sql.includes('FROM outbound_sync_claims')) {
          const key = (/claim_key = '([^']*)'/.exec(sql) || [])[1];
          const row = key ? claims.get(key) : null;
          return row ? [{ outbound_sync_claims: row }] : [];
        }
        return [];
      },
    }),
    datastore: () => ({
      table: (name) => {
        if (name === 'leads') {
          return {
            insertRow: async (fields) => {
              const row = { ROWID: `new-${inserted.length + 1}`, ...fields };
              inserted.push(row);
              leads.push(row);
              return row;
            },
            updateRow: async (fields) => {
              updated.push(fields);
              const row = leads.find((l) => l.ROWID === fields.ROWID);
              if (row) Object.assign(row, fields);
              return fields;
            },
          };
        }
        if (name === 'outbound_sync_claims') {
          return {
            insertRow: async (fields) => {
              if (claims.has(fields.claim_key)) throw new Error('UNIQUE constraint violation');
              claimSeq += 1;
              const row = { ROWID: `claim-${claimSeq}`, ...fields };
              claims.set(fields.claim_key, row);
              return row;
            },
            deleteRow: async (rowId) => {
              for (const [key, row] of claims) if (row.ROWID === rowId) claims.delete(key);
            },
          };
        }
        if (name === 'sync_logs') {
          return { insertRow: async (fields) => { syncLogsWritten.push(fields); return fields; } };
        }
        return {
          insertRow: async (fields) => ({ ROWID: 'generic', ...fields }),
          updateRow: async (fields) => fields,
          deleteRow: async () => {},
        };
      },
    }),
    _leads: leads,
    _inserted: inserted,
    _updated: updated,
    _syncLogs: syncLogsWritten,
    _queries: queries,
    _claims: claims,
  };
}

function crmRecord(overrides = {}) {
  return {
    id: '7001',
    First_Name: 'Alex',
    Last_Name: 'Morgan',
    Mobile: '0412345678',
    Email: 'alex@example.com',
    Postcode: '3000',
    Enquiry_Model: 'MG3',
    Nature_of_enquiry: 'Test Drive',
    Lead_Source: 'Website',
    Lead_Status: 'Not Contacted',
    Franchise_Code: '568026',
    Accept_Privacy_Polic: true,
    Created_Time: '2026-10-09T10:00:00+11:00',
    ...overrides,
  };
}

function setup(t, { app, onGet } = {}) {
  zohoAuthService._resetForTests();
  const gets = [];
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'put', async () => ({ data: { data: [{ status: 'success' }] } }));
  t.mock.method(axios, 'get', async (url, config) => {
    gets.push({ url, ...config });
    return onGet(config, gets.length);
  });
  const dispatched = [];
  t.mock.method(crmIntegrationService, 'findDealerByCode', async (_a, code) => ({ dealer_code: code, sync_status: 'Active' }));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({ ROWID: '900', integration_type: 'EXTERNAL_CRM' }));
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async (_a, _i, leadRow) => {
    await delay(10);
    dispatched.push(leadRow.crm_record_id);
    return { ok: true, scenarioCode: 'Happy 1' };
  });
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  return { app: app || buildFakeCatalystApp(), gets, dispatched };
}

const byIds = (records) => (config) => ({
  data: {
    data: records.filter((r) => String(config.params.ids).split(',').includes(r.id)),
    info: { more_records: false },
  },
});

const FULL_TABLE_SCAN = /FROM leads(?! WHERE)/;

test('webhook: only the notified record is fetched and processed — no full OEM or Catalyst scan', async (t) => {
  const { app, gets, dispatched } = setup(t, { onGet: byIds([crmRecord(), crmRecord({ id: '7002' })]) });

  const result = await leadSyncService.syncLeadsByIds(app, ['7001'], { operation: 'insert' });

  assert.equal(result.recordsInserted, 1);
  assert.equal(gets.length, 1, 'exactly one Zoho call');
  assert.equal(gets[0].params.ids, '7001');
  assert.equal(gets[0].params.page, undefined);
  assert.deepEqual(app._inserted.map((r) => r.crm_record_id), ['7001']);
  assert.deepEqual(dispatched, ['7001'], 'new lead still dispatched to the dealer');
  assert.equal(app._queries.some((q) => FULL_TABLE_SCAN.test(q)), false);
});

test('duplicate webhook delivery: the second identical notification changes nothing', async (t) => {
  const { app, gets, dispatched } = setup(t, { onGet: byIds([crmRecord()]) });

  await leadSyncService.syncLeadsByIds(app, ['7001']);
  const second = await leadSyncService.syncLeadsByIds(app, ['7001']);

  assert.equal(second.recordsInserted, 0);
  assert.equal(second.recordsUpdated, 0);
  assert.equal(second.recordsUnchanged, 1);
  assert.equal(app._inserted.length, 1);
  assert.deepEqual(dispatched, ['7001'], 'the dealer must receive the lead once, not once per notification');
  assert.equal(gets.length, 2);
});

test('out-of-order webhooks: a late notification re-reads current state and never reverts a newer one', async (t) => {
  // Both notifications name the same lead; Zoho always answers with its
  // CURRENT state, so processing the stale notification last is a no-op.
  const current = crmRecord({ Lead_Status: 'Contacted' });
  const { app } = setup(t, { onGet: byIds([current]) });
  app._leads.push({
    ROWID: 'seed-x', crm_record_id: '7001', dealer_code: '568026', customer_name: 'Alex Morgan',
    mobile_number: '0412345678', email_address: 'alex@example.com', postcode: '3000', vehicle_model: 'MG3',
    enquiry_model: 'MG3', nature_of_enquiry: 'Test Drive', lead_source: 'Website', lead_status: 'Not Contacted',
    accept_privacy_policy: true, sync_status: 'SYNCED',
  });

  const newer = await leadSyncService.syncLeadsByIds(app, ['7001'], { operation: 'update' });
  const stale = await leadSyncService.syncLeadsByIds(app, ['7001'], { operation: 'update' });

  assert.equal(newer.recordsUpdated, 1);
  assert.equal(stale.recordsUpdated, 0);
  assert.equal(app._leads.find((l) => l.ROWID === 'seed-x').lead_status, 'Contacted');
});

test('concurrent webhooks for the same lead are serialised: one insert, one dispatch', async (t) => {
  const { app, dispatched } = setup(t, { onGet: byIds([crmRecord()]) });

  const [a, b] = await Promise.all([
    leadSyncService.syncLeadsByIds(app, ['7001']),
    leadSyncService.syncLeadsByIds(app, ['7001']),
  ]);

  assert.equal(a.recordsInserted + b.recordsInserted, 1);
  assert.equal(app._inserted.length, 1);
  assert.deepEqual(dispatched, ['7001']);
  assert.equal(app._claims.size, 0, 'no claim left behind');
});

test('concurrent webhooks for two business-duplicate leads: second is linked (Happy 3), never dispatched', async (t) => {
  const first = crmRecord({ id: '8001', Created_Time: '2026-10-09T10:00:00+11:00' });
  const second = crmRecord({ id: '8002', Created_Time: '2026-10-09T10:05:00+11:00' });
  const { app, dispatched } = setup(t, { onGet: byIds([first, second]) });

  const [a, b] = await Promise.all([
    leadSyncService.syncLeadsByIds(app, ['8001']),
    leadSyncService.syncLeadsByIds(app, ['8002']),
  ]);

  assert.equal(a.recordsInserted + b.recordsInserted, 2);
  assert.deepEqual(dispatched, ['8001'], 'only the original reaches the dealer');
  const statuses = Object.fromEntries(app._inserted.map((r) => [r.crm_record_id, r.sync_status]));
  assert.equal(statuses['8002'], 'DUPLICATE_LINKED');
});

test('duplicate detection still finds an earlier delivered lead that is NOT part of the webhook', async (t) => {
  const { app, dispatched } = setup(t, {
    onGet: byIds([crmRecord({ id: '9002', Created_Time: '2026-10-09T10:05:00+11:00' })]),
  });
  app._leads.push({
    ROWID: 'seed-orig', crm_record_id: '9001', dealer_code: '568026', customer_name: 'Alex Morgan',
    mobile_number: '0412345678', email_address: 'alex@example.com', postcode: '3000', vehicle_model: 'MG3',
    enquiry_model: 'MG3', nature_of_enquiry: 'Test Drive', lead_source: 'Website', lead_status: 'Not Contacted',
    accept_privacy_policy: true, sync_status: 'SYNCED', assigned_date: '2026-10-08 22:55:00', // UTC, 10 min before the incoming 10:05+11:00 enquiry
  });

  const result = await leadSyncService.syncLeadsByIds(app, ['9002']);

  assert.equal(result.recordsInserted, 1);
  assert.equal(app._inserted[0].sync_status, 'DUPLICATE_LINKED');
  assert.deepEqual(dispatched, []);
  assert.equal(app._queries.some((q) => FULL_TABLE_SCAN.test(q)), false);
});

test('delete notification marks the local lead Removed without fetching Zoho', async (t) => {
  const { app, gets } = setup(t, { onGet: byIds([]) });
  app._leads.push({ ROWID: 'seed-del', crm_record_id: '7100', dealer_code: '568026', sync_status: 'SYNCED' });

  const result = await leadSyncService.syncLeadsByIds(app, ['7100'], { operation: 'delete' });

  assert.equal(result.recordsRemoved, 1);
  assert.equal(app._leads[0].sync_status, 'Removed');
  assert.equal(gets.length, 0);
});

test('LEAD_SYNC_SINCE still excludes historical leads on the webhook path', async (t) => {
  process.env.LEAD_SYNC_SINCE = '2026-10-08T00:00:00+11:00';
  t.after(() => { delete process.env.LEAD_SYNC_SINCE; });
  const old = crmRecord({ id: '6001', Created_Time: '2024-01-01T00:00:00+11:00' });
  const { app } = setup(t, { onGet: byIds([old]) });

  const result = await leadSyncService.syncLeadsByIds(app, ['6001']);

  assert.equal(result.totalRecordsFetched, 0);
  assert.equal(app._inserted.length, 0);
});

test('recovery: modified-since sweep resumes from the last clean Incremental run and processes only those records', async (t) => {
  const lastClean = { sync_type: 'Lead_Sync', sync_trigger: 'Incremental', status: 'Success', records_failed: '0', start_time: '2026-10-09 02:00:00' };
  const failedRun = { sync_type: 'Lead_Sync', sync_trigger: 'Incremental', status: 'Partial', records_failed: '2', start_time: '2026-10-09 03:00:00' };
  const app = buildFakeCatalystApp({ syncLogRows: [failedRun, lastClean] });
  const { gets } = setup(t, {
    app,
    onGet: () => ({ data: { data: [crmRecord({ id: '5001' })], info: { more_records: false } } }),
  });

  const result = await leadSyncService.syncModifiedLeads(app, { triggeredBy: 'Cron' });

  assert.equal(result.recordsInserted, 1);
  // The failed 03:00 run must not advance the watermark; resume 2 min before 02:00.
  assert.equal(gets[0].headers['If-Modified-Since'], '2026-10-09T01:58:00+00:00');
  assert.equal(gets[0].params.ids, undefined);
  assert.equal(app._syncLogs[0].sync_trigger, 'Incremental');
});

test('recovery: a quiet period (HTTP 304) writes no sync log and inserts nothing', async (t) => {
  const { app } = setup(t, {
    onGet: () => {
      const err = new Error('Not Modified');
      err.response = { status: 304 };
      throw err;
    },
  });

  const result = await leadSyncService.syncModifiedLeads(app, { triggeredBy: 'Cron' });

  assert.equal(result.totalRecordsFetched, 0);
  assert.equal(app._syncLogs.length, 0);
  assert.equal(app._inserted.length, 0);
});

test('recovery watermark falls back to 24h back (never before LEAD_SYNC_SINCE) when there is no prior run', async () => {
  const app = buildFakeCatalystApp({ syncLogRows: [] });
  const now = new Date('2026-10-09T12:00:00Z');

  const noWindow = await leadSyncService._test.getIncrementalWatermark(app, now);
  assert.equal(noWindow.toISOString(), '2026-10-08T12:00:00.000Z');

  process.env.LEAD_SYNC_SINCE = '2026-10-09T00:00:00+00:00';
  try {
    const windowed = await leadSyncService._test.getIncrementalWatermark(app, now);
    assert.equal(windowed.toISOString(), '2026-10-09T00:00:00.000Z');
  } finally {
    delete process.env.LEAD_SYNC_SINCE;
  }
});
