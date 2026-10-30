'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

// COST_OPTIMIZATION_PLAN.md, Batch 4 (F1): on 21-22 Oct most crm-notify
// changes ended in an Unhappy 5 hold (INTEGRATION_NOT_CONFIGURED /
// DEALER_ROUTING_INVALID). Each such event wrote the lead row twice: once as
// PENDING, then again as the hold. The hold is now decided first and written
// once. One integration_logs row per event and every alert stay as they were.

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const zohoAuthService = require('../services/zohoAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const leadSyncService = require('../services/leadSyncService');
const usageContext = require('../services/usageContext');

function crmRecord(overrides = {}) {
  return {
    id: '7001', First_Name: 'Alex', Last_Name: 'Morgan', Mobile: '0412345678', Email: 'alex@example.com',
    Postcode: '3000', Enquiry_Model: 'MG3', Nature_of_enquiry: 'Test Drive', Lead_Source: 'Website',
    Lead_Status: 'Not Contacted', Franchise_Code: 'D1', Accept_Privacy_Polic: true,
    Created_Time: '2026-10-09T10:00:00+11:00', ...overrides,
  };
}

// The local mirror of crmRecord(), as a previous sync stored it.
function storedLead(overrides = {}) {
  return {
    crm_record_id: '7001', dealer_code: 'D1', customer_name: 'Alex Morgan', mobile_number: '0412345678',
    email_address: 'alex@example.com', postcode: '3000', vehicle_model: 'MG3', enquiry_model: 'MG3',
    nature_of_enquiry: 'Test Drive', lead_source: 'Website', lead_status: 'Not Contacted', enquiry_status: 'Not Contacted',
    accept_privacy_policy: true, receive_marketing_updates: false, assigned_date: '2026-10-08 23:00:00',
    sync_status: 'ROUTING_HOLD', ...overrides,
  };
}

function setup(t, { leads = [], dealers = [{ dealer_code: 'D1', sync_status: 'Synced' }], integrations = [], record = crmRecord() } = {}) {
  zohoAuthService._resetForTests();
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'get', async () => ({ data: { data: [record], info: { more_records: false } } }));
  const delivered = [];
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async (_app, _integration, leadRow) => {
    delivered.push(leadRow.crm_record_id);
    return { ok: true, scenarioCode: 'Happy 1' };
  });
  const db = createInMemoryZcql({
    leads, dealers, dealer_integrations: integrations, outbound_sync_claims: [], integration_logs: [],
    sync_logs: [], notifications: [], integration_alert_queue: [], lead_integrations: [],
  });
  // Every lead-state write (insert, or an update that sets sync_status), in order.
  const leadWrites = [];
  const datastore = db.app.datastore;
  db.app.datastore = () => ({
    table: (name) => {
      const table = datastore().table(name);
      if (name !== 'leads') return table;
      return {
        ...table,
        insertRow: async (fields) => { leadWrites.push({ op: 'insert', sync_status: fields.sync_status }); return table.insertRow(fields); },
        // Only state writes: writeLog's scenario stamp on the lead is a separate, unchanged write.
        updateRow: async (fields) => {
          if ('sync_status' in fields) leadWrites.push({ op: 'update', sync_status: fields.sync_status });
          return table.updateRow(fields);
        },
      };
    },
  });
  return { db, delivered, leadWrites };
}

async function sync(db) {
  return usageContext.runWithContext({}, async (ctx) => ({
    result: await leadSyncService.syncLeadsByIds(usageContext.instrument(db.app), ['7001']),
    ds: ctx.ds,
  }));
}

const logs = (db) => db.tables.integration_logs.filter((row) => !row.__deleted);
const unhappy5 = (db) => logs(db).filter((row) => row.happy_unhappy_path_name === 'Unhappy 5').map((row) => row.error_message.split(':')[0]);
const NOT_CONFIGURED = [{ dealer_code: 'D1', integration_type: 'NONE', status: 'NOT_CONFIGURED' }];

// ---- updates of an existing lead ------------------------------------------------

