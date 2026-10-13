'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 9a (FUSION_REMEDIATION_PLAN.md), audit S11: the incremental sync
// resumes from the start of the latest Incremental run that finished with no
// failed record, but only looked at the latest 20 runs and otherwise fell
// back to 24 hours ago. After more than 20 failed runs (a long outage) the
// good checkpoint was out of sight, and OEM changes older than 24 h were
// never re-read. With DURABLE_SYNC_CHECKPOINT on, the latest good run is
// found however long ago it was.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _test: { getIncrementalWatermark } } = require('../services/leadSyncService');

function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => { if (v === null) delete process.env[k]; else process.env[k] = v; });
  t.after(() => Object.entries(before).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }));
}

const NOW = new Date('2026-10-13T12:00:00Z');
const run = (createdTime, startTime, status, recordsFailed, extra = {}) => ({
  sync_type: 'Lead_Sync', sync_trigger: 'Incremental', status, records_failed: recordsFailed,
  start_time: startTime, CREATEDTIME: createdTime, ...extra,
});

// A good run three days ago, then 30 runs that each had a failed record.
function outage() {
  const logs = [run('2026-10-10 12:00:00:000', '2026-10-10 06:30:00', 'Success', 0)];
  for (let i = 0; i < 30; i += 1) {
    const minute = String(i).padStart(2, '0');
    logs.push(run(`2026-10-13 10:${minute}:00:000`, `2026-10-13 05:${minute}:00`, 'Partial', 1));
  }
  return createInMemoryZcql({ sync_logs: logs });
}

test('flag off: after more than 20 failed runs the checkpoint falls back to 24 h ago, as before', async (t) => {
  withEnv(t, { DURABLE_SYNC_CHECKPOINT: null, LEAD_SYNC_SINCE: null });
  const watermark = await getIncrementalWatermark(outage().app, NOW);
  assert.equal(watermark.toISOString(), '2026-10-12T12:00:00.000Z');
});

test('flag on: the last good run is found however many failed runs came after it', async (t) => {
  withEnv(t, { DURABLE_SYNC_CHECKPOINT: 'true', LEAD_SYNC_SINCE: null });
  const watermark = await getIncrementalWatermark(outage().app, NOW);
  // its start (06:30 UTC on 10 Oct) minus the 2-minute overlap
  assert.equal(watermark.toISOString(), '2026-10-10T06:28:00.000Z');
});

test('flag on: only a Lead_Sync Incremental run, Success or Partial, with no failed record counts', async (t) => {
  withEnv(t, { DURABLE_SYNC_CHECKPOINT: 'true', LEAD_SYNC_SINCE: null });
  const db = createInMemoryZcql({
    sync_logs: [
      run('2026-10-11 12:00:00:000', '2026-10-11 06:00:00', 'Success', 0),
      run('2026-10-12 12:00:00:000', '2026-10-12 06:00:00', 'Failed', 0),
      run('2026-10-12 12:01:00:000', '2026-10-12 06:01:00', 'Success', 0, { sync_type: 'Dealer_Sync' }),
      run('2026-10-12 12:02:00:000', '2026-10-12 06:02:00', 'Success', 0, { sync_trigger: 'Manual' }),
      run('2026-10-12 12:03:00:000', '2026-10-12 06:03:00', 'Partial', 2),
    ],
  });
  const watermark = await getIncrementalWatermark(db.app, NOW);
  assert.equal(watermark.toISOString(), '2026-10-11T05:58:00.000Z');
});

test('flag on: an older run with no records_failed value counts as clean, as it always has', async (t) => {
  withEnv(t, { DURABLE_SYNC_CHECKPOINT: 'true', LEAD_SYNC_SINCE: null });
  const db = createInMemoryZcql({ sync_logs: [run('2026-10-11 12:00:00:000', '2026-10-11 06:00:00', 'Success', null)] });
  const watermark = await getIncrementalWatermark(db.app, NOW);
  assert.equal(watermark.toISOString(), '2026-10-11T05:58:00.000Z');
});

test('flag on, no good run at all: 24 h ago, never before LEAD_SYNC_SINCE, as before', async (t) => {
  withEnv(t, { DURABLE_SYNC_CHECKPOINT: 'true', LEAD_SYNC_SINCE: '2026-10-12T18:00:00Z' });
  const db = createInMemoryZcql({ sync_logs: [] });
  const watermark = await getIncrementalWatermark(db.app, NOW);
  assert.equal(watermark.toISOString(), '2026-10-12T18:00:00.000Z');
});

test('with fewer than 20 runs, the flag finds the same checkpoint as before', async (t) => {
  const db = createInMemoryZcql({
    sync_logs: [
      run('2026-10-13 09:00:00:000', '2026-10-13 03:30:00', 'Success', 0),
      run('2026-10-13 10:00:00:000', '2026-10-13 04:30:00', 'Partial', 1),
    ],
  });
  withEnv(t, { DURABLE_SYNC_CHECKPOINT: null, LEAD_SYNC_SINCE: null });
  const off = await getIncrementalWatermark(db.app, NOW);
  process.env.DURABLE_SYNC_CHECKPOINT = 'true';
  const on = await getIncrementalWatermark(db.app, NOW);
  assert.equal(on.toISOString(), off.toISOString());
});
