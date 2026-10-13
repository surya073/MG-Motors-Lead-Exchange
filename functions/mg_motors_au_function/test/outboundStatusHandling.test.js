'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const fixtures = require('./helpers/fusionFixtures');
const { FIELD_MAPPINGS, STATUS_MAPPINGS, LEAD, setupOutbound: setup, fakeAdapter } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

const { buildOutboundPayload, validateIntegrationConfiguration, classifyLogScenario } = crmIntegrationService._test;

// Outbound delivery to a Fusion SD dealer, end to end through the orchestrator
// with an in-memory datastore and a fake adapter (helpers/outboundHarness.js).

// A Fusion adapter whose updateLead answers with `respond(payload)`.
function fakeFusion(t, respond) {
  return fakeAdapter(t, { updateLead: respond }).update;
}

const accepted = (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {} });

// --- New issue #2: inbound-only statuses must not block outbound delivery ---

test('an MG status with only an inbound mapping is left out of the payload; other fields still go to Fusion', async (t) => {
  const { db, integration, leadRow, logs } = setup(t, { lead: { lead_status: 'Contacted' } });
  const sent = fakeFusion(t, accepted);

  const result = await crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.equal('enquiryStatus' in sent[0], false, 'MG "Contacted" is never sent to Fusion');
  assert.equal(sent[0]['contact.firstName'], 'Jane Citizen');
  assert.equal(logs().at(-1).happy_unhappy_path_name, 'Happy 5');
});

test('an MG status with no mapping in either direction still holds the lead as Unhappy 5', async (t) => {
  const { db, integration, leadRow, logs } = setup(t, { lead: { lead_status: 'Follow-up 1' } });
  const sent = fakeFusion(t, accepted);

  await assert.rejects(
    () => crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow()),
    (err) => err.code === 'INVALID_CRM_CONFIGURATION'
  );
  assert.equal(sent.length, 0);
  assert.equal(logs().at(-1).happy_unhappy_path_name, 'Unhappy 5');
});

test('buildOutboundPayload and validateIntegrationConfiguration treat an inbound-only status like an MG-only one', () => {
  const integration = { crm_type: 'FUSION_SD', base_url: 'https://8.8.8.8/api/leadapi', create_lead_endpoint: '/v1/leads' };
  const lead = { ...LEAD, lead_status: 'Contacted' };

  assert.equal('enquiryStatus' in buildOutboundPayload(lead, FIELD_MAPPINGS, STATUS_MAPPINGS), false);
  assert.equal(buildOutboundPayload({ ...lead, lead_status: 'Not Contacted' }, FIELD_MAPPINGS, STATUS_MAPPINGS).enquiryStatus, 'Open');
  assert.deepEqual(validateIntegrationConfiguration(integration, FIELD_MAPPINGS, STATUS_MAPPINGS, 'Contacted'), { valid: true, missingConfig: [] });
  assert.deepEqual(
    validateIntegrationConfiguration(integration, FIELD_MAPPINGS, STATUS_MAPPINGS, 'Follow-up 1').missingConfig,
    ['status:Follow-up 1']
  );
  assert.throws(
    () => buildOutboundPayload({ ...lead, lead_status: 'Follow-up 1' }, FIELD_MAPPINGS, STATUS_MAPPINGS),
    (err) => err.code === 'STATUS_MAPPING_NOT_FOUND'
  );
});

test('the log classifier keeps Unhappy 4 for dealer -> MG status failures; outbound ones are Unhappy 5', () => {
  const failed = (direction) => ({ direction, operation: 'UPDATE_LEAD', status: 'FAILED', error_message: 'STATUS_MAPPING_NOT_FOUND' });

  assert.equal(classifyLogScenario(failed('ZOHO_TO_EXTERNAL_CRM')).code, 'Unhappy 5');
  assert.equal(classifyLogScenario(failed('EXTERNAL_CRM_TO_ZOHO')).code, 'Unhappy 4');
  assert.equal(
    classifyLogScenario({ direction: 'EXTERNAL_CRM_TO_ZOHO', status: 'FAILED' }, { unmappedStatusValue: 'Sold' }).code,
    'Unhappy 4'
  );
});

// --- M5: the dealer's error details reach the failure log ---

test("a failed Fusion call stores the dealer's error details in the failure log", async (t) => {
  const { db, integration, leadRow, logs } = setup(t);
  const vendor = {
    status: 429,
    type: 'https://docs.fusionamspro.com/lead-api/errors/rate_limited',
    title: 'Too many requests',
    instance: 'lreq_1',
    retryAfter: 60,
  };
  fakeFusion(t, async () => {
    throw Object.assign(new Error('Fusion SD rejected the lead update request (HTTP 429)'), {
      code: 'EXTERNAL_CRM_ERROR',
      response: { status: 429 },
      vendor,
    });
  });

  await assert.rejects(() => crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow()));

  const log = logs().at(-1);
  assert.equal(log.status, 'FAILED');
  assert.equal(log.error_message, 'EXTERNAL_CRM_ERROR', 'error_message keeps the plain code');
  const changes = JSON.parse(log.field_changes);
  assert.ok(changes.some((change) => change.field === 'delivery_timing'));
  assert.deepEqual(changes.find((change) => change.field === 'dealer_error'), { field: 'dealer_error', ...vendor });
});

// --- H4: an update the dealer refused (403 updates_not_enabled) is not a delivery ---

