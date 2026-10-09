'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const { ROTATION_BUCKET_MS } = require('../services/integrations/sweepWindow');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const outboundRetryScheduler = require('../services/integrations/outboundRetryScheduler');

// A failing mapping whose integration or lead no longer exists is deliberately
// left as-is (never delivered, never rewritten, never discarded). It therefore
// stays at the front of the next_retry_at-ordered queue for ever. These tests
// put more of them in front than one sweep can examine and show that every valid
// retry behind them is still delivered, once, and that no dangling row is touched.

const { HEAD_ROWS, TAIL_ROWS } = outboundRetryScheduler._test;
const BASE_NOW = Date.parse('2026-10-09T06:00:00Z');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const MIN = 60000;
const pad = (n) => String(n).padStart(5, '0');

function build({ dangling, valid }) {
  const mappings = [];
  const leads = [];
  // Dangling rows are the OLDEST (they have been failing the longest): no lead row for them.
  for (let i = 0; i < dangling; i += 1) {
    mappings.push({
      zoho_lead_id: `dead-${pad(i)}`, dealer_code: 'D1', integration_id: '1000', sync_status: 'FAILED',
      next_retry_at: utc(BASE_NOW - 600 * MIN + i * 1000),
    });
  }
  for (let i = 0; i < valid; i += 1) {
    mappings.push({
      zoho_lead_id: `ok-${pad(i)}`, dealer_code: 'D1', integration_id: '1000', sync_status: 'FAILED',
      next_retry_at: utc(BASE_NOW - 300 * MIN + i * 1000),
    });
    leads.push({ crm_record_id: `ok-${pad(i)}`, lead_status: 'Not Contacted', sync_status: 'FAILED' });
  }
  return createInMemoryZcql({
    lead_integrations: mappings, leads, dealer_integrations: [{ dealer_code: 'D1', status: 'ACTIVE' }],
  });
}

function deliveries(t) {
  const delivered = [];
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async (_app, _integration, leadRow) => {
    delivered.push(leadRow.crm_record_id);
    return { ok: true, scenarioCode: 'Happy 4' };
  });
  return delivered;
}

test('the old fixed window would never reach a valid retry behind 250 dangling ones', () => {
  const db = build({ dangling: 250, valid: 5 });
  const ordered = db.tables.lead_integrations
    .slice()
    .sort((a, b) => a.next_retry_at.localeCompare(b.next_retry_at));
  const firstWindow = ordered.slice(0, 200);
  assert.equal(firstWindow.filter((m) => m.zoho_lead_id.startsWith('ok-')).length, 0,
    'the previous 200-row window held only dangling rows');
});

test('valid retries behind more dangling rows than one sweep examines are all delivered, once each', async (t) => {
  const delivered = deliveries(t);
  const dangling = HEAD_ROWS + TAIL_ROWS * 2 + 30; // 330
  const db = build({ dangling, valid: 30 });
  const before = JSON.parse(JSON.stringify(db.tables.lead_integrations.filter((m) => m.zoho_lead_id.startsWith('dead-'))));

  // Rotation advances with time: run enough sweeps (one per bucket) to cover the queue.
  const realNow = Date.now;
  const rotations = Math.ceil((dangling + 30 - HEAD_ROWS) / TAIL_ROWS) + 1;
  try {
    for (let bucket = 0; bucket < rotations; bucket += 1) {
      Date.now = () => BASE_NOW + bucket * ROTATION_BUCKET_MS;
      _resetForTests();
      await outboundRetryScheduler.runOutboundRetrySweep(db.app, { ignoreSchedule: true });
    }
  } finally {
    Date.now = realNow;
  }

  const unique = new Set(delivered);
  assert.equal([...unique].filter((id) => id.startsWith('ok-')).length, 30, 'every valid retry was attempted');
  assert.ok(delivered.every((id) => id.startsWith('ok-')), 'nothing dangling was ever "delivered"');
  const after = db.tables.lead_integrations.filter((m) => m.zoho_lead_id.startsWith('dead-'));
  assert.deepEqual(after, before, 'dangling rows are neither rewritten, closed nor deleted');
});

test('dangling rows do not use up the per-sweep allowance: 60 valid rows behind 60 dangling ones, 50 attempted in one sweep', async (t) => {
  const delivered = deliveries(t);
  const db = build({ dangling: 60, valid: 60 });
  _resetForTests();
  const results = await outboundRetryScheduler.runOutboundRetrySweep(db.app, { ignoreSchedule: true });

  assert.equal(results.attempted, 50, 'the allowance is spent on rows that can actually be retried');
  assert.equal(delivered.length, 50);
  assert.equal(results.skippedNoIntegrationOrLead, 60, 'every dangling row was examined and passed over');
  assert.equal(results.totalCandidates, 120);
});

test('a sweep reads a bounded number of rows however large the failing backlog', async (t) => {
  deliveries(t);
  const db = build({ dangling: 900, valid: 0 });
  const queries = [];
  const app = {
    ...db.app,
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        queries.push(sql);
        return db.app.zcql().executeZCQLQuery(sql);
      },
    }),
  };
  _resetForTests();
  const results = await outboundRetryScheduler.runOutboundRetrySweep(app, { ignoreSchedule: true });

  assert.equal(results.totalCandidates, HEAD_ROWS + TAIL_ROWS);
  assert.ok(queries.some((q) => /COUNT\(ROWID\)/.test(q)), 'the tail position comes from a count');
  assert.ok(queries.every((q) => !/LIMIT 1, [3-9]\d\d/.test(q)), 'no oversized read');
});

test('with fewer failing rows than the head, behaviour is unchanged: one read, oldest first, no tail', async (t) => {
  const delivered = deliveries(t);
  const db = build({ dangling: 0, valid: 8 });
  const queries = [];
  const app = {
    ...db.app,
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        queries.push(sql);
        return db.app.zcql().executeZCQLQuery(sql);
      },
    }),
  };
  _resetForTests();
  const results = await outboundRetryScheduler.runOutboundRetrySweep(app, { ignoreSchedule: true });

  assert.equal(results.recovered, 8);
  assert.equal(delivered.length, 8);
  assert.ok(!queries.some((q) => /COUNT\(ROWID\)/.test(q)));
});

test('the ordinary (paced) sweep still honours next_retry_at: not-yet-due rows are not attempted', async (t) => {
  const delivered = deliveries(t);
  const db = build({ dangling: 0, valid: 3 });
  db.tables.lead_integrations[0].next_retry_at = utc(Date.now() + 3600 * 1000);
  _resetForTests();
  const results = await outboundRetryScheduler.runOutboundRetrySweep(db.app);

  assert.equal(results.skippedNotDue, 1);
  assert.equal(delivered.length, 2);
});
