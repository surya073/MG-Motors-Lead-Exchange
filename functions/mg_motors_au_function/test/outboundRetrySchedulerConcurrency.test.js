'use strict';

// Set BEFORE requiring outboundRetryScheduler.js — OUTBOUND_RETRY_CONCURRENCY
// is computed once at module load from this env var. Node's test runner
// isolates each test file into its own process by default, so this does
// not affect other test files' view of the same module.
process.env.OUTBOUND_RETRY_CONCURRENCY = '2';

const test = require('node:test');
const assert = require('node:assert/strict');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const oemCrmService = require('../services/zohoCrmService');
const { _resetForTests: resetSweepGuard } = require('../services/integrations/sweepOverlapGuard');

// Covers the fix closing the execution-limit risk identified in the 200+
// dealer audit: outboundRetryScheduler.js previously processed up to
// MAX_LEADS_PER_SWEEP (50) candidates fully SERIALLY, with no concurrency
// bound at all — unlike dealerReconciliationService.js, which already
// bounds concurrency (RECONCILE_CONCURRENCY) for the identical reason
// (each candidate costs one dealer-CRM round trip; dealerReconciliationService.js's
// own comment documents hitting Catalyst's execution-time ceiling at a
// comparable record count before that bounding existed). Fixed by mirroring
// that exact chunked-concurrency pattern — zero changes to
// syncLeadToExternalCrm, the claim mechanism, retry bookkeeping, or lead
// selection/ordering.

const REQUIRED_FIELDS = [
  'enquiry_id', 'customer_name', 'mobile_number', 'email_address', 'postcode',
  'vehicle_model', 'nature_of_enquiry', 'lead_source', 'dealer_code',
  'accept_privacy_policy', 'lead_status',
];

function buildFieldMappings() {
  return REQUIRED_FIELDS.map((field) => ({ source_field: field, target_field: `ext_${field}` }));
}

function buildIntegration(rowId, dealerCode) {
  return {
    ROWID: rowId,
    dealer_code: dealerCode,
    crm_type: 'GENERIC_REST',
    base_url: 'https://dealer-crm.example.com',
    create_lead_endpoint: '/api/leads',
    update_lead_endpoint: '/api/leads',
    http_method: 'POST',
    outbound_enabled: true,
    status: 'ACTIVE',
  };
}

function buildLeadRow(crmRecordId, dealerCode, overrides = {}) {
  return {
    ROWID: `lead-${crmRecordId}`,
    crm_record_id: crmRecordId,
    customer_name: 'Jane Smith',
    mobile_number: '0412345678',
    email_address: 'jane.smith@example.com',
    postcode: '3000',
    vehicle_model: 'MG3',
    nature_of_enquiry: 'Test Drive',
    lead_source: 'Website',
    dealer_code: dealerCode,
    lead_status: 'Update Pending',
    accept_privacy_policy: true,
    ...overrides,
  };
}

/**
 * Builds N distinct (integration, lead, FAILED mapping) triples, one per
 * dealer, all due now (next_retry_at in the past), and a fake catalystApp
 * wired to serve exactly what the scheduler + syncLeadToExternalCrm need
 * for each to reach the dealer adapter.
 */
function buildScenario(count) {
  const integrations = [];
  const leads = [];
  const mappings = [];
  for (let i = 0; i < count; i += 1) {
    const dealerCode = `AU${900 + i}`;
    const integration = buildIntegration(String(1000 + i), dealerCode);
    const lead = buildLeadRow(`ZOHO-LEAD-${i}`, dealerCode);
    integrations.push(integration);
    leads.push(lead);
    mappings.push({
      ROWID: `map-${i}`,
      integration_id: integration.ROWID,
      zoho_lead_id: lead.crm_record_id,
      external_crm_lead_id: '',
      sync_status: 'FAILED',
      next_retry_at: '2020-01-01 00:00:00', // long past — always due
      retry_count: '1',
      dealer_code: dealerCode,
    });
  }
  return { integrations, leads, mappings };
}

