'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Acceptance for Batch 6 (FUSION_REMEDIATION_PLAN.md, audit C4): with
// FUSION_INBOUND_V2 and INBOUND_EVENT_STORE on, a failed MG write, a crash
// after receipt, a duplicate while processing and a later redelivery each
// end with the dealer's update applied to MG exactly once.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { signStandardWebhook, generateSigningSecret } = require('./helpers/standardWebhooksSigner');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const oemCrmService = require('../services/zohoCrmService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const webhookRoutes = require('../routes/webhookRoutes');

const SECRET = generateSigningSecret();
const PAYLOAD = fixtures.inboundFlatWebhookPayload({ status: 'Lost' });

function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => { process.env[k] = v; });
  t.after(() => Object.entries(before).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }));
}

async function buckby(t, { mgWrite } = {}) {
  _resetForTests();
  withEnv(t, {
    FUSION_INBOUND_V2: 'true',
    INBOUND_EVENT_STORE: 'true',
    INTEGRATION_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64'),
  });
  const harness = setupOutbound(t, { lead: { lead_status: 'Contacted' } });
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

  // MG writes: counted, and failing while `mgWrite.fail` is set.
  const writes = [];
  oemCrmService.updateOemLead.mock.mockImplementation(async (zohoLeadId, fields) => {
    if (mgWrite?.fail) throw new Error('MG CRM unreachable');
    writes.push({ zohoLeadId, fields });
    return { status: 'success' };
  });

  t.mock.method(catalyst, 'initialize', () => db.app);
  t.mock.method(integrationAuthService, 'getDecryptedCredential', async (app, id, type) =>
    (type === 'WEBHOOK_SIGNING_SECRET' ? SECRET : null));

  const server = express();
  server.use(webhookRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());

  // Fusion's delivery of event `id`: a retry carries the same id and body
  // with a fresh timestamp and signature.
  const deliver = async (id = 'msg_c4') => {
    const signed = signStandardWebhook({ secret: SECRET, id, body: PAYLOAD });
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/webhooks/dealers/AU999`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...signed.headers },
      body: signed.body,
    });
    return { status: response.status, body: await response.json() };
  };
  return { ...harness, writes, deliver, event: () => db.tables.webhook_events[0] };
}

test('C4: a failed MG write, then Fusion\'s redelivery, applies the update once', async (t) => {
  const mgWrite = { fail: true };
  const h = await buckby(t, { mgWrite });
  const first = await h.deliver();
  assert.equal(first.status, 500, 'non-2xx, so Fusion retries');
  assert.equal(h.event().processing_status, 'FAILED');

  mgWrite.fail = false;
  const retry = await h.deliver();
  assert.equal(retry.status, 200);
  assert.equal(h.event().processing_status, 'SUCCESS');
  assert.equal(h.event().attempt_count, 2);

  const late = await h.deliver();
  assert.equal(late.body.status, 'DUPLICATE');
  assert.deepEqual(h.writes, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Lost Lead' } }], 'written exactly once');
  assert.equal(h.db.tables.webhook_events.length, 1);
});

test('C4: a failed MG write that Fusion never redelivers is applied once by the replay sweep', async (t) => {
  const mgWrite = { fail: true };
  const h = await buckby(t, { mgWrite });
  await h.deliver();
  const held = h.logs().find((log) => log.status === 'FAILED' && log.happy_unhappy_path_name === 'Unhappy 4');
  assert.ok(held, 'held as Unhappy 4');
  Object.assign(held, { CREATEDTIME: '2026-10-13 09:00:00:000', MODIFIEDTIME: '2026-10-13 09:00:00:000' });
  h.event().CREATEDTIME = '2026-10-13 09:00:00:000';

  mgWrite.fail = false;
  const sweep = await inboundReplayScheduler.runInboundReplaySweep(h.db.app);
  assert.equal(sweep.recovered, 1);
  assert.equal(held.status, 'RECOVERED');
  assert.equal(h.event().processing_status, 'SUCCESS');

  // A redelivery after that is a duplicate: nothing is written twice.
  await h.deliver();
  assert.equal(h.writes.length, 1);
});

test('C4: a crash after receipt (RECEIVED, lease expired) is processed once on redelivery', async (t) => {
  const h = await buckby(t);
  h.db.tables.webhook_events.push({
    integration_id: '1000', dealer_code: 'AU999', event_id: 'msg_c4', dedupe_key: '1000:msg_c4',
    processing_status: 'RECEIVED', attempt_count: 1, lease_until: toCatalystDateTime(new Date(Date.now() - 1000)),
  });
  const retry = await h.deliver();
  assert.equal(retry.status, 200);
  assert.equal(h.event().processing_status, 'SUCCESS');
  assert.equal(h.writes.length, 1);
});

test('C4: a duplicate while the first delivery is processing gets 202 and is not processed', async (t) => {
  const h = await buckby(t);
  h.db.tables.webhook_events.push({
    integration_id: '1000', dealer_code: 'AU999', event_id: 'msg_c4', dedupe_key: '1000:msg_c4',
    processing_status: 'RECEIVED', attempt_count: 1, lease_until: toCatalystDateTime(new Date(Date.now() + 60000)),
  });
  const duplicate = await h.deliver();
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.status, 'IN_PROGRESS');
  assert.equal(h.writes.length, 0);
});
