'use strict';

// zohoCrmService.js reads config via a destructured getZohoConfig/axios call
// at module scope (same reason as dealerSyncService.test.js) — env vars are
// set directly, and axios.get/axios.put/axios.post are mocked instead.
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

// Covers the approved fix: a lead already classified sync_status ===
// 'DUPLICATE_LINKED' (Happy Path 3) must never reach Dealer CRM, even if
// the OEM record is edited again afterwards. Before this fix, a later OEM
// edit made hasChanges() true and fell into the generic update branch,
// which calls dispatchLeadUpdateToDealer() -> syncLeadToExternalCrm()
// unconditionally — and since a duplicate never has a lead_integrations
// row, that would be treated as a first-time CREATE. Fixed by intercepting
// existingRow.sync_status === 'DUPLICATE_LINKED' before that branch's
// condition is even evaluated (services/leadSyncService.js).

function buildFakeCatalystApp({ existingLeads = [] } = {}) {
  const updatedRows = [];
  const insertedRows = [];
  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM leads')) {
          return existingLeads.map((l) => ({ leads: l }));
        }
        return [];
      },
    }),
    datastore: () => ({
      table: (name) => {
        if (name === 'leads') {
          return {
            insertRow: async (fields) => {
              const row = { ROWID: `new-${insertedRows.length + 1}`, ...fields };
              insertedRows.push(row);
              return row;
            },
            updateRow: async (fields) => {
              updatedRows.push(fields);
              return fields;
            },
          };
        }
        // sync_logs / notifications — generic no-op stub; recordSyncRun and
        // notifyAdmins (via notifyRole's internal try/catch) only need
        // insertRow to not throw, not any particular return shape.
        return {
          insertRow: async (fields) => ({ ROWID: 'generic', ...fields }),
          updateRow: async (fields) => fields,
        };
      },
    }),
    _updatedRows: updatedRows,
    _insertedRows: insertedRows,
  };
}

function buildValidCrmRecord(overrides = {}) {
  return {
    id: '1001',
    First_Name: 'John',
    Last_Name: 'Smith',
    Mobile: '0412345678',
    Email: 'john.smith@example.com',
    Postcode: '3000',
    Enquiry_Model: 'MG3',
    Variant: '',
    Nature_of_enquiry: 'Test Drive',
    Lead_Source: 'Website',
    Lead_Status: 'Not Contacted',
    Franchise_Code: 'AU100',
    Accept_Privacy_Polic: true,
    Created_Time: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildExistingLeadRow(overrides = {}) {
  return {
    ROWID: '501',
    crm_record_id: '1001',
    dealer_code: 'AU100',
    customer_name: 'John Smith',
    mobile_number: '0412345678',
    email_address: 'john.smith@example.com',
    postcode: '3000',
    vehicle_model: 'MG3',
    enquiry_variant: '',
    nature_of_enquiry: 'Test Drive',
    lead_source: 'Website',
    accept_privacy_policy: true,
    lead_status: 'Not Contacted',
    sync_status: 'SYNCED',
    assigned_date: '2026-01-01 00:00:00',
    ...overrides,
  };
}

function mockOemFetch(t, crmRecords) {
  t.mock.method(axios, 'get', async () => ({
    data: { data: crmRecords, info: { more_records: false } },
  }));
}

function mockOauth(t) {
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
}

test('DUPLICATE_LINKED lead + OEM field change: no Dealer CRM dispatch is attempted', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);
  mockOemFetch(t, [buildValidCrmRecord({ Last_Name: 'Smith-Updated' })]);

  const getIntegrationSpy = t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => {
    throw new Error('must not be called for a DUPLICATE_LINKED lead');
  });
  const syncExternalSpy = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => {
    throw new Error('must not be called for a DUPLICATE_LINKED lead');
  });

  const catalystApp = buildFakeCatalystApp({
    existingLeads: [buildExistingLeadRow({ sync_status: 'DUPLICATE_LINKED' })],
  });

  const result = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(getIntegrationSpy.mock.calls.length, 0, 'dispatchLeadUpdateToDealer must never be reached for a duplicate-linked lead');
  assert.equal(syncExternalSpy.mock.calls.length, 0, 'syncLeadToExternalCrm must never be reached for a duplicate-linked lead');
  assert.equal(result.recordsUpdated, 1, 'the mirrored fields are still refreshed');

  const update = catalystApp._updatedRows.find((r) => r.ROWID === '501');
  assert.ok(update, 'the existing row must still be updated with the new OEM field value');
  assert.equal(update.sync_status, 'DUPLICATE_LINKED', 'sync_status must stay DUPLICATE_LINKED, never reset to PENDING');
  assert.equal(update.customer_name, 'John Smith-Updated', 'the mirrored field change is applied');
});

