'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 10 (FUSION_REMEDIATION_PLAN.md): with FUSION_CHANGES_ONLY_PATCH on,
// the full payload last sent to a Fusion dealer is kept, encrypted, in
// lead_integrations.last_sent_payload, so the next update can send only what
// changed. It is written on its own: if the column does not exist yet or
// the value is too large, there is simply no snapshot and the sync is
// unaffected.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const snapshot = require('../services/integrations/sentPayloadSnapshot');

const created = async () => ({ externalLeadId: fixtures.FUSION_TEST_LEAD_ID, httpStatus: 201, raw: {} });
const updated = async (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });
const key = () => crypto.randomBytes(32).toString('base64');

test('flag off: no snapshot is written', async (t) => {
  withEnv(t, { FUSION_CHANGES_ONLY_PATCH: undefined, INTEGRATION_CREDENTIALS_KEY: key() });
  const harness = setupOutbound(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } });
  fakeAdapter(t, { createLead: created });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal('last_sent_payload' in harness.db.tables.lead_integrations[0], false);
});

test('flag on: a create stores exactly what was sent, encrypted', async (t) => {
  withEnv(t, { FUSION_CHANGES_ONLY_PATCH: 'true', INTEGRATION_CREDENTIALS_KEY: key() });
  const harness = setupOutbound(t, { mapping: null, lead: { lead_status: 'Update Pending', sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, { createLead: created });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  const stored = harness.db.tables.lead_integrations[0].last_sent_payload;
  assert.ok(stored);
  assert.equal(stored.includes('jane@example.com'), false, 'no plaintext PII');
  assert.deepEqual(snapshot.read({ last_sent_payload: stored }), calls.create[0]);
});

test('flag on: an update stores the full payload of that update', async (t) => {
  withEnv(t, { FUSION_CHANGES_ONLY_PATCH: 'true', INTEGRATION_CREDENTIALS_KEY: key() });
  const harness = setupOutbound(t, { lead: { postcode: '7000' } });
  fakeAdapter(t, { updateLead: updated });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  const sent = snapshot.read(harness.db.tables.lead_integrations[0]);
  assert.equal(sent['contact.areaCode'], '7000');
  assert.equal(sent['contact.email'], 'jane@example.com');
});

test('flag on: a missing column does not affect the sync', async (t) => {
  withEnv(t, { FUSION_CHANGES_ONLY_PATCH: 'true', INTEGRATION_CREDENTIALS_KEY: key() });
  const harness = setupOutbound(t, { lead: { postcode: '7000' } });
  const datastore = harness.db.app.datastore;
  harness.db.app.datastore = () => ({
    table: (name) => {
      const real = datastore().table(name);
      return {
        ...real,
        updateRow: async (fields) => {
          if ('last_sent_payload' in fields) throw new Error('Invalid column last_sent_payload');
          return real.updateRow(fields);
        },
      };
    },
  });
  fakeAdapter(t, { updateLead: updated });
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.equal(result.ok, true);
  assert.equal(harness.db.tables.lead_integrations[0].sync_status, 'SYNCED');
});

test('flag on: a non-Fusion dealer stores nothing', async (t) => {
  withEnv(t, { FUSION_CHANGES_ONLY_PATCH: 'true', INTEGRATION_CREDENTIALS_KEY: key() });
  const harness = setupOutbound(t, { integration: { crm_type: 'GENERIC_REST', update_lead_endpoint: '/x/{externalLeadId}' }, lead: { postcode: '7000' } });
  fakeAdapter(t, { updateLead: updated });
  await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, { ...harness.integration }, harness.leadRow());
  assert.equal('last_sent_payload' in harness.db.tables.lead_integrations[0], false);
});

test('a snapshot too large for the column, or unreadable, counts as none', (t) => {
  withEnv(t, { INTEGRATION_CREDENTIALS_KEY: key() });
  assert.equal(snapshot.serialize({ notes: 'x'.repeat(20000) }), null);
  assert.equal(snapshot.read({ last_sent_payload: 'not-a-ciphertext' }), null);
  assert.equal(snapshot.read({}), null);
  const small = snapshot.serialize({ a: '1' });
  assert.deepEqual(snapshot.read({ last_sent_payload: small }), { a: '1' });
});
