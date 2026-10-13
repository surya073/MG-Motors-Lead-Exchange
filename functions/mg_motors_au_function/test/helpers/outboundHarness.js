'use strict';

const { createInMemoryZcql } = require('./inMemoryZcql');
const fixtures = require('./fusionFixtures');
const crmAdapterFactory = require('../../services/integrations/crmAdapterFactory');
const integrationAlertService = require('../../services/integrations/integrationAlertService');
const oemCrmService = require('../../services/zohoCrmService');

/**
 * Drives crmIntegrationService.syncLeadToExternalCrm end to end in tests,
 * with an in-memory datastore and a fake adapter. The data is one Fusion SD
 * dealer (AU999, integration ROWID 1000) and one lead (ZL1) that, unless a
 * test says otherwise, already has a SYNCED mapping to the dealer's lead id.
 * Pass `mapping: null` for a lead that has never been delivered.
 */

const FIELD_MAPPINGS = Object.entries({
  enquiry_id: 'refID',
  customer_name: 'contact.firstName',
  mobile_number: 'contact.phone',
  email_address: 'contact.email',
  postcode: 'contact.areaCode',
  vehicle_model: 'requirement.model',
  nature_of_enquiry: 'enquiryType',
  lead_source: 'leadSource',
  dealer_code: 'campaign',
  accept_privacy_policy: 'privacy',
  lead_status: 'enquiryStatus',
}).map(([source_field, target_field]) => ({ source_field, target_field, data_type: 'string', required: true }));

// Not Contacted <-> Open both ways. Fusion "Won" is accepted as MG "Contacted",
// but MG "Contacted" is never sent out: an inbound-only row (preset of aa0045f).
const STATUS_MAPPINGS = [
  { source_status: 'Not Contacted', target_status: 'Open', direction: 'ZOHO_TO_EXTERNAL' },
  { source_status: 'Open', target_status: 'Not Contacted', direction: 'EXTERNAL_TO_ZOHO' },
  { source_status: 'Won', target_status: 'Contacted', direction: 'EXTERNAL_TO_ZOHO' },
];

const LEAD = {
  crm_record_id: 'ZL1', enquiry_id: 'ENQ-1', customer_name: 'Jane Citizen', mobile_number: '0412345678',
  email_address: 'jane@example.com', postcode: '3000', vehicle_model: 'MG ZS', nature_of_enquiry: 'Test Drive',
  lead_source: 'Website', dealer_code: 'AU999', accept_privacy_policy: true, lead_status: 'Not Contacted',
};

function setupOutbound(t, { integration = {}, mapping = {}, lead = {} } = {}) {
  const db = createInMemoryZcql({
    dealers: [{ dealer_code: 'AU999', dealer_name: 'Fusion Dealer' }],
    dealer_integrations: [{
      ROWID: '1000', dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: 'FUSION_SD',
      status: 'ACTIVE', outbound_enabled: true, base_url: 'https://8.8.8.8/api/leadapi', create_lead_endpoint: '/v1/leads',
      ...integration,
    }],
    integration_field_mappings: FIELD_MAPPINGS.map((row) => ({ integration_id: '1000', ...row })),
    integration_status_mappings: STATUS_MAPPINGS.map((row) => ({ integration_id: '1000', ...row })),
    lead_integrations: mapping === null ? [] : [{
      integration_id: '1000', zoho_lead_id: 'ZL1', dealer_code: 'AU999',
      external_crm_lead_id: fixtures.FUSION_TEST_LEAD_ID, sync_status: 'SYNCED', ...mapping,
    }],
    leads: [{ ...LEAD, sync_status: 'SYNCED', ...lead }],
    integration_logs: [],
    outbound_sync_claims: [],
  });
  const alerts = t.mock.method(integrationAlertService, 'notifyScenario', async () => ({ sent: false }));
  // OEM (MG Zoho) write-backs, e.g. the acknowledgement or "Dealer Unavailable".
  const oemWrites = [];
  t.mock.method(oemCrmService, 'updateOemLead', async (zohoLeadId, fields) => {
    oemWrites.push({ zohoLeadId, fields });
    return { status: 'success' };
  });
  return {
    db,
    alerts,
    oemWrites,
    integration: { ...db.tables.dealer_integrations[0] },
    leadRow: () => ({ ROWID: '1000', ...db.tables.leads[0] }),
    logs: () => db.tables.integration_logs,
  };
}

// An adapter whose createLead / updateLead answer with the given functions;
// a call to one that was not given fails the test. Records every payload.
function fakeAdapter(t, { createLead, updateLead } = {}) {
  const calls = { create: [], update: [] };
  t.mock.method(crmAdapterFactory, 'getAdapter', () => ({
    createLead: async (_app, _integration, payload, options) => {
      calls.create.push(payload);
      if (!createLead) throw new Error('createLead is not expected in this test');
      return createLead(payload, options);
    },
    updateLead: async (_app, _integration, externalLeadId, payload) => {
      calls.update.push(payload);
      if (!updateLead) throw new Error('updateLead is not expected in this test');
      return updateLead(externalLeadId, payload);
    },
  }));
  return calls;
}

// Sets environment variables for one test and restores them afterwards;
// `undefined` unsets a variable.
function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const apply = (values) => Object.entries(values).forEach(([name, value]) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  });
  apply(vars);
  t.after(() => apply(before));
}

module.exports = { FIELD_MAPPINGS, STATUS_MAPPINGS, LEAD, setupOutbound, fakeAdapter, withEnv };
