'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = process.env[key] || 'test-fixture';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const crm = require('../services/integrations/crmIntegrationService');
const replay = require('../services/integrations/inboundReplayScheduler');
const retry = require('../services/integrations/outboundRetryScheduler');
const reconciliation = require('../services/integrations/dealerReconciliationService');
const systemTime = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ') + ':000';

test('ordinary replay backoff avoids all mapping/dealer reads and writes', async (t) => {
  _resetForTests();
  const db = createInMemoryZcql({ integration_logs: [{
    integration_id: '1000', external_lead_id: 'D1', happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
    error_message: 'MG_WRITE_BACK_FAILED:TRANSPORT', CREATEDTIME: systemTime(Date.now() - 120 * 60000),
    MODIFIEDTIME: systemTime(Date.now() - 60000),
  }], lead_integrations: [], dealer_integrations: [] });
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const before = JSON.parse(JSON.stringify(db.tables));
  const result = await replay.runInboundReplaySweep(db.app);
  assert.equal(result.backedOff, 1);
  assert.equal(send.mock.callCount(), 0);
  assert.deepEqual(db.tables, before);
  assert.equal(db.queries.length, 1, 'only the durable queue is sampled');
});

test('expiry bypasses ordinary replay backoff and closes a missing-link out-of-order hold', async (t) => {
  _resetForTests();
  const db = createInMemoryZcql({ integration_logs: [{
    integration_id: '1000', external_lead_id: 'D1', happy_unhappy_path_name: 'Unhappy 7', status: 'FAILED',
    error_message: 'LEAD_MAPPING_NOT_FOUND', CREATEDTIME: '2000-01-01 00:00:00:000', MODIFIEDTIME: systemTime(Date.now()),
  }], lead_integrations: [], dealer_integrations: [{ dealer_code: 'D1', crm_type: 'ZOHO_CRM' }] });
  const scenario = t.mock.method(crm, 'recordScenario', async () => {});
  const result = await replay.runInboundReplaySweep(db.app);
  assert.equal(result.expired, 1);
  assert.equal(db.tables.integration_logs[0].status, 'EXPIRED');
  assert.equal(scenario.mock.callCount(), 1);
});

test('a changed status map releases its hold even when the ordinary replay interval has not elapsed', async (t) => {
  _resetForTests();
  const db = createInMemoryZcql({ integration_logs: [{
    integration_id: '1000', external_lead_id: 'D1', happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED',
    error_message: 'STATUS_MAPPING_NOT_FOUND:Dealer status', CREATEDTIME: '2026-01-01 00:00:00:000', MODIFIEDTIME: systemTime(Date.now()),
  }], lead_integrations: [{ integration_id: '1000', external_crm_lead_id: 'D1', last_error: 'UNMAPPED_STATUS' }],
  dealer_integrations: [{ dealer_code: 'D1', crm_type: 'ZOHO_CRM' }], integration_status_mappings: [{ integration_id: '1000', MODIFIEDTIME: '2026-02-01 00:00:00:000' }] });
  const send = t.mock.method(crm, 'replayInboundLead', async () => ({ ok: true }));
  const result = await replay.runInboundReplaySweep(db.app);
  assert.equal(result.recovered, 1);
  assert.equal(send.mock.callCount(), 1);
});

test('an expired replay budget does not even close unreplayable audit rows', async () => {
  _resetForTests();
  const db = createInMemoryZcql({ integration_logs: [{ happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED' }] });
  const result = await replay.runInboundReplaySweep(db.app, { deadline: Date.now() - 1 });
  assert.equal(result.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(result.deferredUnknown, true);
  assert.equal(db.queries.length, 0);
  assert.equal(db.tables.integration_logs[0].status, 'FAILED');
});

test('routing holds stop at the shared deadline and leave unstarted records untouched', async (t) => {
  const db = createInMemoryZcql({ leads: ['Z1', 'Z2'].map((id) => ({
    crm_record_id: id, dealer_code: 'D1', sync_status: 'ROUTING_HOLD', MODIFIEDTIME: '2026-10-01 09:00:00:000',
  })) });
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(crm, 'getIntegrationByDealerCode', async () => ({
    ROWID: '1000', dealer_code: 'D1', integration_type: 'EXTERNAL_CRM', status: 'CONNECTED', MODIFIEDTIME: '2026-10-02 09:00:00:000',
  }));
  const send = t.mock.method(crm, 'syncLeadToExternalCrm', async () => { now = 2000; return { ok: true }; });
  const result = await retry._test.reprocessRoutingHolds(db.app, { deadline: 1500 });
  assert.equal(send.mock.callCount(), 1);
  assert.equal(result.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(result.deferredUnknown, true);
  assert.ok(db.tables.leads.every((lead) => lead.sync_status === 'ROUTING_HOLD'));
});

test('never-created reconciliation stops historical lookups after its shared deadline', async (t) => {
  _resetForTests();
  let now = Date.now();
  const deadline = now + 100;
  t.mock.method(Date, 'now', () => now);
  const db = createInMemoryZcql({ lead_integrations: [{
    zoho_lead_id: 'Z1', integration_id: '1000', external_crm_lead_id: 'D1',
  }], dealer_integrations: [], leads: [], integration_logs: ['Z1', 'Z2'].map((id) => ({
    zoho_lead_id: id, integration_id: '1000', direction: 'ZOHO_TO_EXTERNAL_CRM', operation: 'CREATE_LEAD',
    status: 'SUCCESS', happy_unhappy_path_name: 'Happy 1', CREATEDTIME: '2000-01-01 00:00:00:000',
  })) });
  const queries = [];
  const app = { ...db.app, zcql: () => ({ executeZCQLQuery: async (sql) => {
    queries.push(sql);
    if (/FROM lead_integrations.*ORDER BY/.test(sql)) return [];
    const rows = await db.app.zcql().executeZCQLQuery(sql);
    if (/FROM lead_integrations.*zoho_lead_id =/.test(sql)) now = deadline;
    return rows;
  } }) };
  const result = await reconciliation.runDealerReconciliation(app, { deadline });
  assert.equal(result.neverCreatedDeferredUnknown, true);
  assert.equal(queries.filter((sql) => /FROM lead_integrations.*zoho_lead_id =/.test(sql)).length, 1);
});
