'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

// Acceptance for Batch 4: a Fusion dealer (Buckby MG, 725001, and every other
// Fusion dealer) re-saved with the new "Load Fusion default map" presets keeps
// every outbound happy path working: Happy 1 (create), Happy 5 (update) and
// Happy 4 (recovery), with the payload Fusion displays.

// Stored form of the field preset (DealerCRMConfig.jsx FUSION_DEFAULT_FIELD_MAPPINGS).
const FIELD_PRESET = [
  ['enquiry_id', 'refID', 'string', true],
  ['first_name', 'contact.firstName', 'string', false],
  ['last_name', 'contact.lastName', 'string', false],
  ['mobile_number', 'contact.phone', 'string', true],
  ['email_address', 'contact.email', 'string', true],
  ['postcode', 'contact.areaCode', 'string', true],
  ['vehicle_model', 'requirement.model', 'string', true],
  ['enquiry_channel', 'enquiryType', 'string', true],
  ['lead_origin', 'origin', 'string', true],
  ['nature_of_enquiry', 'leadSource', 'string', true],
  ['accept_privacy_policy', 'privacy', 'boolean', true],
  ['lead_status', 'enquiryStatus', 'string', true],
  ['receive_marketing_updates', 'contact.marketingOptinEmail', 'boolean', false],
  ['dealer_rejected_reason', 'lostReason', 'string', false],
].map(([source_field, target_field, data_type, required]) => ({ integration_id: '1000', source_field, target_field, data_type, required }));

// Stored form of the D1 status preset (two-way rows write both directions,
// outbound-only rows the MG -> Fusion row, inbound-only the Fusion -> MG row).
const OPEN = ['Not Contacted', 'Follow-up 1', 'Follow-up 2', 'Attempted to Contact', 'Contacted', 'Contact in Future', 'Pre-Qualified'];
const PROSPECT_LOST = ['Not Qualified', 'Dropped', 'Lost', 'Junk Lead', 'Lost Lead'];
const STATUS_PRESET = [
  ...OPEN.map((mg) => ({ source_status: mg, target_status: 'Open', direction: 'ZOHO_TO_EXTERNAL' })),
  ...PROSPECT_LOST.map((mg) => ({ source_status: mg, target_status: 'Prospect Lost', direction: 'ZOHO_TO_EXTERNAL' })),
  { source_status: 'Open', target_status: 'Not Contacted', direction: 'EXTERNAL_TO_ZOHO' },
  { source_status: 'Prospect Lost', target_status: 'Not Qualified', direction: 'EXTERNAL_TO_ZOHO' },
  { source_status: 'Lost', target_status: 'Lost', direction: 'EXTERNAL_TO_ZOHO' },
].map((row) => ({ integration_id: '1000', ...row }));

const BUCKBY_LEAD = {
  lead_source: 'OEM AU Website', nature_of_enquiry: 'Test Drive', postcode: '7250',
  receive_marketing_updates: true, dealer_rejected_reason: '',
};

function withPresets(t, options) {
  const harness = setupOutbound(t, { ...options, lead: { ...BUCKBY_LEAD, ...options.lead } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  return harness;
}

const created = async () => ({ externalLeadId: fixtures.FUSION_TEST_LEAD_ID, httpStatus: 201, raw: {} });
const updated = async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });

test('Happy 1: a new lead is created with every field on Fusion\'s lists and no MG-only status', async (t) => {
  const harness = withPresets(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, { createLead: created });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.equal(result.ok, true);
  assert.deepEqual(calls.create[0], {
    refID: 'ENQ-1',
    'contact.firstName': 'Jane Citizen',
    'contact.phone': '0412345678',
    'contact.email': 'jane@example.com',
    'contact.areaCode': '7250',
    'requirement.model': 'MG ZS',
    enquiryType: 'Internet',
    origin: 'Manufacturer Lead',
    leadSource: 'Test Drive',
    privacy: true,
    'contact.marketingOptinEmail': true,
  });
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'SYNCED');
  assert.ok(harness.logs().some((log) => log.happy_unhappy_path_name === 'Happy 1'));
});

test('Happy 5: a Contacted lead goes out as Open, never as Won or Lost', async (t) => {
  const harness = withPresets(t, { lead: { lead_status: 'Contacted' } });
  const calls = fakeAdapter(t, { updateLead: updated });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.equal(result.ok, true);
  assert.equal(calls.update[0].enquiryStatus, 'Open');
  assert.ok(!('lostReason' in calls.update[0]));
  assert.ok(harness.logs().some((log) => log.happy_unhappy_path_name === 'Happy 5'));
});

test('Happy 5: every MG status a dealer can hold is delivered, none is held for a missing mapping', async (t) => {
  for (const mgStatus of [...OPEN, ...PROSPECT_LOST]) {
    const harness = withPresets(t, { lead: { lead_status: mgStatus } });
    const calls = fakeAdapter(t, { updateLead: updated });
    const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
    assert.equal(result.ok, true, mgStatus);
    assert.equal(calls.update[0].enquiryStatus, OPEN.includes(mgStatus) ? 'Open' : 'Prospect Lost', mgStatus);
  }
});

test('Happy 5: a lost lead goes out as Prospect Lost with its reason', async (t) => {
  const harness = withPresets(t, { lead: { lead_status: 'Lost', dealer_rejected_reason: 'Bought Another Brand' } });
  const calls = fakeAdapter(t, { updateLead: updated });

  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.equal(calls.update[0].enquiryStatus, 'Prospect Lost');
  assert.equal(calls.update[0].lostReason, 'Bought Another Brand');
});

test('Happy 4: a lead whose delivery failed recovers with the new presets', async (t) => {
  const harness = withPresets(t, {
    mapping: { sync_status: 'FAILED', retry_count: '1', failure_streak_started_at: '2026-10-13 09:00:00', last_error: 'EXTERNAL_CRM_ERROR' },
    lead: { lead_status: 'Not Contacted', sync_status: 'DELIVERY_FAILED' },
  });
  fakeAdapter(t, { updateLead: updated });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.equal(result.scenarioCode, 'Happy 4');
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'SYNCED');
});
