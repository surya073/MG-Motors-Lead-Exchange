'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const { setupOutbound, fakeAdapter } = require('./helpers/outboundHarness');
const fixtures = require('./helpers/fusionFixtures');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const routes = require('../routes/dealerCrmIntegrationRoutes');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const { VIEW_USER_ROLE_ID } = require('../middleware/requireAdminOrViewRole');

// C1: Fusion accepted a create (2xx) but returned no lead id we can trust.
// The lead may exist at the dealer, so it must never be created again: the
// mapping becomes ACK_UNRESOLVED until an admin links the dealer's lead id.

const acceptedWithoutId = async () => ({ externalLeadId: undefined, httpStatus: 201, raw: 'OK' });
const neverDelivered = { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } };

async function deliverWithoutId(t, options = neverDelivered) {
  const harness = setupOutbound(t, options);
  const calls = fakeAdapter(t, { createLead: acceptedWithoutId });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  return { ...harness, calls, result };
}

test('a Fusion create answered without an id becomes ACK_UNRESOLVED, logged as Unhappy 11 with the payload hash', async (t) => {
  const { db, alerts, result, logs } = await deliverWithoutId(t);

  assert.deepEqual(result, { skipped: true, reason: 'ACK_UNRESOLVED', scenarioCode: 'Unhappy 11' });
  const mapping = db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'ACK_UNRESOLVED');
  assert.ok(!mapping.external_crm_lead_id);
  assert.equal(mapping.last_error, 'DEALER_ACK_MISSING_ID');
  assert.equal(db.tables.leads[0].sync_status, 'ACK_UNRESOLVED');

  const log = logs().at(-1);
  assert.equal(log.status, 'FAILED');
  assert.equal(log.happy_unhappy_path_name, 'Unhappy 11');
  assert.match(log.error_message, /^DEALER_ACK_MISSING_ID: /);
  const submitted = JSON.parse(log.field_changes).find((change) => change.field === 'submitted_payload');
  assert.match(submitted.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!log.field_changes.includes('jane@example.com'), 'a hash, not the customer data');
  assert.equal(alerts.mock.callCount(), 1);
});

test('an ACK_UNRESOLVED lead is never created again, by a retry or a later edit, and alerts only once', async (t) => {
  const first = await deliverWithoutId(t);
  const again = await crmIntegrationService.syncLeadToExternalCrm(first.db.app, first.integration, first.leadRow());

  assert.deepEqual(again, { skipped: true, reason: 'ACK_UNRESOLVED' });
  assert.equal(first.calls.create.length, 1, 'no second create');
  assert.equal(first.alerts.mock.callCount(), 1);
  assert.equal(first.db.tables.lead_integrations[0].sync_status, 'ACK_UNRESOLVED');
});

test('a generic REST dealer keeps today\'s behaviour: a missing id is a retried failure', async (t) => {
  const harness = setupOutbound(t, {
    ...neverDelivered,
    integration: { crm_type: 'GENERIC_REST', update_lead_endpoint: '/v1/leads/{externalLeadId}' },
  });
  fakeAdapter(t, { createLead: acceptedWithoutId });

  await assert.rejects(
    () => crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow()),
    (err) => err.code === 'DEALER_ACK_MISSING_ID'
  );
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'FAILED');
});

// --- admin actions ---

