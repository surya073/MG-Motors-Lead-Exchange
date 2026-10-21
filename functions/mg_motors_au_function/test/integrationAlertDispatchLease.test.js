'use strict';

process.env.ALERT_BATCH_SIZE = '100';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const mail = require('../services/integrations/integrationAlertService');
const operationClaims = require('../services/integrations/integrationOperationClaimService');

function dispatcher() {
  // Independent module instances have independent warm guards but share the
  // datastore. These tests exercise the durable lease, not only an in-memory lock.
  const filename = path.resolve(__dirname, '../services/integrations/integrationAlertBatchService.js');
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(fs.readFileSync(filename, 'utf8'), filename);
  return mod.exports;
}

function fixture(count = 1) {
  return createInMemoryZcql({
    integration_alert_queue: Array.from({ length: count }, (_, i) => ({
      CREATEDTIME: '2000-01-01 00:00:00:000', scenario_code: 'Unhappy 1', lead_id: `Z${i}`, reason: 'fixture failure',
    })),
    outbound_sync_claims: [],
  }, { enforceUnique: true });
}

const active = (db, table) => db.tables[table].filter((row) => !row.__deleted);
const systemTime = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 19).replace('T', ' ') + ':000';

test('independent dispatchers near the threshold send one digest and dequeue each row once', async (t) => {
  const db = fixture(99);
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { sent: true, messageId: 'fixture-message' };
  });
  let deletes = 0;
  const datastore = db.app.datastore;
  db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    return { ...table, deleteRow: async (id) => { if (name === 'integration_alert_queue') deletes += 1; return table.deleteRow(id); } };
  } });
  const instances = [dispatcher(), dispatcher(), dispatcher()];
  await Promise.all(instances.map((service, i) => service.enqueueFailure(db.app, { scenarioCode: 'Unhappy 1', leadId: `new-${i}` })));
  assert.equal(sent.mock.callCount(), 1);
  assert.equal(deletes, 100);
  assert.equal(active(db, 'integration_alert_queue').length, 2);
  assert.equal(active(db, 'outbound_sync_claims').length, 0);
});

test('empty and not-yet-due queues incur no lease or receipt writes', async (t) => {
  const db = fixture(0);
  let writes = 0;
  const datastore = db.app.datastore;
  db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    return { ...table, insertRow: async (row) => { writes += 1; return table.insertRow(row); }, deleteRow: async (id) => { writes += 1; return table.deleteRow(id); } };
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  assert.equal((await dispatcher().flushIfWindowElapsed(db.app)).reason, 'EMPTY');
  db.tables.integration_alert_queue.push({ CREATEDTIME: systemTime(Date.now() - 1000) });
  const recent = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(recent.reason, 'WINDOW_NOT_ELAPSED');
  assert.equal(recent.pendingCountUnknown, true);
  assert.equal(writes, 0);
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(db.queries.length, 2);
  assert.ok(db.queries.every((sql) => /SELECT ROWID, CREATEDTIME .* LIMIT 1$/.test(sql)));
});

test('a missing claims table fails closed and preserves the pending alert', async (t) => {
  const db = fixture();
  const zcql = db.app.zcql;
  const datastore = db.app.datastore;
  db.app.zcql = () => ({ executeZCQLQuery: async (sql) => {
    if (sql.includes('FROM outbound_sync_claims')) throw new Error('claims table missing');
    return zcql().executeZCQLQuery(sql);
  } });
  db.app.datastore = () => ({ table: (name) => name === 'outbound_sync_claims'
    ? { insertRow: async () => { throw new Error('claims table missing'); } }
    : datastore().table(name) });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(result.reason, 'OPERATION_CLAIM_UNAVAILABLE');
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(active(db, 'integration_alert_queue').length, 1);
});

test('a stale dispatch lease recovers without removing unrelated outbound claims', async (t) => {
  const db = fixture();
  db.tables.outbound_sync_claims.push(
    { claim_key: operationClaims._test.keyFor('integration-alert-dispatch'), claimed_at: '2000-01-01 00:00:00', request_reference: JSON.stringify({ version: 1, owner: 'crashed', phase: 'RUNNING' }) },
    { claim_key: '1000:Z-outbound', claimed_at: '2000-01-01 00:00:00', request_reference: 'outbound request' }
  );
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(result.sent, true);
  assert.equal(sent.mock.callCount(), 1);
  assert.deepEqual(active(db, 'outbound_sync_claims').map((row) => row.claim_key), ['1000:Z-outbound']);
});

