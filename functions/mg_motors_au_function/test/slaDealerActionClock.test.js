'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 7 (FUSION_REMEDIATION_PLAN.md), Q25: the dealer-action SLA used to
// run from lead_integrations.last_synced_at, which every outbound update,
// retry and sweep rewrites, so MG editing a lead restarted the dealer's
// clock. With SLA_DEALER_ACTION_CLOCK on it runs from last_dealer_action_at:
// set when the lead is first delivered (the dealer's acknowledgement) and
// whenever a dealer change is applied to MG, and by nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const { isSlaDealerActionClockEnabled } = require('../config/env');

const created = async () => ({ externalLeadId: fixtures.FUSION_TEST_LEAD_ID, httpStatus: 201, raw: {} });
const updated = async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });

test('SLA_DEALER_ACTION_CLOCK is off unless set to true', (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: undefined });
  assert.equal(isSlaDealerActionClockEnabled(), false);
  process.env.SLA_DEALER_ACTION_CLOCK = 'true';
  assert.equal(isSlaDealerActionClockEnabled(), true);
});

// ---- writes ----------------------------------------------------------------

function withPresets(t, options) {
  const harness = setupOutbound(t, options);
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  return harness;
}

test('flag on: the first delivery starts the clock', async (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true' });
  const harness = withPresets(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } });
  fakeAdapter(t, { createLead: created });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  const mapping = harness.db.tables.lead_integrations[0];
  assert.match(mapping.last_dealer_action_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('flag on: an outbound update does not touch the clock', async (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true' });
  const harness = withPresets(t, { mapping: { last_dealer_action_at: '2026-10-01 00:00:00' }, lead: { postcode: '7000' } });
  fakeAdapter(t, { updateLead: updated });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(harness.db.tables.lead_integrations[0].last_dealer_action_at, '2026-10-01 00:00:00');
});

test('flag off: nothing writes the new column (it may not exist yet)', async (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: undefined, FUSION_INBOUND_V2: 'true' });
  const harness = withPresets(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } });
  fakeAdapter(t, { createLead: created });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  await crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status: 'Lost' }), oemCrmService
  );
  assert.equal(Object.prototype.hasOwnProperty.call(harness.db.tables.lead_integrations[0], 'last_dealer_action_at'), false);
});

test('flag on: a dealer change applied to MG restarts the clock; one that changes nothing does not', async (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true', FUSION_INBOUND_V2: 'true' });
  const harness = withPresets(t, { mapping: { last_dealer_action_at: '2026-10-01 00:00:00' }, lead: { lead_status: 'Contacted' } });
  await crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status: 'Open' }), oemCrmService
  );
  assert.equal(harness.db.tables.lead_integrations[0].last_dealer_action_at, '2026-10-01 00:00:00');
  await crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status: 'Lost' }), oemCrmService
  );
  assert.notEqual(harness.db.tables.lead_integrations[0].last_dealer_action_at, '2026-10-01 00:00:00');
});

// ---- the sweep -------------------------------------------------------------

const NOW = Date.parse('2026-10-13T06:00:00Z');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const DAYS_AGO = (n) => utc(NOW - n * 24 * 3600 * 1000);

function slaDb(t, mappingOverrides, { flag = 'true', leadStatus = 'Not Contacted' } = {}) {
  _resetForTests();
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: flag === null ? undefined : flag });
  const db = createInMemoryZcql({
    dealer_integrations: [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED' }],
    lead_integrations: [{ zoho_lead_id: 'Z1', dealer_code: 'AU008', integration_id: '1000', sync_status: 'SYNCED', ...mappingOverrides }],
    leads: [{ crm_record_id: 'Z1', lead_status: leadStatus, sync_status: 'SYNCED' }],
    outbound_sync_claims: [],
  });
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({ status: 'success' }));
  const scenarios = [];
  t.mock.method(crmIntegrationService, 'recordScenario', async (_app, args) => { scenarios.push(args); });
  return { db, scenarios };
}
const sweep = (db) => slaMonitorService.runSlaSweep(db.app, new Date(NOW), { clock: () => 0 });

test('flag on: MG editing a lead (fresh last_synced_at) no longer hides an overdue dealer', async (t) => {
  const { db, scenarios } = slaDb(t, { last_synced_at: DAYS_AGO(0.01), last_dealer_action_at: DAYS_AGO(3) });
  await sweep(db);
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SLA_BREACH');
  assert.match(scenarios[0].reason, new RegExp(`Last dealer action ${new Date(Date.parse(`${DAYS_AGO(3).replace(' ', 'T')}Z`)).toISOString()}`));
});

test('flag off: the same lead is judged on last_synced_at, as today (not overdue)', async (t) => {
  const { db } = slaDb(t, { last_synced_at: DAYS_AGO(0.01), last_dealer_action_at: DAYS_AGO(3) }, { flag: null });
  await sweep(db);
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SYNCED');
});

test('flag on: a recent dealer action is not overdue, however old last_synced_at is', async (t) => {
  const { db } = slaDb(t, { last_synced_at: DAYS_AGO(5), last_dealer_action_at: DAYS_AGO(0.01) });
  await sweep(db);
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SYNCED');
});

test('flag on: an actioned lead is rotated on the dealer clock; last_synced_at is left alone', async (t) => {
  const { db } = slaDb(t, { last_synced_at: DAYS_AGO(5), last_dealer_action_at: DAYS_AGO(3) }, { leadStatus: 'Contacted' });
  await sweep(db);
  const mapping = db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'SYNCED');
  assert.equal(mapping.last_synced_at, DAYS_AGO(5));
  assert.equal(mapping.last_dealer_action_at, utc(NOW));
});

test('flag on: a mapping from before the switch takes its clock from last_synced_at, then is judged on it', async (t) => {
  const { db } = slaDb(t, { last_synced_at: DAYS_AGO(3) });
  const results = await sweep(db);
  const mapping = db.tables.lead_integrations[0];
  assert.equal(results.backfilledDealerActionClock, 1);
  assert.equal(mapping.last_dealer_action_at, DAYS_AGO(3));
  assert.equal(mapping.sync_status, 'SLA_BREACH');
});

test('flag on: the backfill only fills SYNCED mappings that have a last_synced_at, and never overwrites', async (t) => {
  const { db } = slaDb(t, { last_synced_at: DAYS_AGO(3), last_dealer_action_at: DAYS_AGO(1) });
  db.tables.lead_integrations.push(
    { zoho_lead_id: 'Z2', integration_id: '1000', sync_status: 'FAILED', last_synced_at: DAYS_AGO(3) },
    { zoho_lead_id: 'Z3', integration_id: '1000', sync_status: 'SYNCED', last_synced_at: null },
  );
  const results = await sweep(db);
  assert.equal(results.backfilledDealerActionClock, 0);
  assert.equal(db.tables.lead_integrations[0].last_dealer_action_at, DAYS_AGO(1));
  assert.equal(db.tables.lead_integrations[1].last_dealer_action_at, undefined);
});
