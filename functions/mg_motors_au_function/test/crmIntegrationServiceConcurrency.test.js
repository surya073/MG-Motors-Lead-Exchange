'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const oemCrmService = require('../services/zohoCrmService');

// End-to-end proof (through the real syncLeadToExternalCrm, not just the
// claim helper in isolation) that the cross-instance duplicate-lead fix
// is actually wired in: two simultaneous calls for the SAME brand-new
// lead must result in exactly ONE call to the dealer CRM adapter's
// createLead, covering the "remote CRM timeout" scenario (point 5 of the
// task) — a slow adapter response must not let a second concurrent call
// (e.g. a retry sweep racing the original webhook-triggered sync) also
// create the lead at the dealer.

const REQUIRED_FIELDS = [
  'enquiry_id', 'customer_name', 'mobile_number', 'email_address', 'postcode',
  'vehicle_model', 'nature_of_enquiry', 'lead_source', 'dealer_code',
  'accept_privacy_policy', 'lead_status',
];

function buildFieldMappings() {
  return REQUIRED_FIELDS.map((field) => ({
    source_field: field,
    target_field: `ext_${field}`,
  }));
}

function buildIntegration(overrides = {}) {
  return {
    ROWID: '501',
    dealer_code: 'AU777',
    crm_type: 'GENERIC_REST',
    base_url: 'https://dealer-crm.example.com',
    create_lead_endpoint: '/api/leads',
    update_lead_endpoint: '/api/leads',
    http_method: 'POST',
    outbound_enabled: true,
    status: 'ACTIVE',
    ...overrides,
  };
}

function buildLeadRow(overrides = {}) {
  return {
    ROWID: '9001',
    crm_record_id: 'ZOHO-LEAD-1',
    customer_name: 'Jane Smith',
    mobile_number: '0412345678',
    email_address: 'jane.smith@example.com',
    postcode: '3000',
    vehicle_model: 'MG3',
    nature_of_enquiry: 'Test Drive',
    lead_source: 'Website',
    dealer_code: 'AU777',
    // Deliberately OEM-only so buildOutboundPayload/validateIntegrationConfiguration
    // don't also require a configured status mapping for this test.
    lead_status: 'Update Pending',
    accept_privacy_policy: true,
    ...overrides,
  };
}

/**
 * Generic fake catalystApp covering every table syncLeadToExternalCrm
 * touches on a first-time CREATE_LEAD success path, PLUS a faithful
 * unique-constraint simulation for outbound_sync_claims (see
 * outboundSyncClaimService.test.js for why this fake is a trustworthy
 * stand-in for that specific behavior).
 */
function buildFakeCatalystApp({ fieldMappings, dealerRow }) {
  const claimRowsById = new Map();
  const claimRowIdByKey = new Map();
  let nextClaimId = 1;

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM dealers')) {
          return dealerRow ? [{ dealers: dealerRow }] : [];
        }
        if (sql.includes('FROM integration_field_mappings')) {
          return fieldMappings.map((row) => ({ integration_field_mappings: row }));
        }
        if (sql.includes('FROM integration_status_mappings')) {
          return [];
        }
        if (sql.includes('FROM lead_integrations')) {
          return []; // no existing mapping — every caller sees a brand-new lead
        }
        if (sql.includes('FROM leads')) {
          return []; // writeLog's scenario-mirror lookup — fine to no-op
        }
        if (sql.includes('claim_key')) {
          const match = /claim_key = '([^']*)'/.exec(sql);
          const rowId = match ? claimRowIdByKey.get(match[1]) : null;
          return rowId ? [{ outbound_sync_claims: claimRowsById.get(rowId) }] : [];
        }
        throw new Error(`Unexpected ZCQL query in test: ${sql}`);
      },
    }),
    datastore: () => ({
      table: (tableName) => {
        if (tableName === 'outbound_sync_claims') {
          return {
            insertRow: async (fields) => {
              if (claimRowIdByKey.has(fields.claim_key)) {
                const err = new Error(`Duplicate value for unique column 'claim_key'`);
                err.code = 'datastore/DuplicateData';
                throw err;
              }
              const ROWID = String(nextClaimId++);
              const row = { ROWID, ...fields };
              claimRowsById.set(ROWID, row);
              claimRowIdByKey.set(fields.claim_key, ROWID);
              return row;
            },
            deleteRow: async (rowId) => {
              const row = claimRowsById.get(String(rowId));
              if (row) {
                claimRowIdByKey.delete(row.claim_key);
                claimRowsById.delete(String(rowId));
              }
              return true;
            },
          };
        }
        // lead_integrations (mapping insert), leads (status/stamp
        // updates), dealer_integrations (last_sync_at/status),
        // integration_logs (writeLog) — none of these need to retain
        // state for this test's assertions, only to succeed.
        return {
          insertRow: async (fields) => ({ ROWID: 'generic-row', ...fields }),
          updateRow: async (fields) => ({ ...fields }),
        };
      },
    }),
  };
}