test('partial dequeue failure leaves a durable receipt and the next dispatcher cleans without resending', async (t) => {
  const db = fixture(2);
  const datastore = db.app.datastore;
  let failedOnce = false;
  db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    return { ...table, deleteRow: async (id) => {
      if (name === 'integration_alert_queue' && String(id) === '1000' && !failedOnce) {
        failedOnce = true;
        throw new Error('temporary dequeue failure');
      }
      return table.deleteRow(id);
    } };
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true, messageId: 'accepted-1' }));
  const first = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(first.sent, true);
  assert.equal(first.deleteFailed, 1);
  assert.equal(first.cleanupPending, true);
  const receipt = active(db, 'outbound_sync_claims')[0];
  assert.ok(receipt.claim_key.includes(':receipt:'));
  assert.deepEqual(JSON.parse(receipt.request_reference).receipt.rowIds, ['1000']);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 3 * 60000 });
  const second = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(second.reason, 'PREVIOUS_BATCH_CLEANED');
  assert.equal(second.cleanupPending, false);
  assert.equal(sent.mock.callCount(), 1);
  assert.equal(active(db, 'integration_alert_queue').length, 0);
  assert.equal(active(db, 'outbound_sync_claims').length, 0);
});

test('a sent receipt survives stale lease replacement and is recovered without an email', async (t) => {
  const db = fixture();
  const key = operationClaims._test.keyFor('integration-alert-dispatch');
  db.tables.outbound_sync_claims.push(
    { claim_key: key, claimed_at: '2000-01-01 00:00:00', request_reference: JSON.stringify({ version: 1, owner: 'crashed', phase: 'RUNNING' }) },
    { claim_key: `${key}:receipt:stored`, claimed_at: '2000-01-01 00:00:00', request_reference: JSON.stringify({ version: 1, owner: 'crashed', phase: 'SENT', receipt: { rowIds: ['1000'], messageId: 'accepted' } }) }
  );
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(result.reason, 'PREVIOUS_BATCH_CLEANED');
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(active(db, 'integration_alert_queue').length, 0);
  assert.equal(active(db, 'outbound_sync_claims').length, 0);
});

test('mail failure retains the queue and releases the dispatch lease for retry', async (t) => {
  const db = fixture();
  t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: false, reason: 'SMTP_FAILED' }));
  const result = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'SMTP_FAILED');
  assert.equal(active(db, 'integration_alert_queue').length, 1);
  assert.equal(active(db, 'outbound_sync_claims').length, 0);
});

test('accepted mail with a failed receipt write is reported as uncertain and temporarily blocks another send', async (t) => {
  const db = fixture();
  const datastore = db.app.datastore;
  db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    return { ...table, insertRow: async (row) => {
      if (name === 'outbound_sync_claims' && row.claim_key.includes(':receipt:')) throw new Error('receipt storage unavailable');
      return table.insertRow(row);
    } };
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(result.sent, true);
  assert.equal(result.deliveryUncertain, true);
  assert.equal(result.reason, 'SENT_RECEIPT_NOT_STORED');
  assert.equal(active(db, 'integration_alert_queue').length, 1);
  assert.equal((await dispatcher().flushIfWindowElapsed(db.app)).reason, 'OPERATION_ALREADY_RUNNING');
  assert.equal(sent.mock.callCount(), 1);
});

test('the batch is re-read after the lease is acquired, so an already dispatched snapshot cannot be sent again', async (t) => {
  const db = fixture();
  const datastore = db.app.datastore;
  let replaced = false;
  db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    return { ...table, insertRow: async (row) => {
      if (name === 'outbound_sync_claims' && !replaced) {
        replaced = true;
        db.tables.integration_alert_queue[0] = { __deleted: true };
        db.tables.integration_alert_queue.push({ CREATEDTIME: systemTime(Date.now() - 1000) });
      }
      return table.insertRow(row);
    } };
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(result.reason, 'WINDOW_NOT_ELAPSED');
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(active(db, 'integration_alert_queue').length, 1);
});

test('rows inserted during email transmission stay queued for the next batch', async (t) => {
  const db = fixture();
  t.mock.method(mail, 'sendConfiguredEmail', async () => {
    await db.app.datastore().table('integration_alert_queue').insertRow({ CREATEDTIME: systemTime(Date.now()), lead_id: 'arrived-later' });
    return { sent: true };
  });
  await dispatcher().flushIfWindowElapsed(db.app);
  assert.deepEqual(active(db, 'integration_alert_queue').map((row) => row.lead_id), ['arrived-later']);
});

