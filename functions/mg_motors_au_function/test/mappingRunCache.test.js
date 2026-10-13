'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 9a (FUSION_REMEDIATION_PLAN.md), audit S6: every outbound attempt
// re-read the dealer's field and status mappings, so a sweep of N leads for
// one dealer read the same rows N times. With MAPPING_CACHE_PER_RUN on, they
// are read once per dealer per sweep (outbound retry, inbound replay,
// reconciliation, lead sync). The cache lives only for that run, so a mapping
// an admin saves is used from the next run, and a webhook outside any run
// reads fresh, as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { fakeAdapter, withEnv, FIELD_MAPPINGS, STATUS_MAPPINGS, LEAD } = require('./helpers/outboundHarness');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const integrationAlertService = require('../services/integrations/integrationAlertService');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const mappingRunCache = require('../services/integrations/mappingRunCache');

function sweepDb(leadCount) {
  const leads = Array.from({ length: leadCount }, (_, i) => ({ ...LEAD, crm_record_id: `ZL${i}`, enquiry_id: `ENQ-${i}` }));
  return createInMemoryZcql({
    dealers: [{ dealer_code: 'AU999', dealer_name: 'Fusion Dealer' }],
    dealer_integrations: [{
      dealer_code: 'AU999', integration_type: 'EXTERNAL_CRM', crm_type: 'FUSION_SD', status: 'ACTIVE',
      outbound_enabled: true, base_url: 'https://8.8.8.8/api/leadapi', create_lead_endpoint: '/v1/leads',
    }],
    integration_field_mappings: FIELD_MAPPINGS.map((row) => ({ integration_id: '1000', ...row })),
    integration_status_mappings: STATUS_MAPPINGS.map((row) => ({ integration_id: '1000', ...row })),
    lead_integrations: leads.map((lead) => ({
      integration_id: '1000', dealer_code: 'AU999', zoho_lead_id: lead.crm_record_id,
      external_crm_lead_id: `lead_${lead.crm_record_id}`, sync_status: 'FAILED', retry_count: '1',
    })),
    leads,
    integration_logs: [],
    outbound_sync_claims: [],
  });
}

const reads = (db, table) => db.queries.filter((q) => q.includes(`FROM ${table} `) || q.endsWith(`FROM ${table}`)).length;

async function sweep(t, db) {
  _resetForTests();
  t.mock.method(integrationAlertService, 'notifyScenario', async () => ({ sent: false }));
  const calls = fakeAdapter(t, { updateLead: async (id) => ({ externalLeadId: id, httpStatus: 200, raw: {} }) });
  const results = await outboundRetryScheduler.runOutboundRetrySweep(db.app, { ignoreSchedule: true });
  return { results, calls };
}

test('flag off: each of 3 leads re-reads the dealer\'s mappings, as before', async (t) => {
  withEnv(t, { MAPPING_CACHE_PER_RUN: undefined });
  const db = sweepDb(3);
  const { results } = await sweep(t, db);
  assert.equal(results.recovered, 3);
  assert.ok(reads(db, 'integration_field_mappings') >= 3);
  assert.ok(reads(db, 'integration_status_mappings') >= 3);
});

test('flag on: one sweep of 3 leads reads each dealer\'s mappings once, and delivers the same payloads', async (t) => {
  withEnv(t, { MAPPING_CACHE_PER_RUN: 'true' });
  const db = sweepDb(3);
  const { results, calls } = await sweep(t, db);
  assert.equal(results.recovered, 3);
  assert.equal(reads(db, 'integration_field_mappings'), 1);
  assert.equal(reads(db, 'integration_status_mappings'), 1);
  assert.equal(calls.update.length, 3);
  assert.equal(calls.update[0]['contact.phone'], '0412345678');
});

test('flag on: the next sweep reads again, so a mapping saved in between is used', async (t) => {
  withEnv(t, { MAPPING_CACHE_PER_RUN: 'true' });
  const db = sweepDb(1);
  await sweep(t, db);
  t.mock.restoreAll();
  db.tables.integration_field_mappings.find((m) => m.source_field === 'postcode').target_field = 'contact.postcode';
  db.tables.lead_integrations[0].sync_status = 'FAILED';
  const { calls } = await sweep(t, db);
  assert.equal(calls.update[0]['contact.postcode'], '3000');
  assert.equal(reads(db, 'integration_field_mappings'), 2);
});

test('flag on: outside a run (e.g. a webhook) mappings are read fresh every time', async (t) => {
  withEnv(t, { MAPPING_CACHE_PER_RUN: 'true' });
  const db = sweepDb(1);
  await crmIntegrationService.getFieldMappings(db.app, '1000');
  await crmIntegrationService.getFieldMappings(db.app, '1000');
  assert.equal(reads(db, 'integration_field_mappings'), 2);
});

test('within a run, each caller gets its own array; a failed read is not cached', async (t) => {
  withEnv(t, { MAPPING_CACHE_PER_RUN: 'true' });
  const db = sweepDb(1);
  await mappingRunCache.runWithMappingCache(async () => {
    const first = await crmIntegrationService.getFieldMappings(db.app, '1000');
    first.length = 0;
    const second = await crmIntegrationService.getFieldMappings(db.app, '1000');
    assert.equal(second.length, FIELD_MAPPINGS.length);

    let attempts = 0;
    const flaky = () => { attempts += 1; if (attempts === 1) throw new Error('busy'); return Promise.resolve(['ok']); };
    await assert.rejects(mappingRunCache.cachedForRun('test', '1', flaky));
    assert.deepEqual(await mappingRunCache.cachedForRun('test', '1', flaky), ['ok']);
  });
});
