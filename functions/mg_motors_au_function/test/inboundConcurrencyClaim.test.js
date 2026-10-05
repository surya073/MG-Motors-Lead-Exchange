'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const oemCrmService = require('../services/zohoCrmService');

const { processResolvedInboundLead } = crmIntegrationService._test;

// Covers the fix closing the inbound webhook concurrency gap found during
// the 200+ dealer audit: processResolvedInboundLead now wraps its whole
// write section in the SAME outboundSyncClaimService claim
// (syncLeadToExternalCrm already uses), keyed identically
// (`${integration.ROWID}:${zoho_lead_id}`), so inbound-vs-inbound AND
// inbound-vs-outbound updates for the same lead genuinely coordinate on
// one lock — never two separate locks that could still race each other.

const OUTBOUND_REQUIRED_FIELDS = [
  'enquiry_id', 'customer_name', 'mobile_number', 'email_address', 'postcode',
  'vehicle_model', 'nature_of_enquiry', 'lead_source', 'dealer_code',
  'accept_privacy_policy', 'lead_status',
];

function buildOutboundFieldMappings() {
  return OUTBOUND_REQUIRED_FIELDS.map((field) => ({ source_field: field, target_field: `ext_${field}` }));
}

const INBOUND_FIELD_MAPPINGS = [{ source_field: 'vehicle_model', target_field: 'Enquiry_Model' }];

