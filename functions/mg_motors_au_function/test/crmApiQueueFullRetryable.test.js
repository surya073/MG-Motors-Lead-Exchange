'use strict';

// limit=1, maxQueueDepth=0: with the single slot already marked occupied
// (seeded directly below, not via a racing second call), any further
// acquire() for this crm_type rejects immediately with CRM_API_QUEUE_FULL.
process.env.CRM_API_CONCURRENCY_LIMIT = '1';
process.env.CRM_API_MAX_QUEUE_DEPTH = '0';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const oemCrmService = require('../services/zohoCrmService');
const { _test: limiterTest } = require('../services/integrations/crmApiConcurrencyLimiter');

// Covers requirement 11 of the queue-depth fix: a CRM_API_QUEUE_FULL
// rejection must be classified and handled exactly like any other
// transient/retryable CRM failure by the EXISTING error-handling path in
// crmIntegrationService.js — no new retry mechanism introduced.
//
// The single concurrency slot is seeded directly on the semaphore
// (deterministic, no timing assumptions) rather than occupied by a second
// real in-flight call — racing two real calls against a shared mock
// adapter/resolver introduced its own flakiness unrelated to what this
// test is actually verifying.

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
        throw new Error(`Unexpected ZCQL query in test: ${sql}`);
      },
    }),
    datastore: () => ({
      table: (tableName) => {
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
  };
}

test('CRM_API_QUEUE_FULL is classified as retryable: retry_count still advances, exactly like any other transient CRM failure', async (t) => {
  limiterTest._resetForTests();
  const fieldMappings = buildFieldMappings();
  const integration = buildIntegration('901', 'AU901');
  const leadRow = buildLeadRow('ZOHO-QUEUE-FULL-1', 'AU901');
  const existingMapping = {
    ROWID: 'map-qf-1',
    integration_id: integration.ROWID,
    zoho_lead_id: leadRow.crm_record_id,
    external_crm_lead_id: '',
    sync_status: 'FAILED',
    retry_count: '1',
    failure_streak_started_at: '2026-10-05 00:00:00',
  };
  const catalystApp = buildFakeCatalystApp({ fieldMappings, dealerCode: 'AU901', mapping: existingMapping });

  t.mock.method(crmAdapterFactory, 'getAdapter', () => ({
    createLead: async () => { throw new Error('must never be called — the queue is full before this point'); },
    updateLead: async () => { throw new Error('not expected'); },
  }));
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  // Deterministically occupy the single GENERIC_REST slot — no racing
  // real call, no timing assumption.
  const semaphore = limiterTest.getSemaphore('GENERIC_REST');
  semaphore.active = 1;

  await assert.rejects(
    () => crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow),
    (err) => {
      assert.equal(err.code, 'CRM_API_QUEUE_FULL');
      return true;
    }
  );

  const stored = catalystApp._mappingsById.get(existingMapping.ROWID);
  assert.equal(stored.sync_status, 'FAILED', 'a queue-full rejection must be tracked as an ordinary retryable failure, not a non-retryable hold');
  assert.equal(stored.retry_count, '2', 'retry_count must advance exactly as it would for any other transient CRM error — no special-casing, no new retry mechanism');
  assert.ok(stored.next_retry_at, 'next_retry_at must still be recalculated so the existing retry sweep picks this up again');
});
