'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const leadMapping = require('../services/integrations/leadMappingService');
const fingerprint = require('../services/integrations/leadFingerprintService');
const crmIntegration = require('../services/integrations/crmIntegrationService');
const syncLog = require('../services/syncLogService');

const fieldMappings = [
  { source_field: 'customer_name', target_field: 'CustomerName', required: true },
  { source_field: 'lead_status', target_field: 'DealerStatus', required: true },
  { source_field: 'dealer_remarks', target_field: 'Notes', required: false },
];
const statusMappings = [
  { source_status: 'Update Pending', target_status: 'New', direction: 'ZOHO_TO_EXTERNAL' },
  { source_status: 'New', target_status: 'Not Contacted', direction: 'EXTERNAL_TO_ZOHO' },
  { source_status: 'Lost', target_status: 'Lost', direction: 'ZOHO_TO_EXTERNAL' },
  { source_status: 'Lost', target_status: 'Lost', direction: 'EXTERNAL_TO_ZOHO' },
];

test('status maps in the correct direction with normalized labels', () => {
  assert.equal(leadMapping.mapStatus('Update-Pending', statusMappings, 'ZOHO_TO_EXTERNAL'), 'New');
  assert.equal(leadMapping.mapStatus('new', statusMappings, 'EXTERNAL_TO_ZOHO'), 'Not Contacted');
});

test('outbound payload writes one translated status to the configured target', () => {
  const payload = crmIntegration._test.buildOutboundPayload({
    crm_record_id: 'MG-1',
    customer_name: 'Alex Morgan',
    lead_status: 'Lost',
    dealer_remarks: 'hello',
  }, fieldMappings, statusMappings);
  assert.deepEqual(payload, {
    CustomerName: 'Alex Morgan',
    Notes: 'hello',
    DealerStatus: 'Lost',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'status'), false);
  assert.equal(Object.values(payload).includes('Update Pending'), false);
});

test('MG-only workflow status is not invented in the dealer payload', () => {
  const payload = crmIntegration._test.buildOutboundPayload({
    crm_record_id: 'MG-2',
    customer_name: 'Alex Morgan',
    lead_status: 'Update Pending',
  }, fieldMappings, statusMappings);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'DealerStatus'), false);
});

test('both directions produce the same canonical fingerprint and real changes differ', () => {
  const existing = {
    customer_name: 'Alex Morgan',
    lead_status: 'Not Contacted',
    dealer_remarks: '',
  };
  const outbound = fingerprint.computeFingerprint(existing, fieldMappings);
  const echo = fingerprint.computeProjectedInboundFingerprint(existing, {}, fieldMappings);
  const changed = fingerprint.computeProjectedInboundFingerprint(
    existing,
    { lead_status: 'Contacted' },
    fieldMappings
  );
  assert.equal(echo, outbound);
  assert.notEqual(changed, outbound);
});

test('classifier honors explicit paths and treats Lost as Happy 2', () => {
  assert.equal(crmIntegration._test.classifyLogScenario({
    direction: 'EXTERNAL_CRM_TO_ZOHO', operation: 'UPDATE_LEAD', status: 'SUCCESS',
  }, { isStatusSync: true, rawDealerStatus: 'Lost' }).code, 'Happy 2');
  assert.equal(crmIntegration._test.classifyLogScenario({
    direction: 'EXTERNAL_CRM_TO_ZOHO', operation: 'UPDATE_LEAD', status: 'SUCCESS',
  }, { isStatusSync: true, rawDealerStatus: 'Junk Lead' }).code, 'Unhappy 9');
  assert.equal(crmIntegration._test.classifyLogScenario({
    direction: 'ZOHO_TO_EXTERNAL_CRM', operation: 'CREATE_LEAD', status: 'FAILED',
  }, { scenarioCode: 'Unhappy 5' }).code, 'Unhappy 5');
});

test('delivery configuration requires every mandatory map and the current status map', () => {
  const requiredFields = require('../services/integrations/pathPolicyService')
    .REQUIRED_DELIVERY_MAPPING_FIELDS
    .map((source_field) => ({ source_field, target_field: `dealer_${source_field}` }));
  const integration = {
    base_url: 'https://dealer.example.com',
    create_lead_endpoint: '/leads',
    update_lead_endpoint: '/leads/{externalLeadId}',
  };
  assert.equal(crmIntegration._test.validateIntegrationConfiguration(
    integration,
    requiredFields,
    statusMappings,
    'Update Pending'
  ).valid, true);
  assert.equal(crmIntegration._test.validateIntegrationConfiguration(
    integration,
    requiredFields.slice(1),
    statusMappings,
    'Update Pending'
  ).valid, false);
  assert.equal(crmIntegration._test.validateIntegrationConfiguration(
    integration,
    requiredFields,
    statusMappings,
    'Contacted'
  ).valid, false);
});

test('sync summary does not call unchanged rows duplicates', () => {
  const counts = syncLog.buildScenarioBreakdown({
    syncType: 'Lead_Sync',
    syncTrigger: 'Scheduled',
    totalRecordsFetched: 12,
    recordsInserted: 0,
    recordsUpdated: 0,
    recordsFailed: 0,
    errorDetails: [],
  });
  assert.equal(counts.has('happy-3'), false);

  const explicit = syncLog.buildScenarioBreakdown({
    scenarioCounts: { 'Happy 3': 1, 'Unhappy 2': 2 },
  });
  assert.equal(explicit.get('happy-3'), 1);
  assert.equal(explicit.get('unhappy-2'), 2);
});

test('webhook dedupe never mistakes a record id or identical Zoho envelope for an event id', async () => {
  const seen = new Set();
  const catalystApp = {
    datastore: () => ({
      table: () => ({
        insertRow: async (row) => {
          if (seen.has(row.dedupe_key)) {
            const err = new Error('duplicate unique value');
            err.code = 'DUPLICATE_DATA';
            throw err;
          }
          seen.add(row.dedupe_key);
          return { ROWID: String(seen.size) };
        },
      }),
    }),
  };
  const integration = { ROWID: '9', dealer_code: 'D001' };
  const body = Buffer.from(JSON.stringify({ ids: ['dealer-lead-1'], affected_fields: ['Lead_Status'] }));

  const noIdFirst = await crmIntegration.checkAndRecordWebhookEvent(catalystApp, integration, body, null);
  const noIdSecond = await crmIntegration.checkAndRecordWebhookEvent(catalystApp, integration, body, null);
  assert.equal(noIdFirst.isDuplicate, false);
  assert.equal(noIdSecond.isDuplicate, false);

  const eventFirst = await crmIntegration.checkAndRecordWebhookEvent(catalystApp, integration, body, 'evt-1');
  const eventRetry = await crmIntegration.checkAndRecordWebhookEvent(catalystApp, integration, body, 'evt-1');
  assert.equal(eventFirst.isDuplicate, false);
  assert.equal(eventRetry.isDuplicate, true);
});
