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

// Covers the approved fix for the confirmed syncLeads() cross-instance race:
// two concurrent executions (webhook + webhook, webhook + manual, or two
// manual triggers) each load their own loadExistingLeadsByCrmId() snapshot,
// so two different-but-business-duplicate OEM records could both be
// classified "new" before either insert is visible to the other. Fixed by
// wrapping just the new-lead classification/insert/dispatch segment in the
// existing outboundSyncClaimService.withOutboundSyncClaim(), reused with a
// 'leadSync' namespace prefix and a dealer_code key — not a global
// guardSweep — so unrelated dealers stay fully concurrent.

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A faithful-enough simulation of the production outbound_sync_claims
// table's behavior: insertRow rejects a second row with the same claim_key
// (the Console UNIQUE constraint), zcql can look an existing claim_key up,
// and deleteRow releases it — exactly the three operations
// outboundSyncClaimService.js relies on.
function buildFakeCatalystApp({ existingLeads = [] } = {}) {
  const updatedRows = [];
  const insertedRows = [];
  const claimsByKey = new Map();
  let claimRowSeq = 0;

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM leads')) {
          return existingLeads.map((l) => ({ leads: l }));
        }
        if (sql.includes('FROM outbound_sync_claims')) {
          const match = /claim_key = '([^']*)'/.exec(sql);
          const key = match ? match[1].replace(/''/g, "'") : null;
          const row = key ? claimsByKey.get(key) : null;
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
              if (fields.customer_name === 'TRIGGER_INSERT_FAILURE') {
                throw new Error('Simulated insert failure');
              }
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
        if (name === 'outbound_sync_claims') {
          return {
            insertRow: async (fields) => {
              if (claimsByKey.has(fields.claim_key)) {
                const err = new Error('UNIQUE constraint violation on claim_key');
                throw err;
              }
              claimRowSeq += 1;
              const row = { ROWID: `claim-${claimRowSeq}`, ...fields };
              claimsByKey.set(fields.claim_key, row);
              return row;
            },
            deleteRow: async (rowId) => {
              for (const [key, row] of claimsByKey) {
                if (row.ROWID === rowId) {
                  claimsByKey.delete(key);
                  break;
                }
              }
            },
          };
        }
        // sync_logs / notifications — generic no-op stub.
        return {
          insertRow: async (fields) => ({ ROWID: 'generic', ...fields }),
          updateRow: async (fields) => fields,
          deleteRow: async () => {},
        };
      },
    }),
    _updatedRows: updatedRows,
    _insertedRows: insertedRows,
    _claimsByKey: claimsByKey,
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

function mockOauth(t) {
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
}

function mockOemFetchSequence(t, sequence) {
  let call = 0;
  t.mock.method(axios, 'get', async () => {
    const records = sequence[Math.min(call, sequence.length - 1)];
    call += 1;
    return { data: { data: records, info: { more_records: false } } };
  });
}

test('Test 1 — same dealer: two concurrent syncLeads() cannot both process a new record for the same dealer at once', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);

  const recordA = buildValidCrmRecord({ id: '8001', First_Name: 'Alice', Franchise_Code: 'AU100' });
  const recordB = buildValidCrmRecord({ id: '8002', First_Name: 'Bob', Franchise_Code: 'AU100' });

  // Invocation A's fetch resolves immediately; invocation B's resolves a
  // few ms later — just enough ordering to make A reliably reach (and
  // hold) the leadSync:AU100 claim before B attempts to acquire it, without
  // relying on true OS-thread races.
  let fetchCall = 0;
  t.mock.method(axios, 'get', async () => {
    fetchCall += 1;
    if (fetchCall === 1) return { data: { data: [recordA], info: { more_records: false } } };
    await delay(5);
    return { data: { data: [recordB], info: { more_records: false } } };
  });

  // Held for the duration of the dispatch call, keeping A's claim open
  // well past the point B attempts to acquire it — but well under the
  // leadSync claim's own retry backoff, so B's retry (not a permanent
  // skip) is what resolves the contention.
  let active = 0;
  let maxActive = 0;
  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(30);
    active -= 1;
    return { dealer_code: 'AU100', sync_status: 'Active' };
  });
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({
    ROWID: '900',
    integration_type: 'EXTERNAL_CRM',
  }));
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({ ok: true, scenarioCode: 'Happy 1' }));

  const catalystApp = buildFakeCatalystApp({ existingLeads: [] });

  const [resultA, resultB] = await Promise.all([
    leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' }),
    leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' }),
  ]);

  assert.equal(maxActive, 1, 'the two same-dealer new records must never be classified/dispatched at the exact same moment');

  const insertedIds = catalystApp._insertedRows.map((r) => r.crm_record_id).sort();
  assert.deepEqual(insertedIds, ['8001', '8002'], 'both records must eventually be processed in this pass — the losing invocation must retry and succeed once the claim is free, not be dropped until an unrelated future sync');

  // The claim must be released by the time both invocations have settled.
  assert.equal(catalystApp._claimsByKey.size, 0, 'the leadSync:AU100 claim must be released once processing finishes');

  assert.equal(resultA.recordsInserted + resultB.recordsInserted, 2);
});

