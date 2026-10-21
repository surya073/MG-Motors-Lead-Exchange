'use strict';
for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) process.env[key] = 'test-fixture';
process.env.ZOHO_API_DOMAIN = 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = 'https://accounts.zoho.in';
process.env.CRON_SECRET = 'test-cron-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const crm = require('../services/integrations/crmIntegrationService');
const retry = require('../services/integrations/outboundRetryScheduler');
const replay = require('../services/integrations/inboundReplayScheduler');
const sla = require('../services/integrations/slaMonitorService');
const alert = require('../services/integrations/integrationAlertBatchService');
const mail = require('../services/integrations/integrationAlertService');
const guard = require('../services/integrations/sweepOverlapGuard');
const active = (db, name) => db.tables[name].filter((row) => !row.__deleted);

test('fast recovery progresses through retry tail windows when only its first stage has budget', async (t) => {
  const catalyst = require('zcatalyst-sdk-node');
  const db = createInMemoryZcql({
    lead_integrations: Array.from({ length: 500 }, (_, i) => ({ integration_id: '1000', zoho_lead_id: `Z${i}`, dealer_code: 'D1', sync_status: 'FAILED', next_retry_at: '2000-01-01 00:00:00' })),
    leads: Array.from({ length: 300 }, (_, i) => ({ crm_record_id: `Z${i + 200}`, dealer_code: 'D1', lead_status: 'Not Contacted' })),
    dealer_integrations: [{ dealer_code: 'D1', crm_type: 'ZOHO_CRM', status: 'CONNECTED', integration_type: 'EXTERNAL_CRM' }],
  });
  t.mock.method(catalyst, 'initialize', () => db.app);
  const delivered = new Set();
  t.mock.method(crm, 'syncLeadToExternalCrm', async (_app, _integration, lead) => {
    delivered.add(lead.crm_record_id);
    db.tables.lead_integrations.find((row) => row.zoho_lead_id === lead.crm_record_id).sync_status = 'SYNCED';
    return { ok: true };
  });
  const base = Date.parse('2026-10-14T06:00:00Z');
  let now = base;
  t.mock.method(Date, 'now', () => now);
  const expensive = async (_app, { deadline } = {}) => {
    if (now >= deadline) return { skipped: true };
    now += 26000;
    return {};
  };
  t.mock.method(replay, 'runInboundReplaySweep', expensive);
  t.mock.method(sla, 'runSlaSweep', (app, _date, options) => expensive(app, options));
  t.mock.method(alert, 'flushIfWindowElapsed', expensive);
  const router = require('../routes/cronRoutes');
  const route = router.stack.find((layer) => layer.route?.path === '/cron/fast-recover').route;
  const handler = route.stack.at(-1).handle;
  for (let bucket = 0; bucket < 16; bucket += 1) {
    guard._resetForTests();
    now = base + bucket * 120000;
    let body;
    await handler({ headers: { 'x-cron-secret': 'test-cron-secret' } }, { status() { return this; }, json(value) { body = value; } });
    assert.equal(body.success, true);
  }
  assert.ok(delivered.size >= 100, 'valid work behind the 200 dangling mappings progresses');
  const offsets = new Set(db.queries.filter((sql) => /FROM lead_integrations .*LIMIT \d+, 100$/.test(sql)).map((sql) => /LIMIT (\d+),/.exec(sql)[1]));
  assert.ok(offsets.size >= 3, 'productive runs must not keep selecting the same tail');
});