const updatesDisabled = (externalLeadId) => {
  const { response } = fixtures.updatesNotEnabledError();
  return {
    externalLeadId,
    httpStatus: 403,
    raw: response.data,
    skipped: true,
    vendor: { status: 403, type: response.data.type, title: response.data.title, instance: response.data.instance },
  };
};

test('a refused update is logged SKIPPED, not SYNCED or Happy, and the mapping, lead and integration stay as they were', async (t) => {
  const { db, integration, leadRow, logs } = setup(t, {
    mapping: { last_sync_source_hash: 'previous', last_synced_at: '2026-10-01 10:00:00:000' },
    lead: { happy_unhappy_path_name: 'Happy 1' },
  });
  fakeFusion(t, updatesDisabled);
  const before = {
    mapping: { ...db.tables.lead_integrations[0] },
    lead: { ...db.tables.leads[0] },
    integration: { ...db.tables.dealer_integrations[0] },
  };

  const result = await crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());

  assert.deepEqual(result, { skipped: true, reason: 'DEALER_UPDATES_DISABLED' });
  assert.deepEqual(db.tables.lead_integrations[0], before.mapping, 'the mapping keeps its previous state');
  assert.deepEqual(db.tables.leads[0], before.lead, 'the lead, and its current path, are untouched');
  assert.deepEqual(db.tables.dealer_integrations[0], before.integration, 'the integration is not marked ACTIVE');

  const log = logs().at(-1);
  assert.equal(log.status, 'SKIPPED');
  assert.equal(log.error_message, 'DEALER_UPDATES_DISABLED');
  assert.equal(log.http_status, 403);
  assert.equal(log.happy_unhappy_path_name, undefined, 'not a Happy or Unhappy path');
  assert.match(log.happy_unhappy_path_message, /not applied/i);
  const dealerError = JSON.parse(log.field_changes).find((change) => change.field === 'dealer_error');
  assert.equal(dealerError.instance, 'lreq_test00000001');
});

test('one configuration alert per stretch of refused updates; it alerts again only after updates worked', async (t) => {
  const { db, integration, leadRow, alerts } = setup(t);
  let refuse = true;
  fakeFusion(t, (externalLeadId) => (refuse ? updatesDisabled(externalLeadId) : accepted(externalLeadId)));
  const sync = () => crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());
  const updatesDisabledAlerts = () => alerts.mock.calls
    .filter((call) => String(call.arguments[1].reason).startsWith('DEALER_UPDATES_DISABLED'))
    .length;

  await sync();
  await sync();
  assert.equal(updatesDisabledAlerts(), 1, 'not one alert per refused update');

  refuse = false;
  await sync();
  refuse = true;
  await sync();
  assert.equal(updatesDisabledAlerts(), 2, 'refused again after a successful update');
});

// Q6 (answered 13 Oct 2026): a lead that was waiting to retry is parked as
// HELD, so the retry sweep (FAILED / FAILED_CRITICAL only) stops re-sending a
// refused update on every run. Its next MG edit or a manual Retry sync sends
// it again.
test('a refused update parks a lead that was waiting to retry as HELD (Q6)', async (t) => {
  const { db, integration, leadRow } = setup(t, { mapping: { sync_status: 'FAILED', retry_count: '2', last_error: 'EXTERNAL_CRM_ERROR' } });
  fakeFusion(t, updatesDisabled);

  await crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());

  const mapping = db.tables.lead_integrations[0];
  assert.equal(mapping.sync_status, 'HELD');
  assert.equal(mapping.last_error, 'DEALER_UPDATES_DISABLED');
  assert.equal(mapping.retry_count, '2', 'the earlier failures stay on record');
});

test('an escalated lead (FAILED_CRITICAL) is parked the same way (Q6)', async (t) => {
  const { db, integration, leadRow } = setup(t, { mapping: { sync_status: 'FAILED_CRITICAL', retry_count: '7' } });
  fakeFusion(t, updatesDisabled);

  await crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());

  assert.equal(db.tables.lead_integrations[0].sync_status, 'HELD');
});

test('a parked lead is sent again by its next update and is SYNCED once Fusion applies it (Q6)', async (t) => {
  const { db, integration, leadRow } = setup(t, { mapping: { sync_status: 'HELD', last_error: 'DEALER_UPDATES_DISABLED' } });
  fakeFusion(t, accepted);

  const result = await crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());

  assert.equal(result.ok, true);
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SYNCED');
});

// --- H4: what Fusion did with an update is kept in the log ---

test("Fusion's update outcome is kept in the log; a manual-mode update is delivered and not retried", async (t) => {
  const { db, integration, leadRow, logs } = setup(t);
  const dealerResponse = { update_mode: 'manual', enquiry_linked: false, updated_fields: ['status'], ignored_fields: ['privacy'] };
  fakeFusion(t, (externalLeadId) => ({ externalLeadId, httpStatus: 200, raw: {}, dealerResponse }));

  const result = await crmIntegrationService.syncLeadToExternalCrm(db.app, integration, leadRow());

  assert.equal(result.ok, true);
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SYNCED', 'recorded at the dealer, so never retried');
  const log = logs().at(-1);
  assert.equal(log.status, 'SUCCESS');
  assert.equal(log.happy_unhappy_path_name, 'Happy 5');
  assert.deepEqual(
    JSON.parse(log.field_changes).find((change) => change.field === 'dealer_response'),
    { field: 'dealer_response', ...dealerResponse }
  );
});