test('update, dealer has no integration: one lead write (was PENDING then ROUTING_HOLD)', async (t) => {
  const { db, leadWrites, delivered } = setup(t, { leads: [storedLead()], integrations: NOT_CONFIGURED, record: crmRecord({ Lead_Status: 'Contacted' }) });
  const { result } = await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'update', sync_status: 'ROUTING_HOLD' }]);
  assert.equal(db.tables.leads[0].sync_status, 'ROUTING_HOLD');
  assert.equal(db.tables.leads[0].lead_status, 'Contacted', 'MG fields still mirrored');
  assert.deepEqual(unhappy5(db), ['INTEGRATION_NOT_CONFIGURED'], 'one log row for the event, as before');
  assert.deepEqual(result.scenarioCounts, { 'Unhappy 5': 1 });
  assert.equal(result.recordsUpdated, 1);
  assert.deepEqual(delivered, []);
});

test('update, no dealer assigned: one lead write as ROUTING_HOLD', async (t) => {
  const { db, leadWrites } = setup(t, { leads: [storedLead()], record: crmRecord({ Franchise_Code: '', Lead_Status: 'Contacted' }) });
  await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'update', sync_status: 'ROUTING_HOLD' }]);
  assert.deepEqual(unhappy5(db), ['DEALER_ROUTING_INVALID']);
});

test('update, consent withdrawn: one lead write as CONSENT_HOLD', async (t) => {
  const { db, leadWrites } = setup(t, { leads: [storedLead()], record: crmRecord({ Accept_Privacy_Polic: false }) });
  const { result } = await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'update', sync_status: 'CONSENT_HOLD' }]);
  assert.deepEqual(result.scenarioCounts, { 'Unhappy 8': 1 });
});

test('update, invalid email: one lead write as VALIDATION_HOLD', async (t) => {
  const { db, leadWrites } = setup(t, { leads: [storedLead()], record: crmRecord({ Email: 'not-an-email' }) });
  const { result } = await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'update', sync_status: 'VALIDATION_HOLD' }]);
  assert.deepEqual(result.scenarioCounts, { 'Unhappy 2': 1 });
});

test('update for an external-CRM dealer: written PENDING and sent, exactly as before', async (t) => {
  const { db, leadWrites, delivered } = setup(t, {
    leads: [storedLead({ sync_status: 'SYNCED' })],
    integrations: [{ dealer_code: 'D1', integration_type: 'EXTERNAL_CRM', status: 'CONNECTED' }],
    record: crmRecord({ Lead_Status: 'Contacted' }),
  });
  await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'update', sync_status: 'PENDING' }]);
  assert.deepEqual(delivered, ['7001']);
});

test('update for a portal dealer: PENDING then SYNCED, as before', async (t) => {
  const { db, leadWrites } = setup(t, {
    leads: [storedLead({ sync_status: 'SYNCED' })],
    integrations: [{ dealer_code: 'D1', integration_type: 'PORTAL', status: 'CONNECTED' }],
    record: crmRecord({ Lead_Status: 'Contacted' }),
  });
  await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'update', sync_status: 'PENDING' }, { op: 'update', sync_status: 'SYNCED' }]);
});

test('update whose integration read fails: still written PENDING and reported as before', async (t) => {
  const { db, leadWrites } = setup(t, { leads: [storedLead()], record: crmRecord({ Lead_Status: 'Contacted' }) });
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => { throw new Error('read failed'); });
  const { result } = await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'update', sync_status: 'PENDING' }]);
  assert.deepEqual(result.scenarioCounts, { 'Unhappy 1': 1 });
});

// ---- new leads ----------------------------------------------------------------

test('new lead, dealer has no integration: inserted as ROUTING_HOLD, no second write', async (t) => {
  const { db, leadWrites } = setup(t, { integrations: NOT_CONFIGURED });
  const { result } = await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'insert', sync_status: 'ROUTING_HOLD' }]);
  assert.deepEqual(unhappy5(db), ['INTEGRATION_NOT_CONFIGURED']);
  assert.equal(result.recordsInserted, 1);
});

