'use strict';

process.env.INBOUND_REPLAY_IDLE_SKIP_MINUTES = '0';
for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

// With a small held queue the removed-dealer check looks only at the dealers of the held
// rows, not at every removed dealer. Results must match the full lookup.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crm = require('../services/integrations/crmIntegrationService');
const replay = require('../services/integrations/inboundReplayScheduler');
const usageContext = require('../services/usageContext');

const systemTime = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ') + ':000';
test.beforeEach(() => { _resetForTests(); replay._test.resetIdleMemo(); });

function build({ removedExtra = 40 } = {}) {
  const logs = [];
  const mappings = [];
  const add = (integrationId, prefix, n) => {
    for (let i = 0; i < n; i += 1) {
      logs.push({ integration_id: integrationId, external_lead_id: `${prefix}${i}`, happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED', error_message: 'ZOHO_ACK_UPDATE_FAILED', CREATEDTIME: systemTime(Date.now() - 20 * 60000), MODIFIEDTIME: systemTime(Date.now() - 20 * 60000) });
      mappings.push({ integration_id: integrationId, external_crm_lead_id: `${prefix}${i}`, last_error: null, MODIFIEDTIME: '2026-09-23 14:52:34:424' });
    }
  };
  add('1000', 'R', 5);
  add('1001', 'L', 2);
  const dealers = [{ dealer_code: 'AU008', sync_status: 'Removed' }, { dealer_code: 'AU100', sync_status: 'Active' }];
  for (let i = 0; i < removedExtra; i += 1) dealers.push({ dealer_code: `X${i}`, sync_status: 'Removed' });
  return createInMemoryZcql({
    integration_logs: logs,
    lead_integrations: mappings,
    dealer_integrations: [{ dealer_code: 'AU008', crm_type: 'ZOHO_CRM', status: 'CONNECTED' }, { dealer_code: 'AU100', crm_type: 'ZOHO_CRM', status: 'CONNECTED' }],
    dealers,
    integration_status_mappings: [],
  });
}
const sweep = (db) => usageContext.runWithContext({}, async (ctx) => ({ result: await replay.runInboundReplaySweep(usageContext.instrument(db.app)), ds: ctx.ds }));

test('small queue: removed dealer rows are left out and the removed-dealer list is not read', async (t) => {
  const db = build();
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const { result, ds } = await sweep(db);
  assert.equal(result.queued, 2);
  assert.ok(send.mock.calls.every((call) => String(call.arguments[2]).startsWith('L')));
  assert.ok(ds.fetchRows < 30, `rows read: ${ds.fetchRows}`); // 40+ with the full removed-dealer lookup
});

test('small queue: bringing the dealer back replays its rows next run', async (t) => {
  const db = build();
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  await sweep(db);
  db.tables.dealers.find((row) => row.dealer_code === 'AU008').sync_status = 'Active';
  const next = await sweep(db);
  assert.equal(next.result.queued, 5); // the live rows were closed by the first run
  assert.ok(send.mock.calls.some((call) => String(call.arguments[2]).startsWith('R')));
});
