'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../services/integrations/crmIntegrationService');

const { processResolvedInboundLead } = _test;

// Regression test for a confirmed correctness bug found while auditing the
// sequential inbound (dealer -> MG) sync flow: processResolvedInboundLead
// used one try/catch around THREE sequential writes — the real MG Zoho
// update, a local `leads` mirror update, and a `lead_integrations`
// bookkeeping update — and treated any exception from any of the three
// identically as "MG CRM could not be updated" (Unhappy 4 transport
// failure). If the MG write actually succeeded and only the LOCAL
// bookkeeping write failed afterward, this produced a false alert saying
// MG was unreachable when it wasn't. Fixed by tracking whether the MG
// write itself succeeded and classifying a later local failure under a
// distinct, accurate category instead.

const FIELD_MAPPINGS = [{ source_field: 'vehicle_model', target_field: 'Enquiry_Model' }];

function buildIntegration(overrides = {}) {
  return { ROWID: '701', dealer_code: 'AU555', ...overrides };
}

function buildExistingLeadRow(overrides = {}) {
  return {
    ROWID: '9301',
    crm_record_id: 'ZOHO-LEAD-WB-1',
    dealer_code: 'AU555',
    vehicle_model: 'MG3',
    ...overrides,
  };
}

function buildMapping(overrides = {}) {
  return {
    ROWID: 'map-1',
    zoho_lead_id: 'ZOHO-LEAD-WB-1',
    external_crm_lead_id: 'EXT-1',
    sync_status: 'SYNCED',
    last_sync_direction: 'EXTERNAL_CRM_TO_ZOHO',
    last_error: '',
    ...overrides,
  };
}

/**
 * Fake catalystApp covering exactly what processResolvedInboundLead needs
 * up to and through the write-back section. `onLeadsUpdate` and
 * `onMappingUpdate` let each test inject a failure at a specific step.
 */
function buildFakeCatalystApp({ mapping, existingLeadRow, onLeadsUpdate, onMappingUpdate }) {
  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM lead_integrations')) return [{ lead_integrations: mapping }];
        if (sql.includes('FROM leads')) return [{ leads: existingLeadRow }];
        if (sql.includes('FROM notifications') || sql.includes('FROM integration_alert_queue')) return [];
        throw new Error(`Unexpected ZCQL query in test: ${sql}`);
      },
    }),
    datastore: () => ({
      table: (tableName) => {
        if (tableName === 'leads') {
          return {
            updateRow: async (fields) => {
              if (onLeadsUpdate) await onLeadsUpdate(fields);
              return fields;
            },
          };
        }
        if (tableName === 'lead_integrations') {
          return {
            updateRow: async (fields) => {
              if (onMappingUpdate) await onMappingUpdate(fields);
              return fields;
            },
          };
        }
        return { insertRow: async (f) => f, updateRow: async (f) => f };
      },
    }),
  };
}

test('processResolvedInboundLead: a successful MG write followed by a local bookkeeping failure is NOT reported as "MG CRM could not be updated"', async () => {
  const mapping = buildMapping();
  const existingLeadRow = buildExistingLeadRow();
  let capturedErrorMessage = null;

  const catalystApp = buildFakeCatalystApp({
    mapping,
    existingLeadRow,
    onMappingUpdate: () => {
      // The local lead_integrations bookkeeping write fails — simulating
      // a transient datastore blip AFTER the real MG update already
      // succeeded.
      throw new Error('transient datastore write failure');
    },
  });

  const fakeZohoCrmService = {
    updateOemLead: async () => ({ ok: true }), // MG write succeeds
  };

  await assert.rejects(
    () => processResolvedInboundLead(
      catalystApp,
      buildIntegration(),
      'EXT-1',
      { Enquiry_Model: 'MG5' },
      FIELD_MAPPINGS,
      [],
      'req-1',
      fakeZohoCrmService
    ),
    (err) => {
      capturedErrorMessage = err.message;
      assert.equal(err.writeBackCategory, 'LOCAL_BOOKKEEPING', 'must be classified distinctly from a real MG transport/validation failure');
      return true;
    }
  );

  assert.equal(capturedErrorMessage, 'transient datastore write failure');
});

test('processResolvedInboundLead: a genuine MG write failure is still classified as TRANSPORT (unchanged behavior)', async () => {
  const mapping = buildMapping({ ROWID: 'map-2', zoho_lead_id: 'ZOHO-LEAD-WB-2' });
  const existingLeadRow = buildExistingLeadRow({ ROWID: '9302', crm_record_id: 'ZOHO-LEAD-WB-2' });

  const catalystApp = buildFakeCatalystApp({ mapping, existingLeadRow });

  const fakeZohoCrmService = {
    updateOemLead: async () => {
      throw new Error('MG Zoho API unreachable');
    },
  };

  await assert.rejects(
    () => processResolvedInboundLead(
      catalystApp,
      buildIntegration(),
      'EXT-2',
      { Enquiry_Model: 'MG5' },
      FIELD_MAPPINGS,
      [],
      'req-2',
      fakeZohoCrmService
    ),
    (err) => {
      assert.equal(err.writeBackCategory, 'TRANSPORT');
      return true;
    }
  );
});

test('processResolvedInboundLead: a genuine MG validation failure is still classified as VALIDATION (unchanged behavior)', async () => {
  const mapping = buildMapping({ ROWID: 'map-3', zoho_lead_id: 'ZOHO-LEAD-WB-3' });
  const existingLeadRow = buildExistingLeadRow({ ROWID: '9303', crm_record_id: 'ZOHO-LEAD-WB-3' });

  const catalystApp = buildFakeCatalystApp({ mapping, existingLeadRow });

  const fakeZohoCrmService = {
    updateOemLead: async () => {
      const err = new Error('MG rejected the value');
      err.writeBackCategory = 'VALIDATION';
      throw err;
    },
  };

  await assert.rejects(
    () => processResolvedInboundLead(
      catalystApp,
      buildIntegration(),
      'EXT-3',
      { Enquiry_Model: 'MG5' },
      FIELD_MAPPINGS,
      [],
      'req-3',
      fakeZohoCrmService
    ),
    (err) => {
      assert.equal(err.writeBackCategory, 'VALIDATION');
      return true;
    }
  );
});