test('DUPLICATE_LINKED lead + OEM field change: no lead_integrations row is ever created', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);
  mockOemFetch(t, [buildValidCrmRecord({ Last_Name: 'Smith-Updated' })]);

  // Every lead_integrations insertRow in the codebase lives inside
  // attemptExternalCrmSync, reachable only via syncLeadToExternalCrm — so
  // proving this is never called structurally proves no row is created.
  const syncExternalSpy = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => {
    throw new Error('must not be called — would create a lead_integrations row');
  });

  const catalystApp = buildFakeCatalystApp({
    existingLeads: [buildExistingLeadRow({ sync_status: 'DUPLICATE_LINKED' })],
  });

  await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(syncExternalSpy.mock.calls.length, 0);
});

test('normal existing lead (not duplicate-linked) + OEM field change: existing update/dispatch behavior is unchanged', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);
  mockOemFetch(t, [buildValidCrmRecord({ Last_Name: 'Smith-Updated' })]);

  const getIntegrationSpy = t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({
    integration_type: 'PORTAL',
  }));
  const syncExternalSpy = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => {
    throw new Error('PORTAL dealers must never call syncLeadToExternalCrm');
  });

  const catalystApp = buildFakeCatalystApp({
    existingLeads: [buildExistingLeadRow({ sync_status: 'SYNCED' })],
  });

  const result = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(getIntegrationSpy.mock.calls.length, 1, 'the normal update branch must still look up the dealer integration, exactly as before');
  assert.equal(syncExternalSpy.mock.calls.length, 0);
  assert.equal(result.recordsUpdated, 1);

  const pendingWrite = catalystApp._updatedRows.find((r) => r.ROWID === '501' && r.sync_status === 'PENDING');
  assert.ok(pendingWrite, 'the generic update branch must still stage the row as PENDING before dispatch, unchanged');
  const syncedWrite = catalystApp._updatedRows.find((r) => r.ROWID === '501' && r.sync_status === 'SYNCED');
  assert.ok(syncedWrite, 'markLeadState must still settle a PORTAL update to SYNCED, unchanged');
});

test('Happy Path 3 duplicate classification behavior is unchanged', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);

  const original = buildValidCrmRecord({ id: '2001', Created_Time: '2026-01-01T00:00:00.000Z' });
  const duplicate = buildValidCrmRecord({ id: '2002', Created_Time: '2026-01-01T00:05:00.000Z' });
  mockOemFetch(t, [original, duplicate]);

  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => ({
    dealer_code: 'AU100',
    sync_status: 'Active',
  }));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({
    ROWID: '900',
    integration_type: 'EXTERNAL_CRM',
  }));
  const syncExternalSpy = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async (_app, _integration, leadRow) => ({
    ok: true,
    scenarioCode: 'Happy 1',
    _leadRowCrmId: leadRow.crm_record_id,
  }));
  const recordScenarioSpy = t.mock.method(crmIntegrationService, 'recordScenario', async () => {});

  const putCalls = [];
  t.mock.method(axios, 'put', async (url, body) => {
    putCalls.push({ url, body });
    return { data: { data: [{ status: 'success', code: 'SUCCESS' }] } };
  });

  const catalystApp = buildFakeCatalystApp({ existingLeads: [] });

  const result = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(syncExternalSpy.mock.calls.length, 1, 'only the ORIGINAL lead may be dispatched to the dealer');
  assert.equal(syncExternalSpy.mock.calls[0].arguments[2].crm_record_id, '2001');

  assert.equal(recordScenarioSpy.mock.calls.length, 1);
  const scenarioArgs = recordScenarioSpy.mock.calls[0].arguments[1];
  assert.equal(scenarioArgs.scenarioCode, 'Happy 3');
  assert.equal(scenarioArgs.leadRow.crm_record_id, '2002', 'Happy 3 must be recorded against the NEW duplicate lead, not the original');

  assert.equal(putCalls.length, 1, 'only the duplicate lead\'s own OEM record is written back to Not Qualified');
  assert.ok(putCalls[0].url.endsWith('/Leads/2002'));
  assert.equal(putCalls[0].body.data[0].Lead_Status, 'Not Qualified');

  const duplicateInsert = catalystApp._insertedRows.find((r) => r.crm_record_id === '2002');
  assert.ok(duplicateInsert);
  assert.equal(duplicateInsert.sync_status, 'DUPLICATE_LINKED');

  assert.equal(result.recordsInserted, 2);
  assert.equal(result.scenarioCounts['Happy 3'], 1);
});
