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

module.exports = { getAdapter };