async function adminRequest(t, db, path, body, roleId = ADMIN_ROLE_ID) {
  t.mock.method(catalyst, 'initialize', () => db.app);
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => {
    res.locals.currentUser = { email_id: 'a@example.com', role_details: { role_id: roleId } };
    next();
  });
  server.use(routes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("linking the dealer's lead id completes the delivery, and later edits are sent as updates", async (t) => {
  const { db, oemWrites, logs, integration, leadRow, calls } = await deliverWithoutId(t);

  const linked = await adminRequest(t, db, '/AU999/integration/link-lead', {
    crmRecordId: 'ZL1',
    externalLeadId: fixtures.FUSION_TEST_LEAD_ID,
  });

  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  const mapping = db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'SYNCED');
  assert.equal(mapping.external_crm_lead_id, fixtures.FUSION_TEST_LEAD_ID);
  assert.equal(db.tables.leads[0].sync_status, 'SYNCED');
  assert.equal(db.tables.leads[0].lead_status, 'Not Contacted', 'the acknowledgement a delivered create records');
  assert.deepEqual(oemWrites.at(-1), { zohoLeadId: 'ZL1', fields: { Lead_Status: 'Not Contacted', Lead_Exchanged: true } });
  assert.equal(logs().at(-1).happy_unhappy_path_name, 'Happy 1');
  assert.match(logs().at(-1).happy_unhappy_path_message, /linked/i);

  // A later edit now goes out as an update, never as a second create.
  t.mock.method(require('../services/integrations/crmAdapterFactory'), 'getAdapter', () => ({
    createLead: async () => { throw new Error('must not create'); },
    updateLead: async (_app, _integration, externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} }),
  }));
  const update = await crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());
  assert.equal(update.ok, true);
  assert.equal(calls.create.length, 1);
});

test('linking refuses a malformed id, a lead that is not unresolved, and a view-only user', async (t) => {
  const { db } = await deliverWithoutId(t);

  assert.equal((await adminRequest(t, db, '/AU999/integration/link-lead', { crmRecordId: 'ZL1', externalLeadId: 'not an id' })).status, 400);
  assert.equal((await adminRequest(t, db, '/AU999/integration/link-lead', { crmRecordId: 'ZL1', externalLeadId: 'lead_01X' }, VIEW_USER_ROLE_ID)).status, 403);

  db.tables.lead_integrations[0].sync_status = 'SYNCED';
  const notUnresolved = await adminRequest(t, db, '/AU999/integration/link-lead', { crmRecordId: 'ZL1', externalLeadId: 'lead_01X' });
  assert.equal(notUnresolved.status, 409);
  assert.equal(notUnresolved.body.error, 'LEAD_NOT_UNRESOLVED');
});

test('replaying a RETRY_EXHAUSTED lead resets its retries and delivers it (Happy 4); an unresolved one must be linked instead', async (t) => {
  const harness = setupOutbound(t, {
    mapping: { sync_status: 'RETRY_EXHAUSTED', retry_count: '10', failure_streak_started_at: '2026-10-01 10:00:00', last_error: 'NOT_FOUND' },
    lead: { sync_status: 'RETRY_EXHAUSTED' },
  });
  fakeAdapter(t, { updateLead: async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} }) });

  const replayed = await adminRequest(t, harness.db, '/AU999/integration/replay', { crmRecordId: 'ZL1' });

  assert.equal(replayed.status, 200, JSON.stringify(replayed.body));
  assert.equal(replayed.body.result.scenarioCode, 'Happy 4');
  const mapping = harness.db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'SYNCED');
  assert.equal(mapping.retry_count, '0');

  harness.db.tables.lead_integrations[0].sync_status = 'ACK_UNRESOLVED';
  const unresolved = await adminRequest(t, harness.db, '/AU999/integration/replay', { crmRecordId: 'ZL1' });
  assert.equal(unresolved.status, 409);
  assert.equal(unresolved.body.error, 'LEAD_NOT_REPLAYABLE');
});

test('replay refuses a disabled integration up front, like a manual sync, and leaves the stopped lead as it was', async (t) => {
  const harness = setupOutbound(t, {
    integration: { status: 'DISABLED' },
    mapping: { sync_status: 'RETRY_EXHAUSTED', retry_count: '10', failure_streak_started_at: '2026-10-01 10:00:00', last_error: 'NOT_FOUND' },
    lead: { sync_status: 'RETRY_EXHAUSTED' },
  });
  const calls = fakeAdapter(t, {});

  const replayed = await adminRequest(t, harness.db, '/AU999/integration/replay', { crmRecordId: 'ZL1' });

  assert.equal(replayed.status, 400);
  assert.equal(replayed.body.error, 'INTEGRATION_DISABLED');
  const mapping = harness.db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'RETRY_EXHAUSTED');
  assert.equal(mapping.retry_count, '10');
  assert.equal(harness.db.tables.leads[0].sync_status, 'RETRY_EXHAUSTED');
  assert.equal(calls.update.length + calls.create.length, 0);
});
