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
const { getDealerStudioPushFrom } = require('../config/env');

// Dealer Studio only receives leads created on or after DEALER_STUDIO_PUSH_FROM.
// 5 Nov 2026 00:00 AEDT = 4 Nov 2026 13:00 UTC; assigned_date is stored in UTC.

const CUTOFF = '2026-11-05T00:00:00+11:00';
const OLD = '2026-10-20 05:00:00';
const NEW = '2026-11-04 13:00:00'; // exactly at the cutoff
const DS = { crm_type: 'DEALER_STUDIO', base_url: 'https://8.8.8.8', create_lead_endpoint: '/api/v1/leads' };

test('getDealerStudioPushFrom: default, explicit value, off switch, unreadable value', (t) => {
  withEnv(t, { DEALER_STUDIO_PUSH_FROM: undefined });
  assert.equal(getDealerStudioPushFrom().toISOString(), '2026-11-04T13:00:00.000Z');
  process.env.DEALER_STUDIO_PUSH_FROM = '2026-12-01T00:00:00+11:00';
  assert.equal(getDealerStudioPushFrom().toISOString(), '2026-11-30T13:00:00.000Z');
  for (const off of ['off', 'OFF', 'none', 'false', '0']) {
    process.env.DEALER_STUDIO_PUSH_FROM = off;
    assert.equal(getDealerStudioPushFrom(), null, off);
  }
  process.env.DEALER_STUDIO_PUSH_FROM = 'not a date';
  assert.equal(getDealerStudioPushFrom().toISOString(), '2026-11-04T13:00:00.000Z', 'falls back to the default, never to "push everything"');
});

test('isBeforeDealerStudioCutoff only blocks Dealer Studio leads created before the cutoff', () => {
  const cutoff = new Date(CUTOFF);
  const before = crmIntegrationService.isBeforeDealerStudioCutoff;
  assert.equal(before(DS, { assigned_date: OLD }, cutoff), true);
  assert.equal(before(DS, { assigned_date: '2026-11-04 12:59:59' }, cutoff), true);
  assert.equal(before(DS, { assigned_date: NEW }, cutoff), false, 'the cutoff moment itself is allowed');
  assert.equal(before(DS, { assigned_date: '2026-11-06 01:00:00' }, cutoff), false);
  // Other CRMs are never affected.
  assert.equal(before({ crm_type: 'FUSION_SD' }, { assigned_date: OLD }, cutoff), false);
  assert.equal(before({ crm_type: 'ZOHO_CRM' }, { assigned_date: OLD }, cutoff), false);
  // No cutoff: nothing is blocked.
  assert.equal(before(DS, { assigned_date: OLD }, null), false);
});

test('a lead without assigned_date falls back to the row CREATEDTIME (project time, UTC+05:30)', () => {
  const cutoff = new Date(CUTOFF); // 2026-11-04 13:00 UTC = 18:30 IST
  const before = crmIntegrationService.isBeforeDealerStudioCutoff;
  assert.equal(before(DS, { CREATEDTIME: '2026-11-04 18:29:59:869' }, cutoff), true);
  assert.equal(before(DS, { CREATEDTIME: '2026-11-04 18:30:00:000' }, cutoff), false);
  assert.equal(before(DS, { assigned_date: '', CREATEDTIME: '2026-09-01 10:00:00:000' }, cutoff), true);
  // Nothing readable: not blocked (cannot prove it is old).
  assert.equal(before(DS, {}, cutoff), false);
  assert.equal(before(DS, { assigned_date: 'garbage' }, cutoff), false);
});

test('an existing (pre-cutoff) lead is not created in Dealer Studio: no create, no alert, no hold, no claim', async (t) => {
  withEnv(t, { DEALER_STUDIO_PUSH_FROM: CUTOFF });
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

test('a pre-cutoff lead that is already in Dealer Studio keeps syncing its updates', async (t) => {
  withEnv(t, { DEALER_STUDIO_PUSH_FROM: CUTOFF });
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

test('a lead created at or after the cutoff is pushed as before', async (t) => {
  withEnv(t, { DEALER_STUDIO_PUSH_FROM: CUTOFF });
  const harness = setupOutbound(t, { integration: DS, mapping: null, lead: { assigned_date: NEW, lead_department: 'Sales', sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: '777', httpStatus: 201, raw: { id: 777 } }) });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.notEqual(result?.reason, 'DEALER_STUDIO_BEFORE_CUTOFF');
  assert.equal(calls.create.length, 1, 'the new lead is created in Dealer Studio');
});

test('DEALER_STUDIO_PUSH_FROM=off pushes old leads too', async (t) => {
  withEnv(t, { DEALER_STUDIO_PUSH_FROM: 'off' });
  const harness = setupOutbound(t, { integration: DS, mapping: null, lead: { assigned_date: OLD, lead_department: 'Sales', sync_status: 'PENDING' } });
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: '778', httpStatus: 201, raw: { id: 778 } }) });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.notEqual(result?.reason, 'DEALER_STUDIO_BEFORE_CUTOFF');
  assert.equal(calls.create.length, 1);
});

test('other CRM types are not affected by the cutoff', async (t) => {
  withEnv(t, { DEALER_STUDIO_PUSH_FROM: CUTOFF });
  const harness = setupOutbound(t, { mapping: null, lead: { assigned_date: OLD, sync_status: 'PENDING' } }); // Fusion SD dealer
  const calls = fakeAdapter(t, { createLead: async () => ({ externalLeadId: '779', httpStatus: 201, raw: { id: 779 } }) });

  const result = await crmIntegrationService.syncLeadToExternalCrm(harness.db.app, harness.integration, harness.leadRow());

  assert.notEqual(result?.reason, 'DEALER_STUDIO_BEFORE_CUTOFF');
  assert.equal(calls.create.length, 1);
});