test('the dispatch budget prevents a send when slow snapshot loading also outlives the lease', async (t) => {
  const db = fixture();
  const base = Date.now();
  let now = base;
  t.mock.method(Date, 'now', () => now);
  const zcql = db.app.zcql;
  db.app.zcql = () => ({ executeZCQLQuery: async (sql) => {
    const rows = await zcql().executeZCQLQuery(sql);
    if (sql.startsWith('SELECT * FROM integration_alert_queue')) now = base + operationClaims._test.LEASE_MS + 1000;
    return rows;
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(result.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(active(db, 'integration_alert_queue').length, 1);
});

test('cleanup proves already deleted queue rows absent when DELETE returns an error', async (t) => {
  const db = fixture(2);
  db.tables.integration_alert_queue[0] = { __deleted: true };
  const key = operationClaims._test.keyFor('integration-alert-dispatch');
  db.tables.outbound_sync_claims.push({
    claim_key: `${key}:receipt:old`, claimed_at: '2000-01-01 00:00:00',
    request_reference: JSON.stringify({ version: 1, owner: 'previous', phase: 'SENT', receipt: { rowIds: ['1000'] } }),
  });
  const datastore = db.app.datastore;
  db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    return { ...table, deleteRow: async (id) => {
      if (name === 'integration_alert_queue' && String(id) === '1000') throw new Error('row not found');
      return table.deleteRow(id);
    } };
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app);
  assert.equal(result.sent, true, 'new unsent rows make progress after old receipt cleanup');
  assert.equal(result.cleanupPending, false);
  assert.equal(sent.mock.callCount(), 1);
  assert.equal(active(db, 'outbound_sync_claims').length, 0);
  assert.equal(active(db, 'integration_alert_queue').length, 0);
});

test('sent evidence remains durable if stale lease replacement fails after removing its old row', async (t) => {
  const db = fixture();
  const key = operationClaims._test.keyFor('integration-alert-dispatch');
  db.tables.outbound_sync_claims.push(
    { claim_key: key, claimed_at: '2000-01-01 00:00:00', request_reference: JSON.stringify({ version: 1, owner: 'crashed', phase: 'RUNNING' }) },
    { claim_key: `${key}:receipt:old`, claimed_at: '2000-01-01 00:00:00', request_reference: JSON.stringify({ version: 1, owner: 'crashed', phase: 'SENT', receipt: { rowIds: ['1000'] } }) }
  );
  const datastore = db.app.datastore;
  let calls = 0;
  db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    return { ...table, insertRow: async (row) => {
      if (name === 'outbound_sync_claims' && row.claim_key === key && ++calls === 2) throw new Error('replacement unavailable');
      return table.insertRow(row);
    } };
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  assert.equal((await dispatcher().flushIfWindowElapsed(db.app)).reason, 'OPERATION_CLAIM_UNAVAILABLE');
  assert.equal(active(db, 'outbound_sync_claims').filter((row) => row.claim_key.includes(':receipt:')).length, 1);
  assert.equal((await dispatcher().flushIfWindowElapsed(db.app)).reason, 'PREVIOUS_BATCH_CLEANED');
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(active(db, 'integration_alert_queue').length, 0);
});

test('an expired alert budget performs no probe, lease write or email', async (t) => {
  const db = fixture();
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app, { deadline: 0 });
  assert.equal(result.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(db.queries.length, 0);
  assert.equal(active(db, 'outbound_sync_claims').length, 0);
  assert.equal(sent.mock.callCount(), 0);
});

test('a budget expiring while loading the batch starts no email and preserves the queue', async (t) => {
  const db = fixture();
  const base = Date.now();
  let now = base;
  t.mock.method(Date, 'now', () => now);
  const zcql = db.app.zcql;
  db.app.zcql = () => ({ executeZCQLQuery: async (sql) => {
    const rows = await zcql().executeZCQLQuery(sql);
    if (sql.startsWith('SELECT * FROM integration_alert_queue')) now = base + 1000;
    return rows;
  } });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  const result = await dispatcher().flushIfWindowElapsed(db.app, { deadline: base + 500 });
  assert.equal(result.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(active(db, 'integration_alert_queue').length, 1);
});

test('acceptance at the end of a budget still stores its receipt and defers cleanup without resending', async (t) => {
  const db = fixture();
  const base = Date.now();
  let now = base;
  t.mock.method(Date, 'now', () => now);
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => { now = base + 1000; return { sent: true }; });
  const result = await dispatcher().flushIfWindowElapsed(db.app, { deadline: base + 500 });
  assert.equal(result.sent, true);
  assert.equal(result.cleanupPending, true);
  assert.equal(result.reason, 'WORK_BUDGET_EXHAUSTED');
  assert.equal(active(db, 'outbound_sync_claims').filter((row) => row.claim_key.includes(':receipt:')).length, 1);
  assert.equal((await dispatcher().flushIfWindowElapsed(db.app)).reason, 'PREVIOUS_BATCH_CLEANED');
  assert.equal(sent.mock.callCount(), 1);
});

test('a configured threshold above 300 flushes a bounded batch when 301 or 302 alerts are queued', async (t) => {
  const before = process.env.ALERT_BATCH_SIZE;
  process.env.ALERT_BATCH_SIZE = '301';
  t.after(() => { if (before === undefined) delete process.env.ALERT_BATCH_SIZE; else process.env.ALERT_BATCH_SIZE = before; });
  const sent = t.mock.method(mail, 'sendConfiguredEmail', async () => ({ sent: true }));
  for (const queued of [301, 302]) {
    const db = fixture(queued - 1);
    const service = dispatcher();
    assert.equal(service.BATCH_SIZE, 300);
    const result = await service.enqueueFailure(db.app, { scenarioCode: 'Unhappy 1', leadId: 'threshold-event' });
    assert.equal(result.flush.sent, true);
    assert.equal(result.flush.count, 300);
    assert.equal(active(db, 'integration_alert_queue').length, queued - 300);
    assert.equal(active(db, 'outbound_sync_claims').length, 0);
  }
  assert.equal(sent.mock.callCount(), 2);
});