function buildIntegration(overrides = {}) {
  return {
    ROWID: '801',
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

function buildOutboundLeadRow(overrides = {}) {
  return {
    ROWID: '9401',
    crm_record_id: 'ZOHO-LEAD-CC-1',
    customer_name: 'Jane Smith',
    mobile_number: '0412345678',
    email_address: 'jane.smith@example.com',
    postcode: '3000',
    vehicle_model: 'MG3',
    nature_of_enquiry: 'Test Drive',
    lead_source: 'Website',
    dealer_code: 'AU777',
    lead_status: 'Update Pending',
    accept_privacy_policy: true,
    ...overrides,
  };
}

/**
 * One shared, stateful fake catalystApp supporting BOTH the outbound
 * (syncLeadToExternalCrm) and inbound (processResolvedInboundLead) flows,
 * plus a faithful unique-constraint simulation for outbound_sync_claims
 * (see outboundSyncClaimService.test.js for why this fake is trustworthy
 * for that specific behavior — Node's single-threaded execution means its
 * synchronous check-and-set body cannot actually interleave mid-call).
 */
function buildSharedFakeCatalystApp({ outboundFieldMappings, dealerRow, leadIntegrationSeed = [] } = {}) {
  const claimRowsById = new Map();
  const claimRowIdByKey = new Map();
  let nextClaimId = 1;

  const leadIntegrationsById = new Map();
  let nextMappingId = 1000;
  leadIntegrationSeed.forEach((row) => {
    const ROWID = String(nextMappingId++);
    leadIntegrationsById.set(ROWID, { ROWID, ...row });
  });

  const leadsByRecordId = new Map(); // crm_record_id -> leads row
  const integrationLogs = [];

  function findMappingByIntegrationAndZohoLead(integrationId, zohoLeadId) {
    for (const row of leadIntegrationsById.values()) {
      if (String(row.integration_id) === String(integrationId) && row.zoho_lead_id === zohoLeadId) return row;
    }
    return null;
  }
  function findMappingByIntegrationAndExternalId(integrationId, externalCrmLeadId) {
    for (const row of leadIntegrationsById.values()) {
      if (String(row.integration_id) === String(integrationId) && row.external_crm_lead_id === externalCrmLeadId) return row;
    }
    return null;
  }

  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('FROM dealers')) return dealerRow ? [{ dealers: dealerRow }] : [];
        if (sql.includes('FROM integration_field_mappings')) {
          return (outboundFieldMappings || []).map((row) => ({ integration_field_mappings: row }));
        }
        if (sql.includes('FROM integration_status_mappings')) return [];
        if (sql.includes('FROM notifications') || sql.includes('FROM integration_alert_queue')) return [];
        if (sql.includes('FROM lead_integrations')) {
          const extMatch = /integration_id = (\d+) AND dealer_code = '[^']*' AND external_crm_lead_id = '([^']*)'/.exec(sql);
          if (extMatch) {
            const row = findMappingByIntegrationAndExternalId(extMatch[1], extMatch[2]);
            return row ? [{ lead_integrations: row }] : [];
          }
          const zohoMatch = /zoho_lead_id = '([^']*)' AND integration_id = (\d+)/.exec(sql);
          if (zohoMatch) {
            const row = findMappingByIntegrationAndZohoLead(zohoMatch[2], zohoMatch[1]);
            return row ? [{ lead_integrations: row }] : [];
          }
          return [];
        }
        if (sql.includes('FROM leads')) {
          const match = /crm_record_id = '([^']*)'/.exec(sql);
          if (!match) return [];
          const row = leadsByRecordId.get(match[1]);
          return row ? [{ leads: row }] : [];
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
        if (tableName === 'lead_integrations') {
          return {
            insertRow: async (fields) => {
              const ROWID = String(nextMappingId++);
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
        if (tableName === 'leads') {
          return {
            updateRow: async (fields) => {
              // Leads are looked up by crm_record_id, but updateRow only
              // carries ROWID — find by ROWID across the seeded map.
              for (const [key, row] of leadsByRecordId.entries()) {
                if (String(row.ROWID) === String(fields.ROWID)) {
                  const merged = { ...row, ...fields };
                  leadsByRecordId.set(key, merged);
                  return merged;
                }
              }
              return fields;
            },
          };
        }
        if (tableName === 'integration_logs') {
          return {
            insertRow: async (fields) => {
              integrationLogs.push(fields);
              return { ROWID: `log-${integrationLogs.length}`, ...fields };
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
    _leadsByRecordId: leadsByRecordId,
    _integrationLogs: integrationLogs,
    _seedLead: (row) => leadsByRecordId.set(row.crm_record_id, row),
  };
}

function buildInboundArgs({ integration, mapping, leadRow, externalRecord, requestReference = 'req-inbound', replay = false }) {
  return [
    integration,
    mapping.external_crm_lead_id,
    externalRecord,
    INBOUND_FIELD_MAPPINGS,
    [],
    requestReference,
    { updateOemLead: async () => ({ ok: true }) },
    null,
    { replay },
  ];
}

test('inbound + inbound: two simultaneous webhook updates for the SAME lead — only one applies, the other is held for retry', async (t) => {
  const integration = buildIntegration();
  const leadRow = buildOutboundLeadRow({ vehicle_model: 'MG3' });
  const mapping = { integration_id: integration.ROWID, zoho_lead_id: leadRow.crm_record_id, external_crm_lead_id: 'EXT-INBOUND-1', sync_status: 'SYNCED', dealer_code: integration.dealer_code };

  const catalystApp = buildSharedFakeCatalystApp({ leadIntegrationSeed: [mapping] });
  catalystApp._seedLead(leadRow);

  let updateCount = 0;
  const slowZohoCrmService = {
    updateOemLead: async () => {
      updateCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    },
  };

  const callOnce = () => processResolvedInboundLead(
    catalystApp, integration, mapping.external_crm_lead_id, { Enquiry_Model: 'MG5' },
    INBOUND_FIELD_MAPPINGS, [], 'req-a', slowZohoCrmService, null, { replay: false }
  );

  const [first, second] = await Promise.all([callOnce(), callOnce()]);
  const outcomes = [first, second];

  assert.equal(updateCount, 1, 'the MG CRM must be written exactly once for two simultaneous deliveries of the same lead');
  const applied = outcomes.filter((o) => o.ok);
  const held = outcomes.filter((o) => o.held);
  assert.equal(applied.length, 1);
  assert.equal(held.length, 1);
  assert.equal(held[0].reason, 'CONCURRENT_SYNC_IN_PROGRESS');

  // The losing delivery must be durably queued for retry, not dropped.
  // NOTE: the mapping row's sync_status is NOT asserted here — the winner's
  // own success write can legitimately land after the loser's HELD mark and
  // overwrite it back to SYNCED (a timing detail, not a correctness issue):
  // the actual retry-discovery mechanism (inboundReplayScheduler.js) scans
  // integration_logs for a FAILED row, not lead_integrations.sync_status,
  // so the lost delivery is still durably queued for replay regardless of
  // which write landed last on the mapping row itself.
  assert.ok(
    catalystApp._integrationLogs.some((l) => l.error_message === 'CONCURRENT_UPDATE_IN_PROGRESS'),
    'a FAILED log row must exist so inboundReplayScheduler.js can find and retry this update'
  );
});

test('inbound + outbound: a webhook update and an outbound sync for the SAME lead never run concurrently', async (t) => {
  const integration = buildIntegration({ ROWID: '802' });
  const leadRow = buildOutboundLeadRow({ crm_record_id: 'ZOHO-LEAD-CC-2', ROWID: '9402', vehicle_model: 'MG3' });
  const mapping = { integration_id: integration.ROWID, zoho_lead_id: leadRow.crm_record_id, external_crm_lead_id: undefined, sync_status: 'FAILED', dealer_code: integration.dealer_code };

  const catalystApp = buildSharedFakeCatalystApp({
    outboundFieldMappings: buildOutboundFieldMappings(),
    dealerRow: { dealer_code: 'AU777', sync_status: 'Active' },
  });
  catalystApp._seedLead(leadRow);

  let outboundRan = false;
  let inboundRan = false;
  const fakeAdapter = {
    createLead: async () => {
      outboundRan = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { externalLeadId: 'EXT-FROM-OUTBOUND', httpStatus: 201 };
    },
    updateLead: async () => { throw new Error('not expected'); },
  };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => fakeAdapter);
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({}));

  // Inbound needs its OWN lead_integrations row (keyed by external_crm_lead_id)
  // distinct from the outbound path's own lookup (keyed by zoho_lead_id) —
  // both resolve to the SAME claim key (`${integrationId}:${zohoLeadId}`),
  // which is exactly the point under test.
  const inboundMapping = { integration_id: integration.ROWID, zoho_lead_id: leadRow.crm_record_id, external_crm_lead_id: 'EXT-ALREADY-KNOWN', sync_status: 'SYNCED', dealer_code: integration.dealer_code };
  const seededId = '5001';
  catalystApp._leadIntegrationsById.set(seededId, { ROWID: seededId, ...inboundMapping });

  const slowZohoCrmService = {
    updateOemLead: async () => {
      inboundRan = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    },
  };

  const [outboundResult, inboundResult] = await Promise.all([
    crmIntegrationService.syncLeadToExternalCrm(catalystApp, integration, leadRow),
    processResolvedInboundLead(
      catalystApp, integration, inboundMapping.external_crm_lead_id, { Enquiry_Model: 'MG5' },
      INBOUND_FIELD_MAPPINGS, [], 'req-inbound', slowZohoCrmService, null, { replay: false }
    ),
  ]);

  const results = [outboundResult, inboundResult];
  const succeeded = results.filter((r) => r.ok);
  const skippedOrHeld = results.filter((r) => r.skipped || r.held);

  assert.equal(succeeded.length, 1, 'exactly one of the two concurrent operations for this lead must succeed');
  assert.equal(skippedOrHeld.length, 1, 'the other must be skipped/held, never silently dropped');
  // Only ONE of the two underlying calls should ever have actually run,
  // proving they genuinely shared one lock rather than two independent ones.
  assert.equal([outboundRan, inboundRan].filter(Boolean).length, 1);
});

test('different leads for the same dealer process independently and concurrently', async (t) => {
  const integration = buildIntegration({ ROWID: '803' });
  const leadA = buildOutboundLeadRow({ crm_record_id: 'ZOHO-LEAD-A', ROWID: '9501' });
  const leadB = buildOutboundLeadRow({ crm_record_id: 'ZOHO-LEAD-B', ROWID: '9502' });
  const mappingA = { integration_id: integration.ROWID, zoho_lead_id: leadA.crm_record_id, external_crm_lead_id: 'EXT-A', sync_status: 'SYNCED', dealer_code: integration.dealer_code };
  const mappingB = { integration_id: integration.ROWID, zoho_lead_id: leadB.crm_record_id, external_crm_lead_id: 'EXT-B', sync_status: 'SYNCED', dealer_code: integration.dealer_code };

  const catalystApp = buildSharedFakeCatalystApp({ leadIntegrationSeed: [mappingA, mappingB] });
  catalystApp._seedLead(leadA);
  catalystApp._seedLead(leadB);

  let runCount = 0;
  const slowZohoCrmService = {
    updateOemLead: async () => {
      runCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    },
  };

  const [resultA, resultB] = await Promise.all([
    processResolvedInboundLead(catalystApp, integration, 'EXT-A', { Enquiry_Model: 'MG5' }, INBOUND_FIELD_MAPPINGS, [], 'req-a', slowZohoCrmService, null, { replay: false }),
    processResolvedInboundLead(catalystApp, integration, 'EXT-B', { Enquiry_Model: 'MG5' }, INBOUND_FIELD_MAPPINGS, [], 'req-b', slowZohoCrmService, null, { replay: false }),
  ]);

  assert.equal(runCount, 2, 'two different leads must both be processed, never blocked by each other');
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
});

test('different dealers process independently and concurrently, even for the same external lead id', async (t) => {
  const integrationA = buildIntegration({ ROWID: '901', dealer_code: 'AU901' });
  const integrationB = buildIntegration({ ROWID: '902', dealer_code: 'AU902' });
  const leadA = buildOutboundLeadRow({ crm_record_id: 'ZOHO-LEAD-DEALER-A', ROWID: '9601', dealer_code: 'AU901' });
  const leadB = buildOutboundLeadRow({ crm_record_id: 'ZOHO-LEAD-DEALER-B', ROWID: '9602', dealer_code: 'AU902' });
  // Deliberately the SAME external_crm_lead_id across two different
  // dealers/integrations — must not collide, since the claim key includes
  // integration_id, not just the external id.
  const mappingA = { integration_id: integrationA.ROWID, zoho_lead_id: leadA.crm_record_id, external_crm_lead_id: 'EXT-SHARED', sync_status: 'SYNCED', dealer_code: 'AU901' };
  const mappingB = { integration_id: integrationB.ROWID, zoho_lead_id: leadB.crm_record_id, external_crm_lead_id: 'EXT-SHARED', sync_status: 'SYNCED', dealer_code: 'AU902' };

  const catalystApp = buildSharedFakeCatalystApp({ leadIntegrationSeed: [mappingA, mappingB] });
  catalystApp._seedLead(leadA);
  catalystApp._seedLead(leadB);

  let runCount = 0;
  const slowZohoCrmService = {
    updateOemLead: async () => {
      runCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    },
  };

  const [resultA, resultB] = await Promise.all([
    processResolvedInboundLead(catalystApp, integrationA, 'EXT-SHARED', { Enquiry_Model: 'MG5' }, INBOUND_FIELD_MAPPINGS, [], 'req-a', slowZohoCrmService, null, { replay: false }),
    processResolvedInboundLead(catalystApp, integrationB, 'EXT-SHARED', { Enquiry_Model: 'MG5' }, INBOUND_FIELD_MAPPINGS, [], 'req-b', slowZohoCrmService, null, { replay: false }),
  ]);

  assert.equal(runCount, 2, 'different dealers sharing the same external lead id string must never block each other');
  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
});

test('claim rejection on a REPLAY attempt is reported via held:true without writing a second log entry', async (t) => {
  const integration = buildIntegration({ ROWID: '804' });
  const leadRow = buildOutboundLeadRow({ crm_record_id: 'ZOHO-LEAD-CC-REPLAY', ROWID: '9403' });
  const mapping = { integration_id: integration.ROWID, zoho_lead_id: leadRow.crm_record_id, external_crm_lead_id: 'EXT-REPLAY', sync_status: 'FAILED', last_error: 'MG_WRITE_BACK_FAILED:TRANSPORT', dealer_code: integration.dealer_code };

  const catalystApp = buildSharedFakeCatalystApp({ leadIntegrationSeed: [mapping] });
  catalystApp._seedLead(leadRow);

  // Pre-occupy the claim to simulate a concurrent holder.
  const outboundSyncClaimService = require('../services/integrations/outboundSyncClaimService');
  const { toCatalystDateTime } = require('../utils/dateFormat');
  const claimKey = outboundSyncClaimService._test.buildClaimKey(integration.ROWID, leadRow.crm_record_id);
  await catalystApp.datastore().table('outbound_sync_claims').insertRow({
    claim_key: claimKey,
    claimed_at: toCatalystDateTime(),
    request_reference: 'someone-else',
  });

  const result = await processResolvedInboundLead(
    catalystApp, integration, 'EXT-REPLAY', { Enquiry_Model: 'MG5' },
    INBOUND_FIELD_MAPPINGS, [], 'req-replay', { updateOemLead: async () => ({ ok: true }) }, null, { replay: true }
  );

  assert.deepEqual(result, { skipped: true, reason: 'CONCURRENT_SYNC_IN_PROGRESS', held: true });
  assert.equal(catalystApp._integrationLogs.length, 0, 'a replay attempt must not write a second log entry on top of the one already open from the prior failure');
});

test('an exception inside the claimed inbound operation propagates, and the claim is still released', async (t) => {
  const integration = buildIntegration({ ROWID: '805' });
  const leadRow = buildOutboundLeadRow({ crm_record_id: 'ZOHO-LEAD-CC-THROW', ROWID: '9404', vehicle_model: 'MG3' });
  const mapping = { integration_id: integration.ROWID, zoho_lead_id: leadRow.crm_record_id, external_crm_lead_id: 'EXT-THROW', sync_status: 'SYNCED', dealer_code: integration.dealer_code };

  const catalystApp = buildSharedFakeCatalystApp({ leadIntegrationSeed: [mapping] });
  catalystApp._seedLead(leadRow);

  const throwingZohoCrmService = {
    updateOemLead: async () => {
      throw new Error('MG Zoho API unreachable');
    },
  };

  await assert.rejects(
    () => processResolvedInboundLead(
      catalystApp, integration, 'EXT-THROW', { Enquiry_Model: 'MG5' },
      INBOUND_FIELD_MAPPINGS, [], 'req-throw', throwingZohoCrmService, null, { replay: false }
    ),
    (err) => {
      assert.equal(err.writeBackCategory, 'TRANSPORT');
      return true;
    }
  );

  // Claim release through finally: a SECOND attempt right after must not
  // be blocked by a claim the failed first attempt should have released.
  let secondRan = false;
  const recoveringZohoCrmService = {
    updateOemLead: async () => {
      secondRan = true;
      return { ok: true };
    },
  };
  const secondResult = await processResolvedInboundLead(
    catalystApp, integration, 'EXT-THROW', { Enquiry_Model: 'MG5' },
    INBOUND_FIELD_MAPPINGS, [], 'req-throw-2', recoveringZohoCrmService, null, { replay: false }
  );

  assert.equal(secondRan, true, 'the claim must be released even when the MG API call throws, so a later attempt is not blocked forever');
  assert.equal(secondResult.ok, true);
});