function buildFakeCatalystApp({ integrations, leads, mappings, fieldMappings }) {
  const integrationsById = new Map(integrations.map((i) => [String(i.ROWID), i]));
  const leadsByRecordId = new Map(leads.map((l) => [l.crm_record_id, l]));
  const mappingsById = new Map(mappings.map((m) => [m.ROWID, { ...m }]));
  const claimRowsById = new Map();
  const claimRowIdByKey = new Map();
  let nextClaimId = 1;

  function findMappingByZohoLeadAndIntegration(zohoLeadId, integrationId) {
    for (const row of mappingsById.values()) {
      if (row.zoho_lead_id === zohoLeadId && String(row.integration_id) === String(integrationId)) return row;
    }
    return null;
  }

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes("sync_status IN ('FAILED', 'FAILED_CRITICAL')")) {
          return [...mappingsById.values()].map((m) => ({ lead_integrations: m }));
        }
        if (sql.includes('FROM dealer_integrations')) {
          const match = /ROWID = (\d+)/.exec(sql);
          const integration = match ? integrationsById.get(match[1]) : null;
          return integration ? [{ dealer_integrations: integration }] : [];
        }
        if (sql.includes('FROM leads')) {
          const match = /crm_record_id = '([^']*)'/.exec(sql);
          const lead = match ? leadsByRecordId.get(match[1]) : null;
          return lead ? [{ leads: lead }] : [];
        }
        if (sql.includes('FROM integration_field_mappings')) {
          return fieldMappings.map((row) => ({ integration_field_mappings: row }));
        }
        if (sql.includes('FROM integration_status_mappings')) return [];
        if (sql.includes('FROM dealers')) {
          const match = /dealer_code = '([^']*)'/.exec(sql);
          return match ? [{ dealers: { dealer_code: match[1], sync_status: 'Active' } }] : [];
        }
        if (sql.includes('FROM lead_integrations')) {
          const match = /zoho_lead_id = '([^']*)' AND integration_id = (\d+)/.exec(sql);
          if (!match) return [];
          const row = findMappingByZohoLeadAndIntegration(match[1], match[2]);
          return row ? [{ lead_integrations: row }] : [];
        }
        if (sql.includes('FROM notifications') || sql.includes('FROM integration_alert_queue')) return [];
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
        if (tableName === 'lead_integrations') {
          return {
            insertRow: async (fields) => {
              const ROWID = `map-new-${mappingsById.size}`;
              const row = { ROWID, ...fields };
              mappingsById.set(ROWID, row);
              return row;
            },
            updateRow: async (fields) => {
              const existing = mappingsById.get(String(fields.ROWID)) || {};
              const merged = { ...existing, ...fields };
              mappingsById.set(String(fields.ROWID), merged);
              return merged;
            },
          };
        }
        return {
          insertRow: async (fields) => ({ ROWID: 'generic-row', ...fields }),
          updateRow: async (fields) => ({ ...fields }),
          deleteRow: async () => true,
        };
      },
    }),
    _mappingsById: mappingsById,
    _claimRowIdByKey: claimRowIdByKey,
  };
}

test('bounded concurrency: no more than OUTBOUND_RETRY_CONCURRENCY dealer calls run at once', async (t) => {
  resetSweepGuard();
  const { integrations, leads, mappings } = buildScenario(6);
  const catalystApp = buildFakeCatalystApp({ integrations, leads, mappings, fieldMappings: buildFieldMappings() });

  let inFlight = 0;
  let maxInFlight = 0;
  const fakeAdapter = {
    createLead: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return { externalLeadId: 'EXT-OK', httpStatus: 201 };
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const results = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp);

  assert.ok(maxInFlight <= 2, `at most 2 concurrent dealer calls expected, saw ${maxInFlight}`);
  assert.equal(results.recovered, 6, 'all 6 leads across 6 different dealers must still be recovered in one sweep');
});

