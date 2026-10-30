'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 6 (FUSION_REMEDIATION_PLAN.md), audit M8: Fusion SD cannot be read
// back (no getLead), so a held Fusion update used to wait forever. With
// INBOUND_EVENT_STORE on, the replay sweep applies the newest stored event
// for that dealer lead that carries a status instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const fixtures = require('./helpers/fusionFixtures');
const { setupOutbound } = require('./helpers/outboundHarness');
const { FIELD_PRESET, STATUS_PRESET } = require('./helpers/fusionPresets');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');

const LEAD_ID = fixtures.FUSION_TEST_LEAD_ID;

function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => { if (v === null) delete process.env[k]; else process.env[k] = v; });
  t.after(() => Object.entries(before).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }));
}

function held(t, { store = 'true', v2 = 'true', events = [], scenario = 'Unhappy 4', mgStatus = 'Contacted' } = {}) {
  _resetForTests();
  withEnv(t, {
    INBOUND_EVENT_STORE: store,
    FUSION_INBOUND_V2: v2,
    INTEGRATION_CREDENTIALS_KEY: crypto.randomBytes(32).toString('base64'),
  });
  const harness = setupOutbound(t, { lead: { lead_status: mgStatus } });
  harness.db.tables.integration_field_mappings.splice(0, Infinity, ...FIELD_PRESET);
  harness.db.tables.integration_status_mappings.splice(0, Infinity, ...STATUS_PRESET);
  harness.db.tables.notifications = [];
  harness.db.tables.webhook_events = events.map(([createdTime, payload, externalLeadId = LEAD_ID]) => ({
    integration_id: '1000', dealer_code: 'AU999', processing_status: 'FAILED', CREATEDTIME: createdTime,
    external_lead_id: externalLeadId,
    payload_encrypted: payload === null ? null : integrationAuthService.encrypt(JSON.stringify(payload)),
  }));
  harness.db.tables.integration_logs.push({
    integration_id: '1000', dealer_code: 'AU999', external_lead_id: LEAD_ID, zoho_lead_id: 'ZL1',
    happy_unhappy_path_name: scenario, status: 'FAILED', error_message: 'MG_WRITE_BACK_FAILED:TRANSPORT: timeout',
    CREATEDTIME: '2026-10-13 09:00:00:000', MODIFIEDTIME: '2026-10-13 09:00:00:000',
  });
  return harness;
}

const heldLog = (harness) => harness.logs().find((log) => log.happy_unhappy_path_name !== undefined && log.CREATEDTIME);

test('a held Fusion update is applied from its stored event and closed as RECOVERED', async (t) => {
  const harness = held(t, { events: [['2026-10-13 09:00:00:000', { lead_id: LEAD_ID, status: 'Lost' }]] });
  const results = await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.equal(results.attempted, 1);
  assert.equal(results.recovered, 1);
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Lost Lead' } }]);
  assert.equal(heldLog(harness).status, 'RECOVERED');
  assert.equal(harness.db.tables.webhook_events[0].processing_status, 'SUCCESS');
});

test('a held update stored in Fusion\'s reworked shape (enquiryStatus) is replayed too', async (t) => {
  const harness = held(t, { events: [['2026-10-28 06:00:00:000', { lead_id: LEAD_ID, leadId: LEAD_ID, enquiryStatus: 'Lost' }]] });
  const results = await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.equal(results.recovered, 1);
  assert.deepEqual(harness.oemWrites, [{ zohoLeadId: 'ZL1', fields: { Lead_Status: 'Lost Lead' } }]);
});

test('the newest stored event with a status is used; a newer one without a status (notes) is passed over', async (t) => {
  const harness = held(t, {
    events: [
      ['2026-10-13 08:00:00:000', { lead_id: LEAD_ID, status: 'Prospect Lost' }],
      ['2026-10-13 09:00:00:000', { lead_id: LEAD_ID, status: 'Lost' }],
      ['2026-10-13 09:30:00:000', { lead_id: LEAD_ID, status: null, notes: [{ text: 'rang' }] }],
    ],
  });
  await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Lost Lead' });
});

