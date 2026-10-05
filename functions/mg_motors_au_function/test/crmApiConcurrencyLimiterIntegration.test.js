'use strict';

// Force the limiter to actually be the bottleneck (default is 10, which
// would never engage for these small tests) so retry/claim behavior is
// verified while genuinely queueing behind it, not just passively unaffected.
process.env.CRM_API_CONCURRENCY_LIMIT = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const oemCrmService = require('../services/zohoCrmService');

// Covers requirements 7 & 8 of the CRM API concurrency fix: existing
// retry/backoff bookkeeping and existing outbound claim behavior must be
// completely unaffected by the new per-crm_type concurrency limiter now
// wrapping the actual adapter.createLead/updateLead/getLead calls.

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

function buildLeadRow(crmRecordId, dealerCode) {
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
  };
}

function buildFakeCatalystApp({ fieldMappings, dealerCode, mapping }) {
  const claimRowsById = new Map();
  const claimRowIdByKey = new Map();
  let nextClaimId = 1;
  const mappingsById = new Map(mapping ? [[mapping.ROWID, { ...mapping }]] : []);

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM dealers')) return [{ dealers: { dealer_code: dealerCode, sync_status: 'Active' } }];
        if (sql.includes('FROM integration_field_mappings')) {
          return fieldMappings.map((row) => ({ integration_field_mappings: row }));
        }
        if (sql.includes('FROM integration_status_mappings')) return [];
        if (sql.includes('FROM lead_integrations')) {
          const match = /zoho_lead_id = '([^']*)' AND integration_id = (\d+)/.exec(sql);
          if (!match) return [];
          for (const row of mappingsById.values()) {
            if (row.zoho_lead_id === match[1] && String(row.integration_id) === match[2]) {
              return [{ lead_integrations: row }];
            }
          }
          return [];
        }
        if (sql.includes('FROM leads')) return [];
        if (sql.includes('FROM notifications') || sql.includes('FROM integration_alert_queue')) return [];
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
    _claimRowIdByKey: claimRowIdByKey,
    _mappingsById: mappingsById,
  };
}

test('claim behaviour preserved: two different leads queue behind the CRM API limiter but each still gets its own independent claim', async (t) => {
  const fieldMappings = buildFieldMappings();
  const integrationA = buildIntegration('701', 'AU701');
  const integrationB = buildIntegration('702', 'AU702');
  const leadA = buildLeadRow('ZOHO-LIMIT-A', 'AU701');
  const leadB = buildLeadRow('ZOHO-LIMIT-B', 'AU702');
  const catalystAppA = buildFakeCatalystApp({ fieldMappings, dealerCode: 'AU701' });
  const catalystAppB = buildFakeCatalystApp({ fieldMappings, dealerCode: 'AU702' });

  let concurrentAdapterCalls = 0;
  let maxConcurrentAdapterCalls = 0;
  const fakeAdapter = {
    createLead: async () => {
      concurrentAdapterCalls += 1;
      maxConcurrentAdapterCalls = Math.max(maxConcurrentAdapterCalls, concurrentAdapterCalls);
      await new Promise((resolve) => setTimeout(resolve, 15));
      concurrentAdapterCalls -= 1;
      return { externalLeadId: 'EXT-OK', httpStatus: 201 };
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const [resultA, resultB] = await Promise.all([
    crmIntegrationService.syncLeadToExternalCrm(catalystAppA, integrationA, leadA),
    crmIntegrationService.syncLeadToExternalCrm(catalystAppB, integrationB, leadB),
  ]);

  // Both leads use crm_type GENERIC_REST, so with CRM_API_CONCURRENCY_LIMIT=1
  // the adapter calls must have been serialized by the limiter...
  assert.equal(maxConcurrentAdapterCalls, 1, 'the limiter (set to 1) must serialize both dealer-CRM calls');
  // ...yet BOTH leads must still succeed — the limiter only delays, it
  // never denies, and each lead's own independent claim (different
  // integration_id:zoho_lead_id keys) was never contended at all.
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  assert.equal(catalystAppA._claimRowIdByKey.size, 0, "lead A's claim must be released");
  assert.equal(catalystAppB._claimRowIdByKey.size, 0, "lead B's claim must be released");
});

test('retry bookkeeping preserved: a failed attempt still advances retry_count/backoff correctly while queued behind the limiter', async (t) => {
  const fieldMappings = buildFieldMappings();
  const integration = buildIntegration('703', 'AU703');
  const leadRow = buildLeadRow('ZOHO-LIMIT-RETRY', 'AU703');
  const existingMapping = {
    ROWID: 'map-retry-1',
    integration_id: integration.ROWID,
    zoho_lead_id: leadRow.crm_record_id,
    external_crm_lead_id: '',
    sync_status: 'FAILED',
    retry_count: '2',
    failure_streak_started_at: '2026-10-05 00:00:00',
  };
  const catalystApp = buildFakeCatalystApp({ fieldMappings, dealerCode: 'AU703', mapping: existingMapping });

  const fakeAdapter = {
    createLead: async () => {
      throw new Error('dealer unreachable');
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  await assert.rejects(() => crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow));

  const stored = catalystApp._mappingsById.get(existingMapping.ROWID);
  assert.equal(stored.retry_count, '3', 'retry_count must still advance exactly as before — the limiter only adds a queueing delay around the adapter call, it never touches bookkeeping');
  assert.ok(stored.next_retry_at, 'next_retry_at must still be recalculated');
});
