'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupOutbound, fakeAdapter, withEnv } = require('./helpers/outboundHarness');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { isDealerStudioNewLeadsOnly, isFusionSdNewLeadsOnly } = require('../config/env');

// A Dealer Studio dealer only receives leads created at MG on or after the moment
// that dealer was connected (its dealer_integrations row's CREATEDTIME, project time
// Asia/Kolkata = UTC+05:30). A lead's creation time is assigned_date (UTC).
// Connected 5 Nov 2026 07:55 IST = 5 Nov 02:25 UTC.

const CONNECTED_5_NOV = '2026-11-05 07:55:00:000';
const CONNECTED_3_NOV = '2026-11-03 06:47:00:000';
const OLD = '2026-10-20 05:00:00';
const AFTER_CONNECT = '2026-11-05 03:00:00';
const DS = { crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads', CREATEDTIME: CONNECTED_5_NOV };

const before = (integration, lead, enabled) => crmIntegrationService.isBeforeDealerStudioCutoff(integration, lead, enabled);

test('DEALER_STUDIO_NEW_LEADS_ONLY is on by default and turned off by false/off/no/0', (t) => {
  withEnv(t, { DEALER_STUDIO_NEW_LEADS_ONLY: undefined });
  assert.equal(isDealerStudioNewLeadsOnly(), true);
  for (const off of ['false', 'FALSE', 'off', 'no', '0', ' Off ']) {
    process.env.DEALER_STUDIO_NEW_LEADS_ONLY = off;
    assert.equal(isDealerStudioNewLeadsOnly(), false, off);
  }
  for (const on of ['true', '1', 'yes', 'garbage', '']) {
    process.env.DEALER_STUDIO_NEW_LEADS_ONLY = on;
    assert.equal(isDealerStudioNewLeadsOnly(), true, `"${on}" stays on`);
  }
});

test('a lead created before the dealer was connected is blocked; one created at or after is not', () => {
  assert.equal(before(DS, { assigned_date: OLD }, true), true);
  assert.equal(before(DS, { assigned_date: '2026-11-05 02:24:59' }, true), true, 'one second before connecting');
  assert.equal(before(DS, { assigned_date: '2026-11-05 02:25:00' }, true), false, 'the connect moment itself is allowed');
  assert.equal(before(DS, { assigned_date: AFTER_CONNECT }, true), false);
});

test('the cutoff is per dealer: the same lead is blocked for a later-connected dealer and allowed for an earlier one', () => {
  const lead = { assigned_date: '2026-11-04 10:00:00' };
  assert.equal(before({ ...DS, CREATEDTIME: CONNECTED_5_NOV }, lead, true), true, 'connected 5 Nov: a 4 Nov lead is an existing lead');
  assert.equal(before({ ...DS, CREATEDTIME: CONNECTED_3_NOV }, lead, true), false, 'connected 3 Nov: a 4 Nov lead is new');
});

test('a lead without assigned_date falls back to the lead row CREATEDTIME (project time)', () => {
  assert.equal(before(DS, { CREATEDTIME: '2026-11-05 07:54:59:869' }, true), true);
  assert.equal(before(DS, { CREATEDTIME: '2026-11-05 07:55:00:000' }, true), false);
  assert.equal(before(DS, { assigned_date: '', CREATEDTIME: '2026-09-01 10:00:00:000' }, true), true);
});

test('nothing is blocked when a date cannot be read, for other CRMs, or when the switch is off', () => {
  assert.equal(before(DS, {}, true), false, 'lead with no readable date');
  assert.equal(before(DS, { assigned_date: 'garbage' }, true), false);
  assert.equal(before({ ...DS, CREATEDTIME: undefined }, { assigned_date: OLD }, true), false, 'dealer with no readable date');
  assert.equal(before({ ...DS, crm_type: 'ZOHO_CRM' }, { assigned_date: OLD }, true), false);
  assert.equal(before(DS, { assigned_date: OLD }, false), false, 'switch off');
});

test('an existing lead (created before the dealer connected) is not created in Dealer Studio: no create, alert, hold or claim', async (t) => {
  withEnv(t, { DEALER_STUDIO_NEW_LEADS_ONLY: undefined });
  const harness = setupOutbound(t, { integration: DS, mapping: null, lead: { assigned_date: OLD, sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, {}); // any adapter call fails the test

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.deepEqual(result, { skipped: true, reason: 'DEALER_STUDIO_BEFORE_CUTOFF' });
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(harness.alerts.mock.callCount(), 0);
  assert.equal(harness.db.tables.lead_integrations.length, 0, 'no mapping row is written');
  assert.equal(harness.db.tables.outbound_sync_claims.length, 0, 'no claim is taken');
  assert.equal(harness.logs().length, 0, 'no integration log / hold is raised');
  assert.equal(harness.db.tables.leads[0].sync_status, 'PENDING', 'the lead row is left alone');
});

test('an existing lead that is already in Dealer Studio keeps syncing its updates', async (t) => {
  withEnv(t, { DEALER_STUDIO_NEW_LEADS_ONLY: undefined });
  const harness = setupOutbound(t, {
    integration: DS,
    mapping: { external_crm_lead_id: '555', sync_status: 'SYNCED' },
    lead: { assigned_date: OLD, lead_department: 'Sales' },
  });
  const calls = fakeAdapter(t, { updateLead: async () => ({ httpStatus: 200, raw: {} }) });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.notEqual(result?.reason, 'DEALER_STUDIO_BEFORE_CUTOFF');
  assert.equal(calls.create.length, 0, 'never created again');
});

test('a lead created after the dealer connected is pushed as before', async (t) => {
  withEnv(t, { DEALER_STUDIO_NEW_LEADS_ONLY: undefined });
  const harness = setupOutbound(t, { integration: DS, mapping: null, lead: { assigned_date: AFTER_CONNECT, lead_department: 'Sales', sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: '777', httpStatus: 201, raw: { id: 777 } }) });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.notEqual(result?.reason, 'DEALER_STUDIO_BEFORE_CUTOFF');
  assert.equal(calls.create.length, 1, 'the new lead is created in Dealer Studio');
});

test('DEALER_STUDIO_NEW_LEADS_ONLY=false pushes the dealer\'s earlier leads too', async (t) => {
  withEnv(t, { DEALER_STUDIO_NEW_LEADS_ONLY: 'false' });
  const harness = setupOutbound(t, { integration: DS, mapping: null, lead: { assigned_date: OLD, lead_department: 'Sales', sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: '778', httpStatus: 201, raw: { id: 778 } }) });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.notEqual(result?.reason, 'DEALER_STUDIO_BEFORE_CUTOFF');
  assert.equal(calls.create.length, 1);
});

test('Fusion SD: same per-dealer cutoff, own switch FUSION_SD_NEW_LEADS_ONLY', async (t) => {
  withEnv(t, { FUSION_SD_NEW_LEADS_ONLY: undefined });
  const FS = { crm_type: 'FUSION_SD', CREATEDTIME: CONNECTED_5_NOV };
  assert.equal(isFusionSdNewLeadsOnly(), true);
  assert.equal(before(FS, { assigned_date: OLD }), true);
  assert.equal(before(FS, { assigned_date: AFTER_CONNECT }), false);
  const harness = setupOutbound(t, { integration: FS, mapping: null, lead: { assigned_date: OLD, sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, {});
  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());
  assert.deepEqual(result, { skipped: true, reason: 'DEALER_STUDIO_BEFORE_CUTOFF' });
  assert.equal(calls.create.length, 0);
  process.env.FUSION_SD_NEW_LEADS_ONLY = 'false';
  assert.equal(before(FS, { assigned_date: OLD }), false, 'switch off');
  assert.equal(before({ ...FS, crm_type: 'ZOHO_CRM' }, { assigned_date: OLD }), false);
});

test('other CRM types are not affected', async (t) => {
  withEnv(t, { DEALER_STUDIO_NEW_LEADS_ONLY: undefined });
  const harness = setupOutbound(t, { integration: { crm_type: 'GENERIC_REST', update_lead_endpoint: '/leads', CREATEDTIME: CONNECTED_5_NOV }, mapping: null, lead: { assigned_date: OLD, sync_status: 'PENDING' } }); // generic REST dealer
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: '779', httpStatus: 201, raw: { id: 779 } }) });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.notEqual(result?.reason, 'DEALER_STUDIO_BEFORE_CUTOFF');
  assert.equal(calls.create.length, 1);
});