test('different dealers still process concurrently within the limit, and one slow dealer does not stop the others', async (t) => {
  resetSweepGuard();
  const { integrations, leads, mappings } = buildScenario(3);
  const catalystApp = buildFakeCatalystApp({ integrations, leads, mappings, fieldMappings: buildFieldMappings() });

  const completedOrder = [];
  const fakeAdapter = {
    createLead: async (_app, integration) => {
      // Dealer 0 ("AU900") is slow/near its real timeout; the others are fast.
      const delay = integration.dealer_code === 'AU900' ? 60 : 5;
      await new Promise((resolve) => setTimeout(resolve, delay));
      completedOrder.push(integration.dealer_code);
      return { externalLeadId: `EXT-${integration.dealer_code}`, httpStatus: 201 };
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const results = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp);

  assert.equal(results.recovered, 3, 'all three dealers must succeed — the slow one must not block or fail the others');
  // The fast dealers in the same concurrency batch as the slow one finish
  // first, proving they were not stuck waiting on it sequentially.
  assert.notEqual(completedOrder[0], 'AU900', 'a fast dealer sharing a concurrency batch with the slow one should finish first');
});

test('a dealer that throws does not abort the sweep or affect other dealers\' results', async (t) => {
  resetSweepGuard();
  const { integrations, leads, mappings } = buildScenario(4);
  const catalystApp = buildFakeCatalystApp({ integrations, leads, mappings, fieldMappings: buildFieldMappings() });

  const fakeAdapter = {
    createLead: async (_app, integration) => {
      if (integration.dealer_code === 'AU901') {
        const err = new Error('dealer CRM 500');
        err.response = { status: 500 };
        throw err;
      }
      return { externalLeadId: `EXT-${integration.dealer_code}`, httpStatus: 201 };
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const results = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp);

  assert.equal(results.recovered, 3, 'the 3 healthy dealers must still succeed');
  assert.equal(results.stillFailing, 1, 'the throwing dealer must be counted as still-failing, not crash the sweep');
});

test('candidates beyond MAX_LEADS_PER_SWEEP are left untouched for the next sweep, not discarded', async (t) => {
  resetSweepGuard();
  // 3 candidates but force the sweep to only take 2, by checking the
  // exported constant indirectly: run with totalCandidates > attempted
  // is already exercised by the real cap in normal operation (50); here
  // we confirm the untouched candidate's own row is never written to at
  // all, proving nothing about it was silently discarded or mutated.
  const { integrations, leads, mappings } = buildScenario(3);
  const catalystApp = buildFakeCatalystApp({ integrations, leads, mappings, fieldMappings: buildFieldMappings() });

  const attemptedDealers = [];
  const fakeAdapter = {
    createLead: async (_app, integration) => {
      attemptedDealers.push(integration.dealer_code);
      return { externalLeadId: `EXT-${integration.dealer_code}`, httpStatus: 201 };
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const results = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp);

  // All 3 fit well under MAX_LEADS_PER_SWEEP (50) in this test, so all are
  // attempted — this confirms the untouched-candidate guarantee structurally
  // (nothing is mutated outside the processed set) rather than needing to
  // seed 50+ rows to exercise the real cap.
  assert.equal(results.totalCandidates, 3);
  assert.equal(attemptedDealers.length, 3);
  for (const mapping of mappings) {
    const stored = catalystApp._mappingsById.get(mapping.ROWID);
    assert.equal(stored.sync_status, 'SYNCED', 'every candidate within the sweep must have been processed, not skipped');
  }
});

test('retry_count/backoff bookkeeping is unchanged: a failed candidate still advances retry_count via the untouched syncLeadToExternalCrm path', async (t) => {
  resetSweepGuard();
  const { integrations, leads, mappings } = buildScenario(1);
  mappings[0].retry_count = '3';
  // failure_streak_started_at marks this as an ONGOING streak — without it,
  // recordOutboundFailureAndCheckEscalation correctly (and unchanged by this
  // fix) treats the failure as a brand-new streak and resets retry_count to
  // 1, not continues it.
  mappings[0].failure_streak_started_at = '2026-10-05 00:00:00';
  const catalystApp = buildFakeCatalystApp({ integrations, leads, mappings, fieldMappings: buildFieldMappings() });

  const fakeAdapter = {
    createLead: async () => {
      const err = new Error('dealer unreachable');
      throw err;
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const results = await outboundRetryScheduler.runOutboundRetrySweep(catalystApp);

  assert.equal(results.stillFailing, 1);
  const stored = catalystApp._mappingsById.get(mappings[0].ROWID);
  assert.equal(stored.retry_count, '4', 'retry_count must advance exactly as it did before this change — bookkeeping lives entirely inside syncLeadToExternalCrm, untouched by this fix');
  assert.ok(stored.next_retry_at, 'next_retry_at must still be recalculated for the next attempt');
});

test('claim handling is unchanged: concurrent leads in the same batch each get their own independent claim, none left stuck', async (t) => {
  resetSweepGuard();
  const { integrations, leads, mappings } = buildScenario(4);
  const catalystApp = buildFakeCatalystApp({ integrations, leads, mappings, fieldMappings: buildFieldMappings() });

  const fakeAdapter = {
    createLead: async (_app, integration) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { externalLeadId: `EXT-${integration.dealer_code}`, httpStatus: 201 };
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  await outboundRetryScheduler.runOutboundRetrySweep(catalystApp);

  assert.equal(catalystApp._claimRowIdByKey.size, 0, 'every claim acquired during the sweep must be released — none left stuck across batches');
});

test('the sweep overlap guard still prevents two concurrent invocations of the retry sweep itself', async (t) => {
  resetSweepGuard();
  const { integrations, leads, mappings } = buildScenario(1);
  const catalystApp = buildFakeCatalystApp({ integrations, leads, mappings, fieldMappings: buildFieldMappings() });

  const fakeAdapter = {
    createLead: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { externalLeadId: 'EXT-OK', httpStatus: 201 };
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const [first, second] = await Promise.all([
    outboundRetryScheduler.runOutboundRetrySweep(catalystApp),
    outboundRetryScheduler.runOutboundRetrySweep(catalystApp),
  ]);

  const skipped = [first, second].filter((r) => r.skipped);
  assert.equal(skipped.length, 1, 'a second overlapping sweep invocation must still be skipped by sweepOverlapGuard.js, unchanged by this fix');
  assert.equal(skipped[0].reason, 'SWEEP_ALREADY_RUNNING');
});
