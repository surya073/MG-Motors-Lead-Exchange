'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, {
  ZOHO_CLIENT_ID: 'test-client', ZOHO_CLIENT_SECRET: 'test-secret', ZOHO_REFRESH_TOKEN: 'test-refresh',
  ZOHO_API_DOMAIN: 'https://www.zohoapis.in', ZOHO_ACCOUNTS_DOMAIN: 'https://accounts.zoho.in',
  ZOHO_WEBHOOK_TOKEN: 'test-webhook', SYNC_CLAIM_FAIL_CLOSED: 'true',
});
const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const fixtures = require('./helpers/fusionFixtures');
const crm = require('../services/integrations/crmIntegrationService');
const claims = require('../services/integrations/outboundSyncClaimService');
const leadSync = require('../services/leadSyncService');
const scheduler = require('../services/integrations/outboundRetryScheduler');
const updateLead = async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });

for (const flag of ['true', 'false']) {
  test(`authoritative consent revocation blocks stale outbound snapshot (claim flag ${flag})`, async (t) => {
    withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: flag });
    const h = setupOutbound(t, { lead: { accept_privacy_policy: false } });
    const calls = fakeAdapter(t, { updateLead });
    const result = await crm.syncLeadToExternalCrm(h.db.app, h.integration, { ...h.leadRow(), accept_privacy_policy: true });
    assert.equal(calls.update.length, 0);
    assert.equal(result.reason, 'CONSENT_HOLD');
    assert.equal(h.db.tables.leads[0].sync_status, 'CONSENT_HOLD');
  });
}

test('old dealer retry is retired without changing the new owner state or badge', async (t) => {
  const h = setupOutbound(t, { lead: { dealer_code: 'AU_NEW', happy_unhappy_path_name: 'Happy 2' }, mapping: { sync_status: 'FAILED' } });
  const calls = fakeAdapter(t, { updateLead });
  const result = await crm.syncLeadToExternalCrm(h.db.app, h.integration, { ...h.leadRow(), dealer_code: 'AU999' });
  assert.equal(result.reason, 'DEALER_ROUTING_INVALID');
  assert.equal(result.terminal, true);
  assert.equal(calls.update.length, 0);
  assert.equal(h.db.tables.leads[0].sync_status, 'SYNCED');
  assert.equal(h.db.tables.leads[0].happy_unhappy_path_name, 'Happy 2');
  assert.equal(h.db.tables.lead_integrations[0].sync_status, 'HELD');
  assert.equal(h.logs().length, 0);
});

for (const kind of ['read failure', 'missing lead', 'disabled integration', 'removed dealer', 'invalid current data']) {
  test(`outbound fails closed for ${kind} after candidate selection`, async (t) => {
    const h = setupOutbound(t, { enforceUnique: true });
    const stale = h.leadRow();
    const calls = fakeAdapter(t, { updateLead });
    if (kind === 'read failure') {
      const original = h.db.app.zcql;
      h.db.app.zcql = () => ({ executeZCQLQuery: async (sql) => {
        if (sql.startsWith('SELECT * FROM leads')) throw new Error('synthetic authoritative read failed');
        return original().executeZCQLQuery(sql);
      } });
      await assert.rejects(crm.syncLeadToExternalCrm(h.db.app, h.integration, stale), /authoritative read failed/);
    } else {
      if (kind === 'missing lead') h.db.tables.leads.length = 0;
      if (kind === 'disabled integration') h.db.tables.dealer_integrations[0].status = 'DISABLED';
      if (kind === 'removed dealer') h.db.tables.dealers[0].sync_status = 'Removed';
      if (kind === 'invalid current data') h.db.tables.leads[0].postcode = 'bad';
      assert.equal((await crm.syncLeadToExternalCrm(h.db.app, h.integration, stale)).held, true);
    }
    assert.equal(calls.update.length, 0);
    assert.equal(h.oemWrites.length, 0);
  });
}

for (const failedCreate of [false, true]) {
  test(`OEM deletion retires a failed ${failedCreate ? 'create' : 'update'} and subsequent retry never revives it`, async (t) => {
    const h = setupOutbound(t, { mapping: { sync_status: 'FAILED', next_retry_at: '2020-01-01 00:00:00', ...(failedCreate ? { external_crm_lead_id: null } : {}) } });
    const calls = fakeAdapter(t, { updateLead, createLead: async () => ({ externalLeadId: 'forbidden', httpStatus: 201 }) });
    const stale = h.leadRow();
    await leadSync.syncLeadsByIds(h.db.app, ['ZL1'], { operation: 'delete' });
    await scheduler.runOutboundRetrySweep(h.db.app);
    await crm.syncLeadToExternalCrm(h.db.app, h.integration, stale);
    assert.equal(calls.create.length + calls.update.length, 0);
    assert.equal(h.db.tables.leads[0].sync_status, 'Removed');
    assert.equal(h.db.tables.lead_integrations[0].sync_status, 'HELD');
    assert.equal(h.db.tables.lead_integrations[0].last_error, 'LEAD_REMOVED');
    assert.equal(h.oemWrites.length, 0);
  });
}

