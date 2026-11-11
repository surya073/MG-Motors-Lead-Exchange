'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

// Routing-hold reprocess (outbound, fast-recover): only dealers that can be served are
// counted, so held leads of dealers with no integration cost nothing, and a dealer whose
// Push leads switch is OFF is not re-sent. Switching Push ON brings the held leads back on
// the next run.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const crm = require('../services/integrations/crmIntegrationService');
const retry = require('../services/integrations/outboundRetryScheduler');
const usageContext = require('../services/usageContext');

const counted = (fn) => usageContext.runWithContext({}, async (ctx) => ({ result: await fn(), ds: ctx.ds }));
const reprocess = (db) => counted(() => retry._test.reprocessRoutingHolds(usageContext.instrument(db.app)));

// 30 dealers (D0..D29) have held leads and no integration; LIVE has an integration changed
// after its leads were held.
function holdsDb({ pushEnabled, liveLeads = 2 } = {}) {
  const leads = [];
  for (let i = 0; i < 30; i += 1) {
    leads.push({ crm_record_id: `H${i}`, dealer_code: `D${i}`, sync_status: 'ROUTING_HOLD', MODIFIEDTIME: '2026-10-01 00:00:00:000' });
  }
  for (let i = 0; i < liveLeads; i += 1) {
    leads.push({ crm_record_id: `L${i}`, dealer_code: 'LIVE', sync_status: 'ROUTING_HOLD', MODIFIEDTIME: '2026-10-01 00:00:00:000' });
  }
  return createInMemoryZcql({
    leads,
    dealer_integrations: [{
      dealer_code: 'LIVE', integration_type: 'EXTERNAL_CRM', crm_type: 'DEALER_STUDIO', status: 'CONNECTED',
      push_enabled: pushEnabled, MODIFIEDTIME: '2026-11-01 00:00:00:000',
    }],
  });
}

test('held leads of dealers with no integration are not counted or read; the live dealer is served', async (t) => {
  const db = holdsDb();
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const { result, ds } = await reprocess(db);
  assert.equal(result.candidates, 2);
  assert.equal(result.delivered, 2);
  assert.deepEqual(send.mock.calls.map((call) => call.arguments[2].crm_record_id).sort(), ['L0', 'L1']);
  assert.ok(ds.fetchRows <= 6, `rows read: ${ds.fetchRows}`); // 1 integration, 1 group, 2 leads (+ margin)
});

test('a dealer with Push leads OFF is not re-sent; switching Push ON brings the held leads back next run', async (t) => {
  const db = holdsDb({ pushEnabled: false });
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const first = await reprocess(db);
  assert.equal(first.result.candidates, 0);
  assert.equal(send.mock.callCount(), 0);
  db.tables.dealer_integrations[0].push_enabled = true;
  const second = await reprocess(db);
  assert.equal(second.result.candidates, 2);
  assert.equal(send.mock.callCount(), 2);
});

test('a dealer whose Push switch was never touched (no value) is served as before', async (t) => {
  const db = holdsDb({ pushEnabled: undefined });
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const { result } = await reprocess(db);
  assert.equal(result.candidates, 2);
  assert.equal(send.mock.callCount(), 2);
});

test('with no servable dealer the held leads are not even counted', async (t) => {
  const db = holdsDb({ pushEnabled: false });
  t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const { result, ds } = await reprocess(db);
  assert.deepEqual(result, { candidates: 0, attempted: 0, delivered: 0, stillHeld: 0, errored: 0 });
  assert.ok(ds.fetchRows <= 2, `rows read: ${ds.fetchRows}`); // just the integration row
});

test('an unroutable integration (not configured) is left out like before', async (t) => {
  const db = holdsDb();
  db.tables.dealer_integrations[0].status = 'NOT_CONFIGURED';
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => ({ ok: true }));
  const { result } = await reprocess(db);
  assert.equal(result.candidates, 0);
  assert.equal(send.mock.callCount(), 0);
});
