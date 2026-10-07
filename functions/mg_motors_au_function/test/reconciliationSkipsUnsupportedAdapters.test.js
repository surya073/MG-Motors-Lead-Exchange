'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crmAdapterFactory = require('../services/integrations/crmAdapterFactory');
const { runDealerReconciliation } = require('../services/integrations/dealerReconciliationService');
const { _resetForTests: resetSweepGuard } = require('../services/integrations/sweepOverlapGuard');

// Fusion SD has no read-back endpoint (capabilities.getLead === false). The
// reconciliation sweep used to call adapter.getLead for every Fusion lead,
// fail each one with UNSUPPORTED_OPERATION, and log an error per lead per
// sweep. It must skip them cleanly — and rotate them, so skipped rows do not
// sit at the head of the oldest-first window and starve other dealers.

function buildFakeCatalystApp({ mappings, integration, touched }) {
  return {
    zcql: () => ({
      executeZCQLQuery: async (query) => {
        if (/FROM lead_integrations/.test(query) && /ORDER BY last_attempted_at/.test(query)) {
          return mappings.map((m) => ({ lead_integrations: m }));
        }
        if (/FROM dealer_integrations/.test(query)) {
          return [{ dealer_integrations: integration }];
        }
        return [];
      },
    }),
    datastore: () => ({
      table: (name) => ({
        updateRow: async (fields) => {
          if (name === 'lead_integrations') touched.push(fields);
          return fields;
        },
        insertRow: async (fields) => fields,
      }),
    }),
  };
}

test('reconciliation skips and rotates Fusion SD mappings instead of failing getLead for each', async (t) => {
  resetSweepGuard();
  const touched = [];
  const integration = {
    ROWID: '77',
    dealer_code: 'AU077',
    crm_type: 'FUSION_SD',
    integration_type: 'EXTERNAL_CRM',
    inbound_enabled: true, // even with the flag on, the adapter cannot read back
  };
  const mappings = [
    { ROWID: 'm1', integration_id: '77', external_crm_lead_id: 'lead_A', zoho_lead_id: 'Z1', sync_status: 'SYNCED' },
    { ROWID: 'm2', integration_id: '77', external_crm_lead_id: 'lead_B', zoho_lead_id: 'Z2', sync_status: 'SYNCED' },
  ];

  const realGetAdapter = crmAdapterFactory.getAdapter;
  let getLeadCalls = 0;
  t.mock.method(crmAdapterFactory, 'getAdapter', (crmType) => {
    const adapter = realGetAdapter(crmType);
    return { ...adapter, getLead: async () => { getLeadCalls += 1; throw new Error('must not be called'); } };
  });

  const results = await runDealerReconciliation(buildFakeCatalystApp({ mappings, integration, touched }));

  assert.equal(getLeadCalls, 0, 'no dealer round trip for an adapter that cannot read a lead back');
  assert.equal(results.failed, 0, 'skipping is not a failure');
  assert.equal(results.skipped, 2);
  assert.deepEqual(touched.map((u) => u.ROWID).sort(), ['m1', 'm2'], 'each skipped mapping is rotated');
  assert.ok(touched.every((u) => u.last_attempted_at), 'rotation stamps last_attempted_at');
});
