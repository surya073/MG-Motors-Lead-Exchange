'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 10 (FUSION_REMEDIATION_PLAN.md): Fusion's PATCH is a merge-patch and
// Fusion asks for "only the fields that changed". With
// FUSION_CHANGES_ONLY_PATCH on, an update sends only what differs from the
// payload last sent; a field MG emptied is left alone at Fusion (Q32); with
// nothing new and the lead in sync, no request is made. Without a snapshot
// the full lead is sent, as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

const updated = async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });

function setup(t, { flag = 'true', lead = {} } = {}) {
  withEnv(t, { FUSION_CHANGES_ONLY_PATCH: flag, INTEGRATION_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64') });
  const harness = setupOutbound(t, { lead });
  const calls = fakeAdapter(t, { updateLead: updated });
  const sync = async (changes = {}) => {
    Object.assign(harness.db.tables.leads[0], changes);
    return crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  };
  return { harness, calls, sync };
}

test('without a snapshot the full lead is sent (and becomes the snapshot)', async (t) => {
  const { calls, sync } = setup(t);
  await sync();
  assert.equal(calls.update[0]['contact.email'], 'jane@example.com');
  assert.equal(calls.update[0].enquiryStatus, 'Open');
});

test('then only the changed field is sent; the status is not re-sent over the dealer\'s', async (t) => {
  const { calls, sync } = setup(t);
  await sync();
  await sync({ postcode: '7000' });
  assert.deepEqual(calls.update[1], { 'contact.areaCode': '7000' });
});

test('a changed MG status is sent like any other changed field', async (t) => {
  const { harness, calls, sync } = setup(t);
  harness.db.tables.integration_status_mappings.push({
    integration_id: '1000', source_status: 'Not Qualified', target_status: 'Prospect Lost', direction: 'ZOHO_TO_EXTERNAL',
  });
  await sync();
  await sync({ lead_status: 'Not Qualified' });
  assert.deepEqual(calls.update[1], { enquiryStatus: 'Prospect Lost' });
});

test('Q32: a field emptied in MG is left alone at Fusion, never sent as empty or null', async (t) => {
  const { calls, sync } = setup(t);
  await sync();
  await sync({ vehicle_model: '', postcode: '7000' });
  assert.deepEqual(calls.update[1], { 'contact.areaCode': '7000' });
});

test('nothing new and the lead in sync: no request at all', async (t) => {
  const { harness, calls, sync } = setup(t);
  await sync();
  harness.db.tables.lead_integrations[0].last_sync_direction = 'ZOHO_TO_EXTERNAL_CRM';
  const result = await sync({ customer_message: 'not a mapped field' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'NO_CHANGES_TO_SEND');
  assert.equal(calls.update.length, 1);
});

test('a lead waiting for a retry is sent in full, so it cannot be left half-applied', async (t) => {
  const { harness, calls, sync } = setup(t);
  await sync();
  harness.db.tables.lead_integrations[0].sync_status = 'FAILED';
  await sync();
  assert.equal(calls.update[1]['contact.email'], 'jane@example.com');
});

test('flag off: every update sends the full lead, as before', async (t) => {
  const { calls, sync } = setup(t, { flag: '' }); // '' = not set
  await sync();
  await sync({ postcode: '7000' });
  assert.equal(calls.update[1]['contact.email'], 'jane@example.com');
  assert.equal(calls.update[1]['contact.areaCode'], '7000');
});
