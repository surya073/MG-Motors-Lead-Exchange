'use strict';

// Catalyst writes its own CREATEDTIME / MODIFIEDTIME in the project timezone
// (Asia/Kolkata, UTC+05:30) as "YYYY-MM-DD HH:MM:SS:mmm". The alert digest
// read them as UTC, so on a UTC runtime a queued failure looked 5.5 hours in
// the future and its 30-minute window really lasted about 6 hours (live,
// 14 Oct 2026: alerts queued at 10:05 IST were still waiting at 14:05 IST).

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const pathPolicy = require('../services/integrations/pathPolicyService');
const integrationAlertBatchService = require('../services/integrations/integrationAlertBatchService');
const integrationAlertService = require('../services/integrations/integrationAlertService');

// Catalyst's Node runtime is assumed to run in UTC; pin it so the test fails
// on the old parser whatever the developer machine's timezone is.
function onUtcRuntime(t) {
  const saved = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}

/** A Date as Catalyst would store it in CREATEDTIME (IST, with milliseconds). */
function catalystSystemTime(date) {
  const ist = new Date(date.getTime() + 330 * 60000).toISOString();
  return `${ist.slice(0, 10)} ${ist.slice(11, 19)}:${ist.slice(20, 23)}`;
}

test('parseSystemTimestamp reads Catalyst system columns as IST (UTC+05:30)', () => {
  assert.equal(
    pathPolicy.parseSystemTimestamp('2026-10-14 10:05:48:285').toISOString(),
    '2026-10-14T04:35:48.285Z'
  );
  assert.equal(pathPolicy.parseSystemTimestamp('2026-10-14 10:05:48').toISOString(), '2026-10-14T04:35:48.000Z');
  assert.equal(pathPolicy.parseSystemTimestamp(''), null);
  assert.equal(pathPolicy.parseSystemTimestamp(null), null);
  assert.equal(pathPolicy.parseSystemTimestamp('not a date'), null);
});

test('parseSystemTimestamp gives the same instant whatever the runtime timezone', () => {
  const script = path.join(__dirname, '..', 'services', 'integrations', 'pathPolicyService.js');
  const outputs = ['UTC', 'Asia/Kolkata', 'Australia/Sydney'].map((tz) =>
    execFileSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(script)}).parseSystemTimestamp('2026-10-14 10:05:48:285').toISOString())`], {
      env: { ...process.env, TZ: tz },
    }).toString().trim()
  );
  assert.deepEqual(outputs, Array(3).fill('2026-10-14T04:35:48.285Z'));
});

test('the timed alert digest waits for a failure queued 10 minutes ago', async (t) => {
  onUtcRuntime(t);
  const db = createInMemoryZcql({
    outbound_sync_claims: [],
    integration_alert_queue: [{
      CREATEDTIME: catalystSystemTime(new Date(Date.now() - 10 * 60000)),
      scenario_code: 'Unhappy 5', dealer_code: 'D1', lead_id: 'l1', reason: 'x', priority_for: 'P2',
    }],
  });
  const send = t.mock.method(integrationAlertService, 'sendConfiguredEmail', async () => ({ sent: true }));

  const result = await integrationAlertBatchService.flushIfWindowElapsed(db.app);

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'WINDOW_NOT_ELAPSED');
  assert.equal(send.mock.callCount(), 0);
});

test('the timed alert digest sends a failure queued 40 minutes ago (window 30), not 6 hours later', async (t) => {
  onUtcRuntime(t);
  const db = createInMemoryZcql({
    outbound_sync_claims: [],
    integration_alert_queue: [{
      CREATEDTIME: catalystSystemTime(new Date(Date.now() - 40 * 60000)),
      scenario_code: 'Unhappy 5', dealer_code: 'D1', lead_id: 'l1', reason: 'x', priority_for: 'P2',
    }],
  });
  const send = t.mock.method(integrationAlertService, 'sendConfiguredEmail', async () => ({ sent: true }));

  const result = await integrationAlertBatchService.flushIfWindowElapsed(db.app);

  assert.equal(result.sent, true);
  assert.equal(send.mock.callCount(), 1);
});