for (const mutation of ['reassigned', 'removed', 'consent revoked', 'disabled', 'dealer removed']) {
  test(`inbound ${mutation} lead cannot be changed by retained mapping`, async (t) => {
    const h = setupOutbound(t, { integration: { crm_type: 'GENERIC_REST', update_lead_endpoint: '/leads' } });
    if (mutation === 'reassigned') h.db.tables.leads[0].dealer_code = 'AU_NEW';
    if (mutation === 'removed') h.db.tables.leads[0].sync_status = 'Removed';
    if (mutation === 'consent revoked') h.db.tables.leads[0].accept_privacy_policy = false;
    if (mutation === 'disabled') h.db.tables.dealer_integrations[0].status = 'DISABLED';
    if (mutation === 'dealer removed') h.db.tables.dealers[0].sync_status = 'Removed';
    const result = await crm.processInboundWebhook(h.db.app, h.integration,
      { id: fixtures.FUSION_TEST_LEAD_ID, enquiryStatus: 'Won' }, require('../services/zohoCrmService'));
    assert.equal(result.held, true);
    assert.equal(h.oemWrites.length, 0);
    assert.equal(h.db.tables.leads[0].lead_status, 'Not Contacted');
    if (mutation === 'removed') {
      assert.equal(h.db.tables.leads[0].sync_status, 'Removed');
      assert.equal(result.terminal, true);
    }
    if (mutation === 'reassigned') assert.equal(h.db.tables.leads[0].sync_status, 'SYNCED');
  });
}

test('old and new dealer claims for the same OEM lead are mutually exclusive', async (t) => {
  const h = setupOutbound(t, { enforceUnique: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = claims.withOutboundSyncClaim(h.db.app, 'old', 'ZL1', 'first', async () => { started(); await gate; });
  await ready;
  let ran = false;
  const second = await claims.withOutboundSyncClaim(h.db.app, 'new', 'ZL1', 'second', async () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(second.reason, 'CONCURRENT_SYNC_IN_PROGRESS');
  release(); await first;
  await claims.withOutboundSyncClaim(h.db.app, 'new', 'ZL1', 'third', async () => { ran = true; });
  assert.equal(ran, true);
});

test('deletion waits for in-flight lead mutation; retry after release succeeds', async (t) => {
  const h = setupOutbound(t, { enforceUnique: true });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const first = claims.withOutboundSyncClaim(h.db.app, '1000', 'ZL1', 'delivery', async () => { started(); await gate; });
  await ready;
  await assert.rejects(leadSync.syncLeadsByIds(h.db.app, ['ZL1'], { operation: 'delete' }), { code: 'CONCURRENT_SYNC_IN_PROGRESS' });
  assert.equal(h.db.tables.leads[0].sync_status, 'SYNCED');
  release(); await first;
  await leadSync.syncLeadsByIds(h.db.app, ['ZL1'], { operation: 'delete' });
  assert.equal(h.db.tables.leads[0].sync_status, 'Removed');
});

test('nested dispatch within an OEM lead claim reuses that claim and releases it on failure', async (t) => {
  const h = setupOutbound(t, { enforceUnique: true });
  await assert.rejects(claims.withOutboundSyncClaim(h.db.app, 'lead', 'ZL1', 'mirror', () =>
    claims.withOutboundSyncClaim(h.db.app, '1000', 'ZL1', 'dispatch', async () => { throw new Error('synthetic'); })), /synthetic/);
  assert.equal(h.db.tables.outbound_sync_claims.filter(row => !row.__deleted).length, 0);
});

test('first outbound delivery with an unreadable current lead is retained as local retry work', async (t) => {
  const h = setupOutbound(t, { mapping: null });
  const calls = fakeAdapter(t, { createLead: async () => { throw new Error('must not send'); } });
  const original = h.db.app.zcql;
  h.db.app.zcql = () => ({ executeZCQLQuery: async (sql) => {
    if (sql.startsWith('SELECT * FROM leads')) throw new Error('synthetic local read failure');
    return original().executeZCQLQuery(sql);
  } });
  await assert.rejects(crm.syncLeadToExternalCrm(h.db.app, h.integration, h.leadRow()), { code: 'CURRENT_STATE_UNAVAILABLE' });
  assert.equal(calls.create.length, 0);
  assert.equal(h.db.tables.lead_integrations[0].sync_status, 'FAILED');
  assert.equal(h.db.tables.lead_integrations[0].last_error, 'CURRENT_STATE_UNAVAILABLE');
  assert.ok(h.db.tables.lead_integrations[0].next_retry_at);
  assert.equal(require('../services/integrations/dealerErrorClassifier').classifyDealerError({ code: 'CURRENT_STATE_UNAVAILABLE' }), 'LOCAL');
});
