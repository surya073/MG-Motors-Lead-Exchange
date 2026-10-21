'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 8 (FUSION_REMEDIATION_PLAN.md), audit S4: when the per-lead claim
// cannot be stored, a sync used to go ahead with no duplicate protection
// (fail open). With SYNC_CLAIM_FAIL_CLOSED on it is deferred instead: an
// outbound delivery is recorded as a temporary LOCAL failure for the retry
// sweep, an inbound update is held for the replay sweep. The lead is also
// re-read under the claim, so the payload reflects the latest MG edit.

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const outboundSyncClaimService = require('../services/integrations/outboundSyncClaimService');
const oemCrmService = require('../services/zohoCrmService');
const { classifyDealerError } = require('../services/integrations/dealerErrorClassifier');
const fusionRateBudget = require('../services/integrations/fusionRateBudget');

// Makes every write to outbound_sync_claims fail, as when the table is missing.
function breakClaims(db) {
  const datastore = db.app.datastore;
  db.app.datastore = () => ({
    table: (name) => {
      const real = datastore().table(name);
      if (name !== 'outbound_sync_claims') return real;
      return { ...real, insertRow: async () => { throw new Error('Table outbound_sync_claims not found'); } };
    },
  });
}

const updated = async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });

test('claim service: explicit false preserves the legacy fail-open override', async (t) => {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'false' });
  const harness = setupOutbound(t);
  breakClaims(harness.db);
  let ran = false;
  await outboundSyncClaimService.withOutboundSyncClaim(harness.db.app, '1000', 'ZL1', 'ref', async () => { ran = true; });
  assert.equal(ran, true);
});

test('claim service: unavailable claims fail closed by default', async (t) => {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: undefined });
  const harness = setupOutbound(t);
  breakClaims(harness.db);
  let ran = false;
  const result = await outboundSyncClaimService.withOutboundSyncClaim(harness.db.app, '1000', 'ZL1', 'ref', async () => { ran = true; });
  assert.equal(ran, false);
  assert.deepEqual(result, { skipped: true, reason: 'CLAIM_UNAVAILABLE' });
});

test('claim service, flag on: the work is not run and the caller is told why', async (t) => {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'true' });
  const harness = setupOutbound(t);
  breakClaims(harness.db);
  let ran = false;
  const result = await outboundSyncClaimService.withOutboundSyncClaim(harness.db.app, '1000', 'ZL1', 'ref', async () => { ran = true; });
  assert.equal(ran, false);
  assert.deepEqual(result, { skipped: true, reason: 'CLAIM_UNAVAILABLE' });
});

test('outbound, flag on: nothing is sent; the lead is queued for retry as a LOCAL failure, without an alert', async (t) => {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'true' });
  const harness = setupOutbound(t, { lead: { postcode: '7000' } });
  breakClaims(harness.db);
  const calls = fakeAdapter(t, { updateLead: updated });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'CLAIM_UNAVAILABLE');
  assert.equal(calls.update.length, 0);
  const mapping = harness.db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'FAILED');
  assert.equal(mapping.last_error, 'CLAIM_UNAVAILABLE');
  assert.ok(mapping.next_retry_at, 'the retry sweep will pick it up');
  assert.equal(harness.alerts.mock.callCount(), 0);
});

test('outbound, flag off: delivered without a claim, exactly as before', async (t) => {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'false' });
  const harness = setupOutbound(t, { lead: { postcode: '7000' } });
  breakClaims(harness.db);
  const calls = fakeAdapter(t, { updateLead: updated });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(result.ok, true);
  assert.equal(calls.update.length, 1);
});

test('inbound, flag on: the dealer update is held for replay, not applied unprotected', async (t) => {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'true' });
  const harness = setupOutbound(t, { lead: { lead_status: 'Not Contacted' } });
  harness.db.tables.notifications = [];
  breakClaims(harness.db);
  const integration = { ...harness.integration, crm_type: 'GENERIC_REST' };
  const result = await crmIntegrationService.processInboundWebhook(
    harness.db.app, integration, { id: fixtures.FUSION_TEST_LEAD_ID, enquiryStatus: 'Won' }, oemCrmService
  );
  assert.equal(result.held, true);
  assert.equal(harness.oemWrites.length, 0);
  const log = harness.logs().find((row) => row.status === 'FAILED');
  assert.equal(log.error_message, 'CLAIM_UNAVAILABLE');
  assert.equal(log.happy_unhappy_path_name, 'Unhappy 4');
});

test('flag on: the lead is re-read under the claim, so the payload carries the latest MG edit', async (t) => {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'true' });
  const harness = setupOutbound(t, { lead: { postcode: '7000' } });
  const calls = fakeAdapter(t, { updateLead: updated });
  const stale = { ...harness.leadRow(), postcode: '3000' };
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, stale);
  assert.equal(calls.update[0]['contact.areaCode'], '7000');
});

test('flag off: authoritative lead validation still uses the current row', async (t) => {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'false' });
  const harness = setupOutbound(t, { lead: { postcode: '7000' } });
  const calls = fakeAdapter(t, { updateLead: updated });
  const stale = { ...harness.leadRow(), postcode: '3000' };
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, stale);
  assert.equal(calls.update[0]['contact.areaCode'], '7000');
});

test('our own refusals are LOCAL (never "Dealer Unavailable"); a Fusion 429 cool-down stays TRANSIENT', () => {
  assert.equal(classifyDealerError({ code: 'CLAIM_UNAVAILABLE' }), 'LOCAL');
  assert.equal(classifyDealerError(fusionRateBudget._test.limitError('FUSION_RATE_BUDGET_EXHAUSTED', 10, { ROWID: '1' })), 'LOCAL');
  assert.equal(classifyDealerError(fusionRateBudget._test.limitError('FUSION_COOLDOWN', 10, { ROWID: '1' })), 'TRANSIENT');
});
