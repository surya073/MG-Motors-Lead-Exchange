'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const oemCrmService = require('../services/zohoCrmService');

// Regression test for a confirmed correctness bug found while auditing the
// sequential outbound sync flow: DEALER_ACK_MISSING_ID (the dealer accepts
// a create-lead request but returns no record ID) used to be excluded from
// recordOutboundFailureAndCheckEscalation entirely. That meant:
//   (a) a brand-new lead got NO lead_integrations row at all, making it
//       invisible to outboundRetryScheduler.js's retry sweep forever, and
//   (b) a repeat occurrence never advanced retry_count/next_retry_at/
//       failure_streak_started_at, so backoff never increased and the
//       Unhappy 3 escalation window could never trip.
// Fixed in crmIntegrationService.js by removing the DEALER_ACK_MISSING_ID
// exclusion so it is tracked exactly like any other retryable failure.

const REQUIRED_FIELDS = [
  'enquiry_id', 'customer_name', 'mobile_number', 'email_address', 'postcode',
  'vehicle_model', 'nature_of_enquiry', 'lead_source', 'dealer_code',
  'accept_privacy_policy', 'lead_status',
];

function buildFieldMappings() {
  return REQUIRED_FIELDS.map((field) => ({ source_field: field, target_field: `ext_${field}` }));
}

function buildIntegration(overrides = {}) {
  return {
    ROWID: '601',
    dealer_code: 'AU888',
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
    ROWID: '9101',
    crm_record_id: 'ZOHO-LEAD-ACK-1',
    customer_name: 'John Doe',
    mobile_number: '0412345678',
    email_address: 'john.doe@example.com',
    postcode: '3000',
    vehicle_model: 'MG3',
    nature_of_enquiry: 'Test Drive',
    lead_source: 'Website',
    dealer_code: 'AU888',
    lead_status: 'Update Pending', // OEM-only, bypasses status-mapping requirement
    accept_privacy_policy: true,
    ...overrides,
  };
}

/**
 * Fake catalystApp that actually RETAINS lead_integrations rows across
 * zcql/datastore calls (unlike the concurrency test's fake, which always
 * reported "no existing mapping") — needed here to prove the mapping row
 * really gets created/updated on a DEALER_ACK_MISSING_ID failure.
 */
function buildStatefulFakeCatalystApp({ fieldMappings, dealerRow }) {
  const leadIntegrationsById = new Map();
  let nextRowId = 1;

  const findMapping = (integrationId, zohoLeadId) => {
    for (const row of leadIntegrationsById.values()) {
      if (String(row.integration_id) === String(integrationId) && row.zoho_lead_id === zohoLeadId) return row;
    }
    return null;
  };

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM dealers')) return dealerRow ? [{ dealers: dealerRow }] : [];
        if (sql.includes('FROM integration_field_mappings')) {
          return fieldMappings.map((row) => ({ integration_field_mappings: row }));
        }
        if (sql.includes('FROM integration_status_mappings')) return [];
        if (sql.includes('FROM lead_integrations')) {
          const match = /zoho_lead_id = '([^']*)' AND integration_id = (\d+)/.exec(sql);
          if (!match) return [];
          const row = findMapping(match[2], match[1]);
          return row ? [{ lead_integrations: row }] : [];
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
              const ROWID = String(nextRowId++);
              const row = { ROWID, ...fields };
              leadIntegrationsById.set(ROWID, row);
              return row;
            },
            updateRow: async (fields) => {
              const existing = leadIntegrationsById.get(String(fields.ROWID)) || {};
              const merged = { ...existing, ...fields };
              leadIntegrationsById.set(String(fields.ROWID), merged);
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
    _leadIntegrationsById: leadIntegrationsById,
  };
}

test('syncLeadToExternalCrm: DEALER_ACK_MISSING_ID on a brand-new lead creates a trackable lead_integrations row', async (t) => {
  const fakeAdapter = {
    createLead: async () => ({ externalLeadId: undefined, httpStatus: 201 }), // accepted, no ID
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const integration = buildIntegration();
  const leadRow = buildLeadRow();
  const catalystApp = buildStatefulFakeCatalystApp({
    fieldMappings: buildFieldMappings(),
    dealerRow: { dealer_code: 'AU888', sync_status: 'Active' },
  });

  await assert.rejects(
    () => crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow),
    (err) => err.code === 'DEALER_ACK_MISSING_ID'
  );

  assert.equal(catalystApp._leadIntegrationsById.size, 1, 'a lead_integrations row must exist so the retry sweep can find this lead');
  const row = [...catalystApp._leadIntegrationsById.values()][0];
  assert.equal(row.sync_status, 'FAILED');
  assert.equal(row.retry_count, '1');
  assert.ok(row.next_retry_at, 'next_retry_at must be set so outboundRetryScheduler.js picks this lead up again');
  assert.ok(row.failure_streak_started_at, 'failure_streak_started_at must be set so Unhappy 3 escalation can eventually trip');
});

test('syncLeadToExternalCrm: a repeat DEALER_ACK_MISSING_ID failure advances retry_count instead of freezing it', async (t) => {
  const fakeAdapter = {
    createLead: async () => ({ externalLeadId: undefined, httpStatus: 201 }),
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  const integration = buildIntegration({ ROWID: '602' });
  const leadRow = buildLeadRow({ crm_record_id: 'ZOHO-LEAD-ACK-2', ROWID: '9102' });
  const catalystApp = buildStatefulFakeCatalystApp({
    fieldMappings: buildFieldMappings(),
    dealerRow: { dealer_code: 'AU888', sync_status: 'Active' },
  });

  await assert.rejects(() => crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow));
  await assert.rejects(() => crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow));

  assert.equal(catalystApp._leadIntegrationsById.size, 1, 'the second attempt must update the SAME row, not create a duplicate');
  const row = [...catalystApp._leadIntegrationsById.values()][0];
  assert.equal(row.retry_count, '2', 'retry_count must advance on a repeat failure instead of staying frozen');
});
