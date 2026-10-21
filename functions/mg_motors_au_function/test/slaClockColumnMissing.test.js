'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Review of Batch 7 (FUSION_REMEDIATION_PLAN.md): SLA_DEALER_ACTION_CLOCK
// needs the lead_integrations.last_dealer_action_at column. Switched on
// before the column exists, it must not break anything: the clock is written
// on its own (a delivery, an admin link and a dealer update still complete),
// and the SLA sweep falls back to last_synced_at, as with the flag off.

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { createSlaFixture } = require('./helpers/slaFixture');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const slaMonitorService = require('../services/integrations/slaMonitorService');

// The column does not exist: any write or query naming it fails.
function withoutClockColumn(db) {
  const datastore = db.app.datastore;
  db.app.datastore = () => ({
    table: (name) => {
      const real = datastore().table(name);
      const refuse = (fields) => {
        if (name === 'lead_integrations' && 'last_dealer_action_at' in fields) {
          throw new Error('Invalid input value for column last_dealer_action_at');
        }
      };
      return {
        ...real,
        insertRow: async (fields) => { refuse(fields); return real.insertRow(fields); },
        updateRow: async (fields) => { refuse(fields); return real.updateRow(fields); },
      };
    },
  });
  const zcql = db.app.zcql;
  db.app.zcql = () => ({
    executeZCQLQuery: async (sql) => {
      if (/last_dealer_action_at/.test(sql)) throw new Error('Invalid column last_dealer_action_at');
      return zcql().executeZCQLQuery(sql);
    },
  });
  return db;
}

const created = async () => ({ externalLeadId: fixtures.FUSION_TEST_LEAD_ID, httpStatus: 201, raw: {} });

test('a first delivery completes and is SYNCED although the clock cannot be written', async (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true' });
  const harness = setupOutbound(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } });
  withoutClockColumn(harness.db);
  fakeAdapter(t, { createLead: created });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(result.ok, true);
  const mapping = harness.db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'SYNCED');
  assert.equal(mapping.external_crm_lead_id, fixtures.FUSION_TEST_LEAD_ID);
});

test('an admin link of an unresolved lead completes although the clock cannot be written', async (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true' });
  const harness = setupOutbound(t, { mapping: { sync_status: 'ACK_UNRESOLVED', external_crm_lead_id: '' } });
  withoutClockColumn(harness.db);
  await crmIntegrationService.linkUnresolvedLead(harness.db.app, harness.integration, harness.leadRow(), 'lead_LINKED');
  const mapping = harness.db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'SYNCED');
  assert.equal(mapping.external_crm_lead_id, 'lead_LINKED');
});

test('a dealer update is applied and recorded although the clock cannot be written', async (t) => {
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true', FUSION_INBOUND_V2: 'true' });
  const harness = setupOutbound(t, { lead: { lead_status: 'Contacted' } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  withoutClockColumn(harness.db);
  const result = await crmIntegrationService.processInboundWebhook(
    harness.db.app, harness.integration, fixtures.inboundFlatWebhookPayload({ status: 'Lost' }), oemCrmService
  );
  assert.equal(result.ok, true);
  assert.equal(harness.db.tables.lead_integrations[0].last_sync_direction, 'EXTERNAL_CRM_TO_ZOHO');
  assert.equal(harness.logs().some((log) => /LOCAL_BOOKKEEPING|MG_WRITE_BACK_FAILED/.test(log.error_message || '')), false);
});

test('the SLA sweep falls back to last_synced_at, and still breaches an overdue AU008 lead', async (t) => {
  _resetForTests();
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true' });
  const NOW = Date.parse('2026-10-13T06:00:00Z');
  const db = withoutClockColumn(createSlaFixture({
    dealer_integrations: [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED' }],
    lead_integrations: [{ zoho_lead_id: 'Z1', dealer_code: 'AU008', integration_id: '1000', sync_status: 'SYNCED', last_synced_at: '2026-10-10 06:00:00' }],
    leads: [{ crm_record_id: 'Z1', lead_status: 'Not Contacted', sync_status: 'SYNCED' }],
    outbound_sync_claims: [],
  }));
  t.mock.method(oemCrmService, 'updateOemLead', async () => ({ status: 'success' }));
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  const results = await slaMonitorService.runSlaSweep(db.app, new Date(NOW), { clock: () => 0 });
  assert.equal(results.dealerActionClock, 'last_synced_at');
  assert.equal(results.breached, 1);
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SLA_BREACH');
});

test('with the column present the sweep reports the dealer-action clock', async (t) => {
  _resetForTests();
  withEnv(t, { SLA_DEALER_ACTION_CLOCK: 'true' });
  const db = createSlaFixture({
    dealer_integrations: [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED' }],
    lead_integrations: [],
    leads: [],
    outbound_sync_claims: [],
  });
  const results = await slaMonitorService.runSlaSweep(db.app, new Date(), { clock: () => 0 });
  assert.equal(results.dealerActionClock, 'last_dealer_action_at');
});
