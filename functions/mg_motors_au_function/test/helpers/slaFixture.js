'use strict';

const { createInMemoryZcql } = require('./inMemoryZcql');

// Complete dealer / assignment fixtures for the SLA's authoritative eligibility
// checks. Individual tests can override either table to model removal or drift.
function createSlaFixture(tables, options) {
  const integrations = tables.dealer_integrations || [];
  const mappings = tables.lead_integrations || [];
  return createInMemoryZcql({
    ...tables,
    dealers: tables.dealers || [...new Set(integrations.map((row) => row.dealer_code).filter(Boolean))]
      .map((dealer_code) => ({ dealer_code, sync_status: 'Synced' })),
    leads: (tables.leads || []).map((lead) => ({
      accept_privacy_policy: true,
      dealer_code: mappings.find((row) => row.zoho_lead_id === lead.crm_record_id)?.dealer_code,
      ...lead,
    })),
  }, options);
}

module.exports = { createSlaFixture };