function mappingBacklog() {
  const logs = [], mappings = [];
  for (let d = 0; d < 4; d += 1) for (let i = 0; i < 30; i += 1) {
    const external = `D${d}-${i}`;
    logs.push({ integration_id: String(1000 + d), external_lead_id: external, happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED', error_message: 'STATUS_MAPPING_NOT_FOUND:Still unmapped', CREATEDTIME: '2000-01-01 00:00:00:000', MODIFIEDTIME: '' });
    mappings.push({ integration_id: String(1000 + d), external_crm_lead_id: external, last_error: 'UNMAPPED_STATUS:Still unmapped', MODIFIEDTIME: '' });
  }
  logs.push({ integration_id: '1004', external_lead_id: 'valid-new', happy_unhappy_path_name: 'Unhappy 4', status: 'FAILED', error_message: 'MG_WRITE_BACK_FAILED', CREATEDTIME: '2001-01-01 00:00:00:000', MODIFIEDTIME: '' });
  mappings.push({ integration_id: '1004', external_crm_lead_id: 'valid-new' });
  return createInMemoryZcql({ integration_logs: logs, lead_integrations: mappings,
    dealer_integrations: Array.from({ length: 5 }, (_, i) => ({ dealer_code: `D${i}`, crm_type: 'ZOHO_CRM' })),
    integration_status_mappings: Array.from({ length: 4 }, (_, i) => ({ integration_id: String(1000 + i), MODIFIEDTIME: '2002-01-01 00:00:00:000' })) });
}

test('one irrelevant mapping edit is attempted once per hold, allowing valid newer work through; a later edit releases holds', async (t) => {
  const db = mappingBacklog();
  const attempts = [];
  t.mock.method(crm, 'replayInboundLead', async (_app, _integration, external) => {
    attempts.push(external);
    return external === 'valid-new' ? { ok: true } : { held: true, reason: 'STATUS_MAPPING_NOT_FOUND' };
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T06:30:00Z') });
  for (let n = 0; n < 8; n += 1) {
    guard._resetForTests();
    await replay.runInboundReplaySweep(db.app, { windowSequence: n });
    t.mock.timers.tick(120000);
  }
  assert.ok(attempts.includes('valid-new'));
  assert.equal(new Set(attempts).size, attempts.length, 'unchanged mapping generations do not churn');
  assert.equal(db.tables.integration_logs.at(-1).status, 'RECOVERED');
  db.tables.integration_status_mappings[0].MODIFIEDTIME = '2026-10-14 15:00:00:000';
  const before = attempts.filter((id) => id === 'D0-0').length;
  await replay.runInboundReplaySweep(db.app);
  assert.equal(attempts.filter((id) => id === 'D0-0').length, before + 1);
});

test('transport failure after a mapping edit remains retryable with backoff', async (t) => {
  const db = mappingBacklog();
  db.tables.integration_logs.splice(1);
  let attempts = 0;
  t.mock.method(crm, 'replayInboundLead', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary transport failure');
    return { ok: true };
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T06:30:00Z') });
  const raw = db.app.datastore;
  db.app.datastore = () => ({ table: (name) => {
    const table = raw().table(name);
    return { ...table, updateRow: (row) => table.updateRow({ ...row,
      MODIFIEDTIME: new Date(Date.now() + 330 * 60000).toISOString().slice(0, 23).replace('T', ' ').replace('.', ':'),
    }) };
  } });
  await replay.runInboundReplaySweep(db.app);
  await replay.runInboundReplaySweep(db.app);
  assert.equal(attempts, 1);
  t.mock.timers.tick(61 * 60000);
  await replay.runInboundReplaySweep(db.app);
  assert.equal(attempts, 2);
  assert.equal(db.tables.integration_logs[0].status, 'RECOVERED');
});

test('an undeletable accepted alert is quarantined while new unsent batches continue', async (t) => {
  const db = createInMemoryZcql({ integration_alert_queue: [{ CREATEDTIME: '2000-01-01 00:00:00:000', scenario_code: 'Unhappy 1', lead_id: 'old-accepted', reason: 'fixture' }], outbound_sync_claims: [] }, { enforceUnique: true });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true, messageId: 'test-message' }));
  const raw = db.app.datastore;
  let failedDeletes = 0;
  db.app.datastore = () => ({ table: (name) => {
    const table = raw().table(name);
    return { ...table, deleteRow: async (id) => {
      if (name === 'integration_alert_queue' && String(id) === '1000') { failedDeletes += 1; throw new Error('persistent delete failure'); }
      return table.deleteRow(id);
    } };
  } });
  await alert.flushIfWindowElapsed(db.app);
  for (let i = 0; i < 100; i += 1) await raw().table('integration_alert_queue').insertRow({ CREATEDTIME: '2001-01-01 00:00:00:000', scenario_code: 'Unhappy 1', lead_id: `new-${i}`, reason: 'fixture' });
  const result = await alert.flushIfWindowElapsed(db.app);
  assert.equal(result.sent, true);
  assert.equal(result.count, 100);
  assert.equal(result.cleanupPending, true);
  await alert.flushIfWindowElapsed(db.app);
  assert.equal(sent.mock.callCount(), 2, 'one accepted old batch and exactly one new batch');
  assert.equal(failedDeletes, 1, 'cleanup is backed off without blocking new sends');
  assert.equal(active(db, 'integration_alert_queue').length, 1);
  const receipts = active(db, 'outbound_sync_claims');
  assert.equal(receipts.length, 1);
  assert.deepEqual(JSON.parse(receipts[0].request_reference).receipt.rowIds, ['1000']);
});

test('dispatch inventories sent receipts beyond one page before selecting an unsent alert', async (t) => {
  const prefix = 'operation:integration-alert-dispatch:receipt:';
  const db = createInMemoryZcql({
    integration_alert_queue: Array.from({ length: 302 }, (_, i) => ({ CREATEDTIME: '2000-01-01 00:00:00:000', scenario_code: 'Unhappy 1', lead_id: `Z${i}`, reason: 'fixture' })),
    outbound_sync_claims: Array.from({ length: 301 }, (_, i) => ({
      claim_key: `${prefix}${i}`, claimed_at: '2000-01-01 00:00:00',
      request_reference: JSON.stringify({ version: 1, owner: 'previous', phase: 'SENT', receipt: { rowIds: [String(1000 + i)] } }),
    })),
  }, { enforceUnique: true });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await alert.flushIfWindowElapsed(db.app);
  assert.equal(result.sent, true);
  assert.equal(result.count, 1, 'only the row absent from all 301 receipts can be sent');
  assert.equal(sent.mock.callCount(), 1);
  assert.ok(db.queries.some((sql) => sql.includes("claim_key LIKE 'operation:integration-alert-dispatch:receipt:") && sql.endsWith('LIMIT 301, 300')));
  assert.equal(active(db, 'integration_alert_queue').length, 300, 'already accepted rows are preserved until cleanup');
});

test('receipt inventory failure never permits sending an unverified partial snapshot', async (t) => {
  const db = createInMemoryZcql({
    integration_alert_queue: [{ CREATEDTIME: '2000-01-01 00:00:00:000', scenario_code: 'Unhappy 1' }],
    outbound_sync_claims: [],
  }, { enforceUnique: true });
  const zcql = db.app.zcql;
  db.app.zcql = () => ({ executeZCQLQuery: async (sql) => {
    if (sql.includes("claim_key LIKE 'operation:integration-alert-dispatch:receipt:")) throw new Error('receipt inventory unavailable');
    return zcql().executeZCQLQuery(sql);
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  await assert.rejects(alert.flushIfWindowElapsed(db.app), /receipt inventory unavailable/);
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(active(db, 'integration_alert_queue').length, 1);
});

test('slow cleanup of a full sent receipt reserves budget for new unsent mail', async (t) => {
  const now = Date.parse('2026-10-14T06:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const sentIds = Array.from({ length: 100 }, (_, i) => String(1000 + i));
  const db = createInMemoryZcql({
    integration_alert_queue: Array.from({ length: 101 }, (_, i) => ({ CREATEDTIME: '2000-01-01 00:00:00:000', scenario_code: 'Unhappy 1', lead_id: `Z${i}`, reason: 'fixture' })),
    outbound_sync_claims: [{
      claim_key: 'operation:integration-alert-dispatch:receipt:old', claimed_at: '2000-01-01 00:00:00',
      request_reference: JSON.stringify({ version: 1, owner: 'previous', phase: 'SENT', receipt: { rowIds: sentIds } }),
    }],
  }, { enforceUnique: true });
  const raw = db.app.datastore;
  let deletes = 0;
  db.app.datastore = () => ({ table: (name) => {
    const table = raw().table(name);
    return { ...table, deleteRow: async (id) => {
      if (name === 'integration_alert_queue' && sentIds.includes(String(id))) {
        deletes += 1;
        t.mock.timers.tick(500);
        throw new Error('slow persistent delete failure');
      }
      return table.deleteRow(id);
    } };
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await alert.flushIfWindowElapsed(db.app, { deadline: now + 20000 });
  assert.equal(result.sent, true, 'cleanup cannot spend all twenty seconds before selecting unsent mail');
  assert.equal(result.count, 1);
  assert.equal(result.cleanupPending, true);
  assert.equal(sent.mock.callCount(), 1);
  assert.ok(deletes <= 5, 'cleanup starts at most one bounded slow batch');
  assert.ok(Date.now() - now <= 2500);
  assert.deepEqual(JSON.parse(active(db, 'outbound_sync_claims')[0].request_reference).receipt.rowIds.sort(), sentIds.sort());
});

for (const reason of ['LEAD_REMOVED', 'DEALER_ROUTING_INVALID']) {
  test(`terminal ${reason} replay closes its audit group once without future dealer reads`, async (t) => {
    const db = mappingBacklog();
    db.tables.integration_logs.splice(2);
    db.tables.integration_logs[1].external_lead_id = db.tables.integration_logs[0].external_lead_id;
    const beforeLeads = JSON.stringify(db.tables.lead_integrations);
    const reads = t.mock.method(crm, 'replayInboundLead', async () => ({ skipped: true, held: true, terminal: true, reason }));
    const alerts = t.mock.method(crm, 'recordScenario', async () => { throw new Error('terminal replay must not alert again'); });
    const first = await replay.runInboundReplaySweep(db.app);
    assert.equal(first.terminal, 1);
    assert.equal(first.expired, 1);
    assert.equal(first.terminalClosedRows, 2);
    assert.equal(first.recovered, 0);
    assert.ok(db.tables.integration_logs.every((row) => row.status === 'EXPIRED'));
    const second = await replay.runInboundReplaySweep(db.app);
    assert.equal(second.queued, 0);
    assert.equal(second.attempted, 0);
    assert.equal(reads.mock.callCount(), 1);
    assert.equal(alerts.mock.callCount(), 0);
    assert.equal(JSON.stringify(db.tables.lead_integrations), beforeLeads, 'terminal queue cleanup does not change lead ownership or badges');
  });
}
