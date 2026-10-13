'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { toCatalystDateTime } = require('../utils/dateFormat');

// A failure streak older than the (default 24 h) escalation window turns the
// lead into "Dealer Unavailable" (Unhappy 3). ESCALATION_TRANSIENT_ONLY limits
// that to a dealer-side outage (TRANSIENT) of a lead the dealer has not
// received yet; unset keeps today's behaviour for every counted failure.

const PAST_THE_WINDOW = toCatalystDateTime(new Date(Date.now() - 25 * 60 * 60 * 1000));
const retryingMapping = (extra = {}) => ({ sync_status: 'FAILED', retry_count: '5', failure_streak_started_at: PAST_THE_WINDOW, ...extra });
const queueFull = () => Object.assign(new Error('queue full'), { code: 'CRM_API_QUEUE_FULL' });
const outage = () => Object.assign(new Error('HTTP 503'), { code: 'EXTERNAL_CRM_ERROR', response: { status: 503 } });

async function fail(t, { error, mapping, integration, create = false }) {
  const harness = setupOutbound(t, { mapping, integration });
  fakeAdapter(t, create
    ? { createLead: async () => { if (error) throw error; return { externalLeadId: undefined, httpStatus: 201, raw: '' }; } }
    : { updateLead: async () => { throw error; } });
  await assert.rejects(() => crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()));
  return {
    mapping: harness.db.tables.lead_integrations[0],
    lead: harness.db.tables.leads[0],
    dealerUnavailableWrites: harness.oemWrites.filter((write) => write.fields.Lead_Status === 'Dealer Unavailable').length,
    log: harness.logs().at(-1),
  };
}

test('by default any counted failure past the window escalates, including our own queue being full', async (t) => {
  withEnv(t, { ESCALATION_TRANSIENT_ONLY: undefined });

  const result = await fail(t, { error: queueFull(), mapping: retryingMapping() });

  assert.equal(result.mapping.sync_status, 'FAILED_CRITICAL');
  assert.equal(result.dealerUnavailableWrites, 1);
  assert.equal(result.lead.lead_status, 'Dealer Unavailable');
  assert.equal(result.log.happy_unhappy_path_name, 'Unhappy 3');
});

test('ESCALATION_TRANSIENT_ONLY: our queue being full never escalates', async (t) => {
  withEnv(t, { ESCALATION_TRANSIENT_ONLY: 'true' });

  const result = await fail(t, { error: queueFull(), mapping: retryingMapping() });

  assert.equal(result.mapping.sync_status, 'FAILED');
  assert.equal(result.dealerUnavailableWrites, 0);
  assert.equal(result.lead.lead_status, 'Not Contacted', 'business status untouched');
  assert.equal(result.log.happy_unhappy_path_name, 'Unhappy 1');
});

test('ESCALATION_TRANSIENT_ONLY: a failed update of a lead the dealer already has never escalates', async (t) => {
  withEnv(t, { ESCALATION_TRANSIENT_ONLY: 'true' });

  const result = await fail(t, { error: outage(), mapping: retryingMapping() });

  assert.equal(result.mapping.sync_status, 'FAILED');
  assert.equal(result.dealerUnavailableWrites, 0);
});

test('ESCALATION_TRANSIENT_ONLY: a dealer outage for a lead not yet delivered still escalates', async (t) => {
  withEnv(t, { ESCALATION_TRANSIENT_ONLY: 'true' });

  const result = await fail(t, { error: outage(), mapping: retryingMapping({ external_crm_lead_id: '' }), create: true });

  assert.equal(result.mapping.sync_status, 'FAILED_CRITICAL');
  assert.equal(result.dealerUnavailableWrites, 1);
  assert.equal(result.log.happy_unhappy_path_name, 'Unhappy 3');
});

test('ESCALATION_TRANSIENT_ONLY: a create accepted without an id never escalates (generic dealer)', async (t) => {
  withEnv(t, { ESCALATION_TRANSIENT_ONLY: 'true' });

  const result = await fail(t, {
    mapping: retryingMapping({ external_crm_lead_id: '' }),
    integration: { crm_type: 'GENERIC_REST', update_lead_endpoint: '/v1/leads/{externalLeadId}' },
    create: true,
  });

  assert.equal(result.mapping.last_error, 'DEALER_ACK_MISSING_ID');
  assert.equal(result.mapping.sync_status, 'FAILED');
  assert.equal(result.dealerUnavailableWrites, 0);
});