test('Test 2 — different dealers: concurrent syncs for different dealers are not blocked by each other', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);

  const recordA = buildValidCrmRecord({ id: '9001', First_Name: 'Alice', Franchise_Code: 'AU100' });
  const recordB = buildValidCrmRecord({ id: '9002', First_Name: 'Bob', Franchise_Code: 'AU200' });

  let fetchCall = 0;
  t.mock.method(axios, 'get', async () => {
    fetchCall += 1;
    const records = fetchCall === 1 ? [recordA] : [recordB];
    return { data: { data: records, info: { more_records: false } } };
  });

  let active = 0;
  let maxActive = 0;
  t.mock.method(crmIntegrationService, 'findDealerByCode', async (_app, dealerCode) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(20);
    active -= 1;
    return { dealer_code: dealerCode, sync_status: 'Active' };
  });
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({
    ROWID: '900',
    integration_type: 'EXTERNAL_CRM',
  }));
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({ ok: true, scenarioCode: 'Happy 1' }));

  const catalystApp = buildFakeCatalystApp({ existingLeads: [] });

  await Promise.all([
    leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' }),
    leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' }),
  ]);

  assert.equal(maxActive, 2, 'AU100 and AU200 must be able to process their new leads concurrently — different dealers must never share a claim');
  const insertedIds = catalystApp._insertedRows.map((r) => r.crm_record_id).sort();
  assert.deepEqual(insertedIds, ['9001', '9002'], 'both dealers\' new leads must be processed, neither skipped');
});

test('Test 3 — duplicate behavior: a legitimate duplicate still reaches Happy Path 3 and never Dealer CRM', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);

  const original = buildValidCrmRecord({ id: '2001', Created_Time: '2026-01-01T00:00:00.000Z' });
  const duplicate = buildValidCrmRecord({ id: '2002', Created_Time: '2026-01-01T00:05:00.000Z' });
  mockOemFetchSequence(t, [[original, duplicate]]);

  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => ({ dealer_code: 'AU100', sync_status: 'Active' }));
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
  t.mock.method(axios, 'put', async () => ({ data: { data: [{ status: 'success', code: 'SUCCESS' }] } }));

  const catalystApp = buildFakeCatalystApp({ existingLeads: [] });

  const result = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(syncExternalSpy.mock.calls.length, 1, 'only the original lead may be dispatched');
  assert.equal(syncExternalSpy.mock.calls[0].arguments[2].crm_record_id, '2001');
  assert.equal(recordScenarioSpy.mock.calls.length, 1);
  assert.equal(recordScenarioSpy.mock.calls[0].arguments[1].scenarioCode, 'Happy 3');
  assert.equal(recordScenarioSpy.mock.calls[0].arguments[1].leadRow.crm_record_id, '2002');

  const duplicateInsert = catalystApp._insertedRows.find((r) => r.crm_record_id === '2002');
  assert.equal(duplicateInsert.sync_status, 'DUPLICATE_LINKED');
  assert.equal(result.scenarioCounts['Happy 3'], 1);
});

test('Test 4 — normal lead: a legitimate new lead still reaches Dealer CRM exactly as before', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);
  mockOemFetchSequence(t, [[buildValidCrmRecord({ id: '3001' })]]);

  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => ({ dealer_code: 'AU100', sync_status: 'Active' }));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({
    ROWID: '900',
    integration_type: 'EXTERNAL_CRM',
  }));
  const syncExternalSpy = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({
    ok: true,
    scenarioCode: 'Happy 1',
  }));

  const catalystApp = buildFakeCatalystApp({ existingLeads: [] });
  const result = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(syncExternalSpy.mock.calls.length, 1);
  assert.equal(result.recordsInserted, 1);
  const insert = catalystApp._insertedRows.find((r) => r.crm_record_id === '3001');
  assert.equal(insert.sync_status, 'PENDING');
});