test('syncLeadToExternalCrm: two simultaneous syncs for the same brand-new lead create the dealer record exactly once', async (t) => {
  const createCalls = [];
  const fakeAdapter = {
    createLead: async (_app, _integration, payload) => {
      createCalls.push(payload);
      // Simulates a slow dealer CRM — the exact window the original race
      // exploited (the mapping row is only written AFTER this resolves).
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { externalLeadId: 'DEALER-LEAD-1', httpStatus: 201 };
    },
    updateLead: async () => {
      throw new Error('updateLead should never be called — both callers see a brand-new lead');
    },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const fieldMappings = buildFieldMappings();
  const integration = buildIntegration();
  const leadRow = buildLeadRow();
  const catalystApp = buildFakeCatalystApp({
    fieldMappings,
    dealerRow: { dealer_code: 'AU777', sync_status: 'Active' },
  });

  const [first, second] = await Promise.all([
    crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow),
    crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow),
  ]);

  assert.equal(createCalls.length, 1, 'the dealer CRM must receive exactly one create-lead call for two simultaneous syncs');

  const outcomes = [first, second];
  const delivered = outcomes.filter((o) => o.ok);
  const skipped = outcomes.filter((o) => o.skipped);
  assert.equal(delivered.length, 1, 'exactly one of the two calls should report a successful delivery');
  assert.equal(skipped.length, 1, 'the other call must be skipped, not silently dropped or duplicated');
  assert.equal(skipped[0].reason, 'CONCURRENT_SYNC_IN_PROGRESS');
  assert.equal(delivered[0].externalLeadId, 'DEALER-LEAD-1');
});

test('syncLeadToExternalCrm: after a completed sync, a later independent call is NOT blocked (legitimate retry/update still works)', async (t) => {
  let createCallCount = 0;
  const fakeAdapter = {
    createLead: async () => {
      createCallCount += 1;
      return { externalLeadId: 'DEALER-LEAD-2', httpStatus: 201 };
    },
    updateLead: async () => {
      throw new Error('not expected in this test');
    },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const fieldMappings = buildFieldMappings();
  const integration = buildIntegration({ ROWID: '502' });
  const leadRow = buildLeadRow({ crm_record_id: 'ZOHO-LEAD-2', ROWID: '9002' });
  const catalystApp = buildFakeCatalystApp({
    fieldMappings,
    dealerRow: { dealer_code: 'AU777', sync_status: 'Active' },
  });

  const firstOutcome = await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
  assert.equal(firstOutcome.ok, true);

  // Second call sees the SAME lead_integrations fixture returning [] (this
  // fake always reports "no existing mapping"), which is fine here — the
  // only thing under test is that the CLAIM itself does not leak across
  // calls and permanently block a lead after a completed attempt.
  const secondOutcome = await crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow);
  assert.equal(secondOutcome.ok, true, 'the claim must not outlive its attempt and block a later, non-concurrent call');
  assert.equal(createCallCount, 2);
});
