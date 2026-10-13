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
const leadFingerprintService = require('../services/integrations/leadFingerprintService');
const { missingDeliveryMappingFields } = require('../services/integrations/leadMappingService');
const { withEnv } = require('./helpers/outboundHarness');

const { buildOutboundPayload } = crmIntegrationService._test;

// Q2 (13 Oct 2026): Fusion gets the customer's first and last name
// separately. MG's lead sync joins them into customer_name, so with
// LEAD_NAME_PARTS=true it also stores them in first_name / last_name (two
// text columns added to `leads` in the Catalyst console first). A retry reads
// the lead back from the table, so the parts must be stored for the payload
// to be the same on every attempt (same Idempotency-Key).

function buildFakeCatalystApp({ existingLeads = [] } = {}) {
  const updatedRows = [];
  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => (sql.includes('FROM leads') ? existingLeads.map((l) => ({ leads: l })) : []),
    }),
    datastore: () => ({
      table: (name) => (name === 'leads'
        ? {
          insertRow: async (fields) => ({ ROWID: 'new-1', ...fields }),
          updateRow: async (fields) => { updatedRows.push(fields); return fields; },
        }
        : { insertRow: async (fields) => ({ ROWID: 'generic', ...fields }), updateRow: async (fields) => fields }),
    }),
    _updatedRows: updatedRows,
  };
}

const CRM_RECORD = {
  id: '1001', First_Name: 'John', Last_Name: 'Smith', Mobile: '0412345678', Email: 'john.smith@example.com',
  Postcode: '3000', Enquiry_Model: 'MG3', Variant: '', Nature_of_enquiry: 'Test Drive', Lead_Source: 'Website',
  Lead_Status: 'Not Contacted', Franchise_Code: 'AU100', Accept_Privacy_Polic: true, Created_Time: '2026-01-01T00:00:00.000Z',
};

// The row the sync stored for CRM_RECORD before name parts were kept.
function storedRow(extra = {}) {
  const before = process.env.LEAD_NAME_PARTS;
  delete process.env.LEAD_NAME_PARTS;
  const row = leadSyncService._test.mapCrmRecordToLeadRow(CRM_RECORD);
  if (before !== undefined) process.env.LEAD_NAME_PARTS = before;
  return { ...row, ROWID: '501', sync_status: 'SYNCED', ...extra };
}

function mockOem(t, record) {
  zohoAuthService._resetForTests();
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'get', async () => ({ data: { data: [record], info: { more_records: false } } }));
}

function spyDispatch(t) {
  return t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({ integration_type: 'PORTAL' }));
}

test('without LEAD_NAME_PARTS the sync stores no name parts, as before', (t) => {
  withEnv(t, { LEAD_NAME_PARTS: undefined });
  const row = leadSyncService._test.mapCrmRecordToLeadRow(CRM_RECORD);
  assert.equal(row.customer_name, 'John Smith');
  assert.ok(!('first_name' in row) && !('last_name' in row));
});

test('with LEAD_NAME_PARTS=true the sync stores first and last name as well', (t) => {
  withEnv(t, { LEAD_NAME_PARTS: 'true' });
  const row = leadSyncService._test.mapCrmRecordToLeadRow(CRM_RECORD);
  assert.equal(row.customer_name, 'John Smith');
  assert.equal(row.first_name, 'John');
  assert.equal(row.last_name, 'Smith');
});

test('filling the name parts of a lead stored before is saved without sending anything to the dealer', async (t) => {
  withEnv(t, { LEAD_NAME_PARTS: 'true' });
  mockOem(t, CRM_RECORD);
  const dispatch = spyDispatch(t);
  const app = buildFakeCatalystApp({ existingLeads: [storedRow()] });

  const result = await leadSyncService.syncLeads(app, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(dispatch.mock.calls.length, 0, 'no dealer update for a backfill');
  assert.equal(result.recordsUpdated, 0);
  const write = app._updatedRows.find((r) => r.ROWID === '501');
  assert.equal(write.first_name, 'John');
  assert.equal(write.last_name, 'Smith');
  assert.ok(!('sync_status' in write), 'the delivery state is untouched');
});

test('once stored, a name change is a normal update that reaches the dealer', async (t) => {
  withEnv(t, { LEAD_NAME_PARTS: 'true' });
  mockOem(t, { ...CRM_RECORD, Last_Name: 'Smith-Jones' });
  const dispatch = spyDispatch(t);
  const app = buildFakeCatalystApp({ existingLeads: [storedRow({ first_name: 'John', last_name: 'Smith' })] });

  const result = await leadSyncService.syncLeads(app, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(dispatch.mock.calls.length, 1);
  assert.equal(result.recordsUpdated, 1);
  const pending = app._updatedRows.find((r) => r.ROWID === '501' && r.sync_status === 'PENDING');
  assert.equal(pending.last_name, 'Smith-Jones');
  assert.equal(pending.customer_name, 'John Smith-Jones');
});

test('an unchanged lead whose parts are stored is left alone', async (t) => {
  withEnv(t, { LEAD_NAME_PARTS: 'true' });
  mockOem(t, CRM_RECORD);
  const dispatch = spyDispatch(t);
  const app = buildFakeCatalystApp({ existingLeads: [storedRow({ first_name: 'John', last_name: 'Smith' })] });

  await leadSyncService.syncLeads(app, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(dispatch.mock.calls.length, 0);
  assert.equal(app._updatedRows.filter((r) => r.ROWID === '501').length, 0);
});

// --- what Fusion receives ---

const NAME_FIELDS = [
  { source_field: 'first_name', target_field: 'contact.firstName', data_type: 'string', required: false },
  { source_field: 'last_name', target_field: 'contact.lastName', data_type: 'string', required: false },
];

test('Fusion receives the stored first and last name; a lead without them sends its full name, as today', () => {
  const fusion = (lead, operation) => buildOutboundPayload(
    { customer_name: 'Jane Citizen', lead_status: '', ...lead }, NAME_FIELDS, [], { crmType: 'FUSION_SD', operation }
  );

  const split = fusion({ first_name: 'Jane', last_name: 'Citizen' }, 'CREATE_LEAD');
  assert.equal(split['contact.firstName'], 'Jane');
  assert.equal(split['contact.lastName'], 'Citizen');

  for (const operation of ['CREATE_LEAD', 'UPDATE_LEAD']) {
    const whole = fusion({}, operation);
    assert.equal(whole['contact.firstName'], 'Jane Citizen', operation);
    assert.ok(!('contact.lastName' in whole), `${operation}: no last name is sent, so none is cleared`);
  }

  const lastOnly = fusion({ first_name: '', last_name: 'Citizen' }, 'CREATE_LEAD');
  assert.deepEqual(lastOnly, { 'contact.lastName': 'Citizen' }, 'Fusion accepts a last name alone');
});

test('for Fusion, first_name / last_name cover the mandatory customer name and feed the echo fingerprint', () => {
  const sources = ['enquiry_id', 'first_name', 'last_name', 'mobile_number', 'email_address', 'postcode', 'vehicle_model',
    'nature_of_enquiry', 'enquiry_channel', 'accept_privacy_policy', 'lead_status'];
  assert.deepEqual(missingDeliveryMappingFields(sources, 'FUSION_SD'), []);
  assert.ok(missingDeliveryMappingFields(sources, 'ZOHO_CRM').includes('customer_name'));

  const keys = leadFingerprintService.fingerprintKeys(NAME_FIELDS);
  assert.ok(keys.includes('customer_name'));
});