test('new lead, dealer removed: inserted as ROUTING_HOLD (DEALER_ROUTING_INVALID), no second write', async (t) => {
  const { db, leadWrites } = setup(t, { dealers: [{ dealer_code: 'D1', sync_status: 'Removed' }] });
  await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'insert', sync_status: 'ROUTING_HOLD' }]);
  assert.deepEqual(unhappy5(db), ['DEALER_ROUTING_INVALID']);
});

test('new lead with no dealer assigned: unchanged (already a single ROUTING_HOLD insert)', async (t) => {
  const { db, leadWrites } = setup(t, { record: crmRecord({ Franchise_Code: '' }) });
  await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'insert', sync_status: 'ROUTING_HOLD' }]);
  assert.deepEqual(unhappy5(db), ['DEALER_ROUTING_INVALID']);
});

test('new lead for an external-CRM dealer: inserted PENDING and delivered, as before', async (t) => {
  const { db, leadWrites, delivered } = setup(t, { integrations: [{ dealer_code: 'D1', integration_type: 'EXTERNAL_CRM', status: 'CONNECTED' }] });
  await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'insert', sync_status: 'PENDING' }]);
  assert.deepEqual(delivered, ['7001']);
  const routingReads = db.queries.filter((sql) => /FROM (dealers|dealer_integrations) WHERE dealer_code/.test(sql));
  assert.equal(routingReads.length, 2, 'dealer and integration read once each, not again after the insert');
});

test('new lead whose routing read fails: inserted PENDING, Unhappy 1 recorded as before', async (t) => {
  const { db, leadWrites } = setup(t, { integrations: NOT_CONFIGURED });
  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => { throw new Error('read failed'); });
  const { result } = await sync(db);
  assert.deepEqual(leadWrites, [{ op: 'insert', sync_status: 'PENDING' }]);
  assert.deepEqual(result.scenarioCounts, { 'Unhappy 1': 1 });
  assert.ok(logs(db).some((row) => String(row.error_message).startsWith('DISPATCH_FAILED')));
});

// ---- no-change notifications --------------------------------------------------

test('unchanged notification: no lead write, no claim, no dispatch, no log row (sync_logs row kept)', async (t) => {
  const { db, leadWrites, delivered } = setup(t, { leads: [storedLead({ sync_status: 'SYNCED' })] });
  const { result, ds } = await sync(db);
  assert.equal(result.recordsUnchanged, 1);
  assert.deepEqual(leadWrites, []);
  assert.deepEqual(delivered, []);
  assert.deepEqual(logs(db), []);
  assert.deepEqual({ fetch: ds.fetch, insert: ds.insert, update: ds.update, delete: ds.delete }, { fetch: 1, insert: 1, update: 0, delete: 0 });
  assert.equal(db.tables.sync_logs.length, 1, 'kept by decision (22 Oct)');
});

// ---- "Lead sync complete" summary (27 Oct 2026, reversing C10) -------------------

const summaries = (db) => db.tables.notifications.filter((row) => row.type === 'SYNC_SUMMARY');

test('webhook sync of a changed lead writes no "Lead sync complete" summary; the Unhappy alert stays', async (t) => {
  const { db } = setup(t, { leads: [storedLead()], integrations: NOT_CONFIGURED, record: crmRecord({ Lead_Status: 'Contacted' }) });
  await usageContext.runWithContext({}, () => leadSyncService.syncLeadsByIds(db.app, ['7001'], { trigger: 'Webhook' }));
  assert.equal(summaries(db).length, 0);
  assert.ok(db.tables.notifications.length > 0, 'the Unhappy 5 alert notification is still written');
});

test('a non-webhook sync of a changed lead still writes the summary for Admin and Super Admin', async (t) => {
  const { db } = setup(t, { leads: [storedLead()], integrations: NOT_CONFIGURED, record: crmRecord({ Lead_Status: 'Contacted' }) });
  await usageContext.runWithContext({}, () => leadSyncService.syncLeadsByIds(db.app, ['7001'], { trigger: 'Manual' }));
  assert.deepEqual(summaries(db).map((row) => row.recipient_role).sort(), ['ADMIN', 'SUPER_ADMIN']);
});
