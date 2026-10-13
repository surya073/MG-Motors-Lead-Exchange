'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Q33 (FUSION_REMEDIATION_PLAN.md): a dealer update applied to MG set the
// lead's mapping to SYNCED even while an MG change to that lead was waiting
// for an outbound retry, so the retry sweep dropped it, and the change
// reached the dealer only with the lead's next MG edit. The inbound success
// also recorded the new state as an echo marker, so a kept retry would have
// been skipped as an echo. With KEEP_OUTBOUND_RETRY_ON_INBOUND on (default
// off, every CRM type), a pending retry (FAILED, FAILED_CRITICAL,
// RETRY_EXHAUSTED) is kept and no echo marker is written for it.

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const oemCrmService = require('../services/zohoCrmService');

// An AU008-like generic dealer; Fusion is covered with the presets below.
function generic(t, flag) {
  withEnv(t, { KEEP_OUTBOUND_RETRY_ON_INBOUND: flag });
  const harness = setupOutbound(t, {
    integration: { crm_type: 'GENERIC_REST', update_lead_endpoint: '/api/leads/{externalLeadId}' },
  });
  harness.db.tables.notifications = [];
  let failNext = true;
  const calls = fakeAdapter(t, {
    updateLead: async (externalLeadId) => {
      if (failNext) { failNext = false; throw Object.assign(new Error('dealer CRM unreachable'), { code: 'ECONNRESET' }); }
      return { externalLeadId, httpStatus: 200, raw: {} };
    },
  });
  const integration = { ...harness.integration };
  const mgEditFails = async (changes) => {
    Object.assign(harness.db.tables.leads[0], changes);
    return crmIntegrationService.syncLeadToExternalCrm(harness.db.app, integration, harness.leadRow()).catch(() => null);
  };
  const dealerUpdate = (body) => crmIntegrationService.processInboundWebhook(
    harness.db.app, integration, { id: fixtures.FUSION_TEST_LEAD_ID, ...body }, oemCrmService
  );
  const retrySweep = () => {
    _resetForTests();
    return outboundRetryScheduler.runOutboundRetrySweep(harness.db.app, { ignoreSchedule: true });
  };
  return { harness, calls, mgEditFails, dealerUpdate, retrySweep, mapping: () => harness.db.tables.lead_integrations[0] };
}

test('flag off: the dealer update marks the mapping SYNCED and the MG change is never retried (today\'s gap)', async (t) => {
  const g = generic(t, undefined);
  await g.mgEditFails({ postcode: '7000' });
  assert.equal(g.mapping().sync_status, 'FAILED');
  const applied = await g.dealerUpdate({ enquiryStatus: 'Won' });
  assert.equal(applied.ok, true);
  assert.equal(g.mapping().sync_status, 'SYNCED');
  const sweep = await g.retrySweep();
  assert.equal(sweep.attempted, 0);
  assert.equal(g.calls.update.length, 1, 'only the failed attempt was ever sent');
});

test('flag on: the dealer update is applied, the pending retry is kept, and the sweep delivers the MG change', async (t) => {
  const g = generic(t, 'true');
  await g.mgEditFails({ postcode: '7000' });
  const before = { ...g.mapping() };
  assert.equal(before.sync_status, 'FAILED');

  const applied = await g.dealerUpdate({ enquiryStatus: 'Won' });
  assert.equal(applied.ok, true);
  assert.equal(g.harness.db.tables.leads[0].lead_status, 'Contacted', 'the dealer update reached MG');
  const kept = g.mapping();
  for (const field of ['sync_status', 'retry_count', 'next_retry_at', 'failure_streak_started_at', 'last_error', 'last_sync_direction', 'last_sync_source_hash']) {
    assert.equal(kept[field], before[field], field);
  }

  const sweep = await g.retrySweep();
  assert.equal(sweep.recovered, 1, 'not skipped as an echo');
  assert.equal(g.calls.update.length, 2);
  assert.equal(g.calls.update[1]['contact.areaCode'], '7000');
  assert.equal(g.mapping().sync_status, 'SYNCED');
});

for (const state of ['FAILED_CRITICAL', 'RETRY_EXHAUSTED']) {
  test(`flag on: a ${state} mapping keeps its state through a dealer update`, async (t) => {
    const g = generic(t, 'true');
    Object.assign(g.mapping(), { sync_status: state, last_error: 'EXTERNAL_CRM_ERROR', retry_count: '4' });
    const applied = await g.dealerUpdate({ enquiryStatus: 'Won' });
    assert.equal(applied.ok, true);
    assert.equal(g.mapping().sync_status, state);
    assert.equal(g.mapping().last_error, 'EXTERNAL_CRM_ERROR');
    assert.equal(g.mapping().retry_count, '4');
  });
}

test('flag on: a mapping held for an inbound reason is resolved to SYNCED by a dealer update, as before', async (t) => {
  const g = generic(t, 'true');
  Object.assign(g.mapping(), { sync_status: 'HELD', last_error: 'UNMAPPED_STATUS:Sold' });
  await g.dealerUpdate({ enquiryStatus: 'Won' });
  assert.equal(g.mapping().sync_status, 'SYNCED');
  assert.equal(g.mapping().last_sync_direction, 'EXTERNAL_CRM_TO_ZOHO');
});

test('flag on: a mapping in sync is updated exactly as before (SYNCED, echo marker written)', async (t) => {
  const g = generic(t, 'true');
  await g.dealerUpdate({ enquiryStatus: 'Won' });
  assert.equal(g.mapping().sync_status, 'SYNCED');
  assert.equal(g.mapping().last_sync_direction, 'EXTERNAL_CRM_TO_ZOHO');
  assert.ok(g.mapping().last_sync_source_hash);
});