test('an Unhappy 7 hold (update arrived before the mapping) is applied from the store once the mapping exists', async (t) => {
  const harness = held(t, { scenario: 'Unhappy 7', events: [['2026-10-13 09:00:00:000', { lead_id: LEAD_ID, status: 'Prospect Lost' }]] });
  const results = await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.equal(results.recovered, 1);
  assert.deepEqual(harness.oemWrites[0].fields, { Lead_Status: 'Not Qualified' });
});

test('a stored status that changes nothing (Fusion Open for a progressed lead) still closes the hold', async (t) => {
  const harness = held(t, { events: [['2026-10-13 09:00:00:000', { lead_id: LEAD_ID, status: 'Open' }]] });
  const results = await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.equal(results.recovered, 1);
  assert.equal(harness.oemWrites.length, 0);
  assert.equal(heldLog(harness).status, 'RECOVERED');
});

test('no stored event (or only another lead\'s, or an unreadable one): the hold is left waiting, untouched', async (t) => {
  const harness = held(t, {
    events: [
      ['2026-10-13 09:00:00:000', { lead_id: 'lead_OTHER', status: 'Lost' }, 'lead_OTHER'],
      ['2026-10-13 09:10:00:000', null],
    ],
  });
  harness.db.tables.webhook_events[1].payload_encrypted = 'not-a-ciphertext';
  const results = await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.equal(results.recovered, 0);
  assert.equal(harness.oemWrites.length, 0);
  assert.equal(heldLog(harness).status, 'FAILED');
});

test('flag off: a held Fusion update is left untouched, as today', async (t) => {
  const harness = held(t, { store: null, events: [['2026-10-13 09:00:00:000', { lead_id: LEAD_ID, status: 'Lost' }]] });
  const before = JSON.stringify(harness.db.tables.integration_logs);
  const results = await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.equal(results.attempted, 0);
  assert.equal(harness.oemWrites.length, 0);
  assert.equal(JSON.stringify(harness.db.tables.integration_logs), before);
});

test('a status the dealer map still cannot translate stays held, without a second log or alert', async (t) => {
  const harness = held(t, { events: [['2026-10-13 09:00:00:000', { lead_id: LEAD_ID, status: 'Sold - Awaiting Finance' }]] });
  const logsBefore = harness.logs().length;
  const results = await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.equal(results.recovered, 0);
  assert.equal(harness.logs().length, logsBefore);
  assert.equal(harness.alerts.mock.callCount(), 0);
  assert.equal(heldLog(harness).status, 'FAILED');
});

// Audit L7: a held row with no dealer integration or no dealer record id can
// never be replayed; it is closed with a reason instead of waiting forever.
test('a held row without an integration or dealer record id is closed with a reason (every CRM type)', async (t) => {
  const harness = held(t, { store: null });
  harness.db.tables.integration_logs.push(
    { integration_id: null, external_lead_id: 'x', happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED', error_message: 'MG_WRITE_BACK_FAILED:TRANSPORT', CREATEDTIME: '2026-10-13 08:00:00:000' },
    { integration_id: '1000', external_lead_id: null, happy_unhappy_path_name: 'Unhappy 7', status: 'FAILED', error_message: 'LEAD_MAPPING_NOT_FOUND', CREATEDTIME: '2026-10-13 08:00:01:000' },
  );
  const results = await inboundReplayScheduler.runInboundReplaySweep(harness.db.app);
  assert.equal(results.closedUnreplayable, 2);
  const [a, b] = harness.db.tables.integration_logs.slice(-2);
  for (const row of [a, b]) {
    assert.equal(row.status, 'CLOSED');
    assert.match(row.error_message, /closed: no dealer record to replay/);
  }
  assert.match(a.error_message, /^MG_WRITE_BACK_FAILED:TRANSPORT/, 'the original reason is kept');
});
