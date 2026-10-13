'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Review (FUSION_REMEDIATION_PLAN.md, Batches 5-10): every new switch ON at
// once, as production would run after go-live, for a Fusion dealer set up
// like Buckby MG (Batch 4 presets), with a Zoho dealer (AU008) alongside.
// Each feature is tested on its own elsewhere; this checks that together
// they still give Happy 1, Happy 2, field ownership, changes-only updates,
// exactly-once inbound processing, the Fusion status rules, and the SLA.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { signStandardWebhook, generateSigningSecret } = require('./helpers/standardWebhooksSigner');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const oemCrmService = require('../services/zohoCrmService');
const snapshot = require('../services/integrations/sentPayloadSnapshot');
const webhookRoutes = require('../routes/webhookRoutes');

const ALL_FLAGS = {
  FUSION_INBOUND_V2: 'true',
  INBOUND_EVENT_STORE: 'true',
  SLA_DEALER_ACTION_CLOCK: 'true',
  FUSION_RATE_BUDGET: 'true',
  CRM_API_PER_DEALER_LIMIT: '3',
  CRON_WORK_BUDGET_MS: '25000',
  SYNC_CLAIM_FAIL_CLOSED: 'true',
  DURABLE_SYNC_CHECKPOINT: 'true',
  MAPPING_CACHE_PER_RUN: 'true',
  FULL_SYNC_STRICT_SNAPSHOT: 'true',
  FUSION_CHANGES_ONLY_PATCH: 'true',
};
const SECRET = generateSigningSecret();

function withAllFlags(t) {
  const vars = { ...ALL_FLAGS, INTEGRATION_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64') };
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => Object.entries(before).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }));
}

