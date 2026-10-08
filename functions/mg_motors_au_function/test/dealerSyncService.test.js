'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const dealerSyncService = require('../services/dealerSyncService');

const { mapCrmRecordToDealerRow, hasChanges } = dealerSyncService._test;

// zohoCrmService.js reads config via a destructured getZohoConfig/axios
// call at module scope, so it can't be property-mocked after the fact
// (same reason as zohoOAuthSingleFlight.test.js) — env vars are set
// directly, and the actual HTTP call (axios.get) is mocked instead.
process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Regression test for a confirmed live production bug (AU004, 2026-10-05):
// Zoho's Dealer_Master module has TWO name-like fields — "Name" (the
// module's standard record-title field, actually edited when a dealer is
// renamed in Zoho's UI) and "Dealer_Name" (a separate custom field that is
// NOT kept in sync with it). The sync only ever read Dealer_Name, so a
// dealer rename in Zoho silently never reached this app, even though the
// webhook fired correctly and the sync ran successfully — hasChanges()
// correctly found no difference because Dealer_Name itself truly never
// changed. Confirmed directly against the live Zoho field list (Setup >
// Dealer_Master > Fields), not guessed.

test('mapCrmRecordToDealerRow: prefers Name (the field Zoho actually edits on rename) (Dealers module has no separate Dealer_Name)', () => {
  const crmRecord = {
    Name: 'MG Fusion Testing1',
    Dealer_Code: 'AU004',
    Phone_Number: '0398765432',
    Email: 'au004@example.com',
    Dealer_Region: 'VIC',
    Dealer_State: 'VIC',
    City_Suburb: 'Melbourne',
    Dealer_Stage: 'Active',
    id: '12345',
  };

  const row = mapCrmRecordToDealerRow(crmRecord);

  assert.equal(row.dealer_name, 'MG Fusion Testing1', 'the current record title (Name) must win, not the stale custom field');
});

test('syncDealers: a dealer rename in Zoho (Name field) is detected and applied end-to-end', async (t) => {
  const dealersByCode = new Map([
    ['AU004', {
      ROWID: '501',
      dealer_code: 'AU004',
      dealer_name: 'MG Melbourne Central',
      phone_number: '0398765432',
      email_address: 'au004@example.com',
      region: 'VIC',
      state: 'VIC',
      city: 'Melbourne',
      status: 'Active',
      crm_record_id: '12345',
      sync_status: 'Synced',
    }],
  ]);

  const zohoAuthService = require('../services/zohoAuthService');
  zohoAuthService._resetForTests();
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'get', async () => ({
    data: {
      data: [{
        Name: 'MG Fusion Testing1', // renamed in Zoho
        Dealer_Code: 'AU004',
        Phone_Number: '0398765432',
        Email: 'au004@example.com',
        Dealer_Region: 'VIC',
        Dealer_State: 'VIC',
        City_Suburb: 'Melbourne',
        Dealer_Stage: 'Active',
        id: '12345',
      }],
      info: { more_records: false },
    },
  }));

  const updatedRows = [];
  const catalystApp = {
    zcql: () => ({
      executeZCQLQuery: async () => [...dealersByCode.values()].map((d) => ({ dealers: d })),
    }),
    datastore: () => ({
      table: () => ({
        insertRow: async (fields) => fields,
        updateRow: async (fields) => {
          updatedRows.push(fields);
          return fields;
        },
      }),
    }),
  };

  const result = await dealerSyncService.syncDealers(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(result.recordsUpdated, 1, 'the rename must be detected as a change');
  assert.equal(updatedRows.length, 1);
  assert.equal(updatedRows[0].dealer_name, 'MG Fusion Testing1', 'the applied update must carry the NEW name, not the stale Dealer_Name field');
});
