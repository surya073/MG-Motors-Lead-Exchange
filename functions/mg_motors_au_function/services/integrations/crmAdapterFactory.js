'use strict';

const genericRestAdapter = require('./adapters/genericRestAdapter');
const fusionSdAdapter = require('./adapters/fusionSdAdapter');

/**
 * crmAdapterFactory.js
 * -----------------------------------------------------------------------
 * Resolves crm_type -> adapter module. Every adapter implements:
 *   createLead(catalystApp, integration, payload)
 *   updateLead(catalystApp, integration, externalLeadId, payload)
 *   getLead(catalystApp, integration, externalLeadId)
 *   testConnection(catalystApp, integration)
 *
 * Adding a new CRM means adding a new file under ./adapters and one line
 * here — no changes to crmIntegrationService, leadSyncService, the retry
 * scheduler, or reconciliation, since they only ever go through
 * getAdapter(). FUSION_SD (added for the Fusion SD integration) is the
 * first adapter after the original GENERIC_REST/ZOHO_CRM pair, confirming
 * that pattern actually holds.
 */

const ADAPTERS = {
  GENERIC_REST: genericRestAdapter,
  ZOHO_CRM: genericRestAdapter,
  FUSION_SD: fusionSdAdapter,
};

function getAdapter(crmType) {
  const adapter = ADAPTERS[crmType];
  if (!adapter) {
    const err = new Error(`Unsupported CRM type: ${crmType}`);
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }
  return adapter;
}

/**
 * Whether an adapter can do something, read from its optional static
 * `capabilities` map. Adapters that don't declare one (generic REST / Zoho)
 * are treated as capable of everything, so only an explicit `false` — as
 * Fusion SD declares for getLead — opts a CRM type out. Lets sweeps skip
 * work an adapter would only reject with UNSUPPORTED_OPERATION.
 */
function supports(crmType, capability) {
  const adapter = ADAPTERS[crmType];
  if (!adapter) return false;
  return adapter.capabilities?.[capability] !== false;
}

module.exports = { getAdapter, supports };