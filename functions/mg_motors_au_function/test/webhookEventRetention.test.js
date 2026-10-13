'use strict';

// Batch 6 (FUSION_REMEDIATION_PLAN.md), audit S9: webhook_events grows with
// every delivery. SUCCESS rows older than WEBHOOK_EVENT_RETENTION_DAYS are
// deleted, at most 300 per run. Q23: nothing is deleted until the variable is
// set. Rows in any other state are kept: they may still be replayed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { getWebhookEventRetentionDays } = require('../config/env');
const retention = require('../services/integrations/webhookEventRetention');

function withEnv(t, value) {
  const before = process.env.WEBHOOK_EVENT_RETENTION_DAYS;
  if (value === null) delete process.env.WEBHOOK_EVENT_RETENTION_DAYS;
  else process.env.WEBHOOK_EVENT_RETENTION_DAYS = value;
  t.after(() => {
    if (before === undefined) delete process.env.WEBHOOK_EVENT_RETENTION_DAYS;
    else process.env.WEBHOOK_EVENT_RETENTION_DAYS = before;
  });
}

// 13 Oct 2026 12:00 UTC = 17:30 in the project timezone (Asia/Kolkata).
const NOW = Date.parse('2026-10-13T12:00:00Z');

test('retention days: unset, blank, zero, negative or not a number means off', (t) => {
  for (const value of [null, '', '0', '-5', 'thirty', '2.5']) {
    withEnv(t, value);
    assert.equal(getWebhookEventRetentionDays(), null, String(value));
  }
  process.env.WEBHOOK_EVENT_RETENTION_DAYS = ' 30 ';
  assert.equal(getWebhookEventRetentionDays(), 30);
});

test('off (Q23): nothing is read or deleted', async (t) => {
  withEnv(t, null);
  const db = createInMemoryZcql({ webhook_events: [{ processing_status: 'SUCCESS', CREATEDTIME: '2020-01-01 00:00:00:000' }] });
  const result = await retention.purgeOldWebhookEvents(db.app, { now: NOW });
  assert.deepEqual(result, { skipped: true, reason: 'RETENTION_OFF' });
  assert.equal(db.queries.length, 0);
  assert.equal(db.tables.webhook_events[0].__deleted, undefined);
});

test('only SUCCESS rows older than the cutoff (project time) are deleted', async (t) => {
  withEnv(t, '30');
  const db = createInMemoryZcql({
    webhook_events: [
      { processing_status: 'SUCCESS', CREATEDTIME: '2026-09-13 17:29:00:000' }, // 30 days + 1 min old
      { processing_status: 'SUCCESS', CREATEDTIME: '2026-09-13 17:31:00:000' }, // 1 min short of 30 days
      { processing_status: 'FAILED', CREATEDTIME: '2026-08-01 00:00:00:000' },
      { processing_status: 'PENDING', CREATEDTIME: '2026-08-01 00:00:00:000' },
      { processing_status: 'SUCCESS', CREATEDTIME: '2026-10-13 10:00:00:000' },
    ],
  });
  const result = await retention.purgeOldWebhookEvents(db.app, { now: NOW });
  assert.equal(result.deleted, 1);
  assert.equal(result.cutoff, '2026-09-13 17:30:00');
  assert.equal(result.more, false);
  assert.deepEqual(db.tables.webhook_events.map((row) => Boolean(row.__deleted)), [true, false, false, false, false]);
});

test('at most 300 rows per run; "more" says another run is needed', async (t) => {
  withEnv(t, '1');
  const rows = Array.from({ length: 305 }, () => ({ processing_status: 'SUCCESS', CREATEDTIME: '2026-01-01 00:00:00:000' }));
  const db = createInMemoryZcql({ webhook_events: rows });
  const first = await retention.purgeOldWebhookEvents(db.app, { now: NOW });
  assert.equal(first.deleted, 300);
  assert.equal(first.more, true);
  const second = await retention.purgeOldWebhookEvents(db.app, { now: NOW });
  assert.equal(second.deleted, 5);
  assert.equal(second.more, false);
});

