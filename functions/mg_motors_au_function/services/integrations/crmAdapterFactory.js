'use strict';

const genericRestAdapter = require('./adapters/genericRestAdapter');

/**
 * crmAdapterFactory.js
 * -----------------------------------------------------------------------
 * Resolves crm_type -> adapter module. Every adapter implements:
 *   createLead(catalystApp, integration, payload)
 *   updateLead(catalystApp, integration, externalLeadId, payload)
 *   getLead(catalystApp, integration, externalLeadId)
 *   testConnection(catalystApp, integration)
 *
 * V1 supports GENERIC_REST only. Adding Salesforce/HubSpot later means
 * adding a new file under ./adapters and one line here — no changes to
 * crmIntegrationService.
 */

const ADAPTERS = {
  GENERIC_REST: genericRestAdapter,
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