async function buckbyWithEverythingOn(t, { mgWrite = {} } = {}) {
  _resetForTests();
  withAllFlags(t);
  const harness = setupOutbound(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING', postcode: '7250' } });
  const { db } = harness;
  db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  db.tables.notifications = [];
  db.tables.webhook_events = [];
  Object.assign(db.tables.dealer_integrations[0], { inbound_enabled: true, webhook_enabled: true });

  // dedupe_key is UNIQUE in the live table.
  const datastore = db.app.datastore;
  db.app.datastore = () => ({
    table: (name) => {
      const real = datastore().table(name);
      if (name !== 'webhook_events') return real;
      return {
        ...real,
        insertRow: async (fields) => {
          if (db.tables.webhook_events.some((row) => !row.__deleted && row.dedupe_key === fields.dedupe_key)) {
            throw new Error('Duplicate value for dedupe_key. Please give a different value');
          }
          return real.insertRow(fields);
        },
      };
    },
  });

  const mgWrites = [];
  oemCrmService.updateOemLead.mock.mockImplementation(async (zohoLeadId, fields) => {
    if (mgWrite.fail) throw new Error('MG CRM unreachable');
    mgWrites.push({ zohoLeadId, fields });
    return { status: 'success' };
  });
  t.mock.method(catalyst, 'initialize', () => db.app);
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (app, id, type) =>
    (type === 'WEBHOOK_SIGNING_SECRET' ? SECRET : null));
  t.mock.method(integrationAuthService, 'hasCredential', async (app, id, type) => type === 'WEBHOOK_SIGNING_SECRET');
  const calls = fakeAdapter(t, {
    createLead: async () => ({ externalLeadId: fixtures.FUSION_TEST_LEAD_ID, httpStatus: 201, raw: {} }),
    updateLead: async (id) => ({ externalLeadId: id, httpStatus: 200, raw: {} }),
  });

  const server = express();
  server.use(webhookRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());

  const mgSync = async (changes = {}) => {
    Object.assign(db.tables.leads[0], changes);
    return crmIntegrationService.syncLeadToExternalCrm(db.app, harness.integration, harness.leadRow());
  };
  const fusionSends = async (status, { id } = {}) => {
    const signed = signStandardWebhook({ secret: SECRET, id, body: fixtures.inboundFlatWebhookPayload({ status }) });
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/AU999`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signed.headers },
      body: signed.body,
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...harness, calls, mgWrites, mgSync, fusionSends, mapping: () => db.tables.lead_integrations[0], lead: () => db.tables.leads[0] };
}

test('all flags on: Happy 1, Happy 2, ownership, changes-only, exactly-once and the Fusion status rules work together', async (t) => {
  const h = await buckbyWithEverythingOn(t);

  // Happy 1: the lead is created with the full payload; snapshot and clock start.
  const created = await h.mgSync();
  assert.equal(created.ok, true);
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.create[0]['contact.areaCode'], '7250');
  assert.equal(h.mapping().sync_status, 'SYNCED');
  assert.ok(snapshot.read(h.mapping()), 'snapshot kept');
  assert.ok(h.mapping().last_dealer_action_at, 'dealer clock started on delivery');
  assert.equal(h.lead().lead_status, 'Not Contacted', 'acknowledged in MG');

  // Fusion "Open" for a lead MG holds at Not Contacted: no change, no MG write.
  const open = await h.fusionSends('Open');
  assert.equal(open.status, 200);
  assert.equal(h.mgWrites.filter((w) => w.fields.Lead_Status !== 'Not Contacted').length, 0);

  // Happy 2: the dealer marks the lead Lost.
  const clockBefore = h.mapping().last_dealer_action_at;
  const lost = await h.fusionSends('Lost', { id: 'msg_lost' });
  assert.equal(lost.status, 200);
  assert.equal(lost.body.result.scenarioCode, 'Happy 2');
  assert.equal(h.lead().lead_status, 'Lost Lead');
  assert.deepEqual(h.mgWrites.at(-1).fields, { Lead_Status: 'Lost Lead' });
  assert.equal(snapshot.read(h.mapping()).enquiryStatus, 'Prospect Lost', 'recorded as what Fusion holds');
  assert.ok(h.mapping().last_dealer_action_at >= clockBefore, 'dealer clock restarted');
  const stored = h.db.tables.webhook_events.find((e) => e.event_id === 'msg_lost');
  assert.equal(stored.processing_status, 'SUCCESS');
  assert.ok(stored.payload_encrypted && !stored.payload_encrypted.includes('Lost'), 'stored encrypted');

  // Fusion retries the same event: answered DUPLICATE, nothing applied twice.
  const writesBefore = h.mgWrites.length;
  const again = await h.fusionSends('Lost', { id: 'msg_lost' });
  assert.equal(again.body.status, 'DUPLICATE');
  assert.equal(h.mgWrites.length, writesBefore);

  // Ownership + changes-only: an MG postcode edit sends only the postcode.
  const patched = await h.mgSync({ postcode: '7000' });
  assert.equal(patched.ok, true);
  assert.deepEqual(h.calls.update.at(-1), { 'contact.areaCode': '7000' });

  // A Fusion echo of its own Lost, and Won / Delivered, change nothing in MG.
  for (const status of ['Lost', 'Won', 'Delivered']) {
    const echo = await h.fusionSends(status);
    assert.equal(echo.status, 200, status);
  }
  assert.equal(h.mgWrites.length, writesBefore);
  assert.equal(h.lead().lead_status, 'Lost Lead');

  // MG itself re-opens the lead: its own status change is sent.
  await h.mgSync({ lead_status: 'Contacted' });
  assert.deepEqual(h.calls.update.at(-1), { enquiryStatus: 'Open' });
});

test('all flags on: a failed MG write is applied exactly once on Fusion\'s redelivery', async (t) => {
  const mgWrite = { fail: false };
  const h = await buckbyWithEverythingOn(t, { mgWrite });
  await h.mgSync();
  mgWrite.fail = true;
  const first = await h.fusionSends('Lost', { id: 'msg_c4' });
  assert.equal(first.status, 500);
  mgWrite.fail = false;
  const retry = await h.fusionSends('Lost', { id: 'msg_c4' });
  assert.equal(retry.status, 200);
  assert.equal(h.mgWrites.filter((w) => w.fields.Lead_Status === 'Lost Lead').length, 1);
  assert.equal(h.db.tables.webhook_events.find((e) => e.event_id === 'msg_c4').attempt_count, 2);
});

test('all flags on: the SLA judges a Fusion dealer with a proven channel, and AU008 exactly as before', async (t) => {
  const h = await buckbyWithEverythingOn(t);
  await h.mgSync();
  await h.fusionSends('Open', { id: 'msg_proof' }); // a signed webhook processed: channel proven
  // AU008 alongside, with an overdue lead nobody acted on.
  h.db.tables.dealer_integrations.push({ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED', integration_type: 'EXTERNAL_CRM' });
  const au008Id = String(1000 + h.db.tables.dealer_integrations.length - 1);
  h.db.tables.lead_integrations.push({
    zoho_lead_id: 'Z-AU008', dealer_code: 'AU008', integration_id: au008Id, sync_status: 'SYNCED',
    last_synced_at: '2026-10-01 00:00:00', last_dealer_action_at: '2026-10-01 00:00:00',
  });
  h.db.tables.leads.push({ crm_record_id: 'Z-AU008', lead_status: 'Not Contacted', sync_status: 'SYNCED' });
  // Buckby's lead: dealer clock old, still Not Contacted (nobody acted).
  Object.assign(h.mapping(), { last_dealer_action_at: '2026-10-01 00:00:00' });
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});

  _resetForTests();
  const results = await slaMonitorService.runSlaSweep(h.db.app, new Date('2026-10-13T06:00:00Z'), { clock: () => 0 });
  assert.deepEqual(results.exemptNoReturnChannel, []);
  assert.equal(results.dealerActionClock, 'last_dealer_action_at');
  assert.equal(h.db.tables.lead_integrations.find((m) => m.zoho_lead_id === 'Z-AU008').sync_status, 'SLA_BREACH');
  assert.equal(h.mapping().sync_status, 'SLA_BREACH', 'Fusion dealer judged once its channel is proven');
});

test('all flags on: AU008 (ZOHO_CRM) outbound sends its full record, with no snapshot, exactly as before', async (t) => {
  withAllFlags(t);
  const harness = setupOutbound(t, {
    integration: { crm_type: 'ZOHO_CRM', update_lead_endpoint: '/crm/v8/Leads/{externalLeadId}' },
    lead: { postcode: '7000' },
  });
  const calls = fakeAdapter(t, { updateLead: async (id) => ({ externalLeadId: id, httpStatus: 200, raw: {} }) });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, { ...harness.integration }, harness.leadRow());
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, { ...harness.integration }, harness.leadRow());
  assert.equal(calls.update.length, 2);
  assert.equal(calls.update[1]['contact.email'], 'jane@example.com', 'full record every time');
  assert.equal('last_sent_payload' in harness.db.tables.lead_integrations[0], false);
});