test('a row that fails to delete is counted and does not stop the rest', async (t) => {
  withEnv(t, '1');
  const db = createInMemoryZcql({
    webhook_events: [
      { processing_status: 'SUCCESS', CREATEDTIME: '2026-01-01 00:00:00:000' },
      { processing_status: 'SUCCESS', CREATEDTIME: '2026-01-01 00:00:00:000' },
    ],
  });
  const original = db.app.datastore;
  db.app.datastore = () => ({
    table: (name) => {
      const real = original().table(name);
      return { ...real, deleteRow: async (id) => { if (id === '1000') throw new Error('busy'); return real.deleteRow(id); } };
    },
  });
  const result = await retention.purgeOldWebhookEvents(db.app, { now: NOW });
  assert.equal(result.deleted, 1);
  assert.equal(result.failed, 1);
});

test('fast-recover runs it once a day, in a two-minute window at 16:00 UTC', () => {
  assert.equal(retention.isRetentionDue(new Date('2026-10-13T16:00:30Z')), true);
  assert.equal(retention.isRetentionDue(new Date('2026-10-13T16:01:59Z')), true);
  assert.equal(retention.isRetentionDue(new Date('2026-10-13T16:02:00Z')), false);
  assert.equal(retention.isRetentionDue(new Date('2026-10-13T15:59:59Z')), false);
  assert.equal(retention.isRetentionDue(new Date('2026-10-13T04:00:00Z')), false);
});

// Wiring: fast-recover (the only scheduled cron) runs the purge in its daily
// window; daily-error-report runs it whenever it is called. A purge failure
// never fails either route.
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');
const cronRoutes = require('../routes/cronRoutes');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');
const inboundReplayScheduler = require('../services/integrations/inboundReplayScheduler');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const dealerReconciliationService = require('../services/integrations/dealerReconciliationService');
const integrationAlertBatchService = require('../services/integrations/integrationAlertBatchService');
const dailyErrorReportService = require('../services/integrations/dailyErrorReportService');

async function callCron(t, path, { due = false, purge = async () => ({ deleted: 2 }) } = {}) {
  process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret';
  t.mock.method(outboundRetryScheduler, 'runOutboundRetrySweep', async () => ({ recovered: 0 }));
  t.mock.method(inboundReplayScheduler, 'runInboundReplaySweep', async () => ({}));
  t.mock.method(slaMonitorService, 'runSlaSweep', async () => ({}));
  t.mock.method(dealerReconciliationService, 'runDealerReconciliation', async () => ({}));
  t.mock.method(integrationAlertBatchService, 'flushIfWindowElapsed', async () => ({}));
  t.mock.method(dailyErrorReportService, 'sendDailyErrorReport', async () => ({ sent: false }));
  t.mock.method(catalyst, 'initialize', () => ({}));
  t.mock.method(retention, 'isRetentionDue', () => due);
  const purgeMock = t.mock.method(retention, 'purgeOldWebhookEvents', purge);

  const server = express();
  server.use(express.json());
  server.use(cronRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': process.env.CRON_SECRET },
    body: '{}',
  });
  return { status: response.status, body: await response.json(), purgeCalls: purgeMock.mock.callCount() };
}

test('fast-recover purges only in its daily window', async (t) => {
  const outside = await callCron(t, '/cron/fast-recover', { due: false });
  assert.equal(outside.status, 200);
  assert.equal(outside.purgeCalls, 0);
  assert.equal(outside.body.results.webhookEventRetention, undefined);
});

test('fast-recover in its daily window purges and reports it', async (t) => {
  const inside = await callCron(t, '/cron/fast-recover', { due: true });
  assert.equal(inside.purgeCalls, 1);
  assert.deepEqual(inside.body.results.webhookEventRetention, { deleted: 2 });
});

test('a purge failure does not fail fast-recover or the daily report', async (t) => {
  const boom = async () => { throw new Error('datastore busy'); };
  const fast = await callCron(t, '/cron/fast-recover', { due: true, purge: boom });
  assert.equal(fast.status, 200);
  assert.deepEqual(fast.body.results.webhookEventRetention, { error: 'datastore busy' });
});

test('daily-error-report also runs the purge', async (t) => {
  const daily = await callCron(t, '/cron/daily-error-report');
  assert.equal(daily.status, 200);
  assert.equal(daily.purgeCalls, 1);
  assert.deepEqual(daily.body.webhookEventRetention, { deleted: 2 });
});