test('Test 5 — claim release: a later sync can process another new lead for the same dealer once the first finishes', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);

  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => ({ dealer_code: 'AU100', sync_status: 'Active' }));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({
    ROWID: '900',
    integration_type: 'EXTERNAL_CRM',
  }));
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({ ok: true, scenarioCode: 'Happy 1' }));

  const catalystApp = buildFakeCatalystApp({ existingLeads: [] });

  mockOemFetchSequence(t, [[buildValidCrmRecord({ id: '4001', Franchise_Code: 'AU100' })]]);
  const firstResult = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
  assert.equal(firstResult.recordsInserted, 1);
  assert.equal(catalystApp._claimsByKey.size, 0, 'the claim must be released after the first run completes');

  mockOemFetchSequence(t, [[buildValidCrmRecord({ id: '4002', Franchise_Code: 'AU100' })]]);
  const secondResult = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(secondResult.recordsInserted, 1, 'a later, non-overlapping sync for the same dealer must not be blocked by a stale claim');
  const insertedIds = catalystApp._insertedRows.map((r) => r.crm_record_id).sort();
  assert.deepEqual(insertedIds, ['4001', '4002']);
});

test('Test 6 — failure release: the claim is not left permanently held if processing throws', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);

  const catalystApp = buildFakeCatalystApp({ existingLeads: [] });

  // customer_name 'TRIGGER_INSERT_FAILURE' makes the fake leads table's
  // insertRow throw — inside the claimed closure, before dispatch, so the
  // throw propagates through withOutboundSyncClaim's try/finally.
  mockOemFetchSequence(t, [[
    buildValidCrmRecord({ id: '5001', First_Name: 'TRIGGER_INSERT_FAILURE', Last_Name: '', Franchise_Code: 'AU100' }),
  ]]);

  const firstResult = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });
  assert.equal(firstResult.recordsFailed, 1, 'the simulated failure must be recorded as a failed record, not swallowed');
  assert.equal(catalystApp._claimsByKey.size, 0, 'the claim must be released even though the record failed');

  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => ({ dealer_code: 'AU100', sync_status: 'Active' }));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({
    ROWID: '900',
    integration_type: 'EXTERNAL_CRM',
  }));
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({ ok: true, scenarioCode: 'Happy 1' }));

  mockOemFetchSequence(t, [[buildValidCrmRecord({ id: '5002', Franchise_Code: 'AU100' })]]);
  const secondResult = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(secondResult.recordsInserted, 1, 'a later sync for the same dealer must succeed normally after the earlier failure released its claim');
});

test('Test 7 — existing DUPLICATE_LINKED + OEM edit guard remains intact', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);
  mockOemFetchSequence(t, [[buildValidCrmRecord({ id: '1001', Last_Name: 'Smith-Updated', Franchise_Code: 'AU100' })]]);

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

  assert.equal(getIntegrationSpy.mock.calls.length, 0);
  assert.equal(syncExternalSpy.mock.calls.length, 0);
  assert.equal(result.recordsUpdated, 1);
  const update = catalystApp._updatedRows.find((r) => r.ROWID === '501');
  assert.equal(update.sync_status, 'DUPLICATE_LINKED');
  assert.equal(update.customer_name, 'John Smith-Updated');
});

test('Test 8 — exhausted retries: a genuinely long-held claim is safely deferred, not crashed or force-processed', async (t) => {
  zohoAuthService._resetForTests();
  mockOauth(t);
  mockOemFetchSequence(t, [[buildValidCrmRecord({ id: '6001', Franchise_Code: 'AU100' })]]);

  const catalystApp = buildFakeCatalystApp({ existingLeads: [] });
  // Pre-seed a claim for this dealer that never gets released during the
  // run, simulating contention that outlasts every retry attempt.
  catalystApp._claimsByKey.set('leadSync:AU100', {
    ROWID: 'pre-existing-claim',
    claim_key: 'leadSync:AU100',
    claimed_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    request_reference: 'held-by-another-invocation',
  });

  const result = await leadSyncService.syncLeads(catalystApp, { trigger: 'Webhook', triggeredBy: 'Zoho CRM' });

  assert.equal(result.recordsInserted, 0, 'the record must be deferred, not inserted, when the claim stays held through every retry');
  assert.equal(result.recordsFailed, 0, 'an unavailable claim after retries must not be reported as a failure');
  assert.equal(catalystApp._insertedRows.length, 0);
});
