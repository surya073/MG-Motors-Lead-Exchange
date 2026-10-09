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
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const slaMonitorService = require('../services/integrations/slaMonitorService');

// Catalyst documents a 30-second limit for Advanced I/O functions, and a breach
// costs far more than a read (OEM write, two row writes, the Unhappy 10 record
// and its notifications). The sweep must therefore bound its own run time and
// parallelism, hand unfinished work to the next sweep untouched, and keep the
// dealer-acknowledgement timestamp that Unhappy 10 quotes as evidence.
// Time is simulated: every OEM write "costs" COST_MS on a fake clock.

const BASE_NOW = Date.parse('2026-10-09T06:00:00Z');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const DAY = 24 * 3600 * 1000;
const COST_MS = 1000;

function buildDb(count, { sameLeadTwice = false } = {}) {
  const mappings = [];
  const leads = [];
  for (let i = 0; i < count; i += 1) {
    const id = `lead-${String(i).padStart(4, '0')}`;
    mappings.push({
      zoho_lead_id: id, dealer_code: i % 2 ? 'D1' : 'D2', integration_id: '1000', sync_status: 'SYNCED',
      // distinct, increasing acknowledgement times: lead-0000 is the oldest
      last_synced_at: utc(BASE_NOW - 5 * DAY + i * 60 * 1000),
    });
    leads.push({ crm_record_id: id, lead_status: 'Not Contacted', sync_status: 'SYNCED' });
  }
  if (sameLeadTwice) {
    mappings.push({ ...mappings[0], integration_id: '1000', dealer_code: 'D3', last_synced_at: utc(BASE_NOW - 4 * DAY) });
  }
  return createInMemoryZcql({ lead_integrations: mappings, leads, dealer_integrations: [{ dealer_code: 'D1', status: 'ACTIVE' }] });
}

function harness(t) {
  const clock = { now: 0 };
  const flight = { current: 0, peak: 0 };
  const inFlightLeads = new Set();
  const overlapSameLead = [];
  const written = [];
  const scenarios = [];
  t.mock.method(oemCrmService, 'updateOemLead', async (id) => {
    if (inFlightLeads.has(id)) overlapSameLead.push(id);
    inFlightLeads.add(id);
    flight.current += 1;
    flight.peak = Math.max(flight.peak, flight.current);
    await new Promise((resolve) => setImmediate(resolve));
    clock.now += COST_MS; // the simulated cost of one OEM write
    written.push(id);
    flight.current -= 1;
    inFlightLeads.delete(id);
    return { status: 'success' };
  });
  t.mock.method(crmIntegrationService, 'recordScenario', async (_app, args) => { scenarios.push(args); });
  return { clock, flight, overlapSameLead, written, scenarios };
}

async function sweep(db, h, options = {}) {
  _resetForTests();
  return slaMonitorService.runSlaSweep(db.app, new Date(BASE_NOW), { clock: () => h.clock.now, ...options });
}

const breached = (db) => db.tables.lead_integrations.filter((m) => m.sync_status === 'SLA_BREACH');

test('a sweep stops starting work when its time budget is spent, and says how much it deferred', async (t) => {
  const h = harness(t);
  const db = buildDb(400);

  const result = await sweep(db, h);

  assert.ok(result.deferred > 0, 'unfinished overdue rows are reported');
  assert.ok(result.breached > 0 && result.breached < 400);
  const budget = slaMonitorService._test.SLA_TIME_BUDGET_MS;
  const batch = slaMonitorService._test.SLA_CONCURRENCY;
  assert.ok(
    result.elapsedMs <= budget + batch * COST_MS,
    `finished within the budget plus at most one batch (${result.elapsedMs} ms)`
  );
  assert.ok(result.elapsedMs < 30000, 'inside Catalyst\'s documented 30-second limit');
  assert.equal(result.breached + result.deferred, result.candidates, 'every candidate was either handled or deferred');
});

test('deferred rows are not lost: successive sweeps breach every overdue lead exactly once, oldest first', async (t) => {
  const h = harness(t);
  const db = buildDb(400);

  const order = [];
  let sweeps = 0;
  for (; sweeps < 40 && breached(db).length < 400; sweeps += 1) {
    h.clock.now = 0;
    await sweep(db, h);
  }

  assert.equal(breached(db).length, 400, 'all 400 overdue mappings were breached');
  assert.ok(sweeps > 1, 'it took several sweeps, each within budget');
  assert.equal(h.written.length, 400);
  assert.equal(new Set(h.written).size, 400, 'no lead was written to the OEM CRM twice');
  assert.equal(h.scenarios.length, 400);
  assert.ok(h.scenarios.every((s) => s.scenarioCode === 'Unhappy 10'));

  // Oldest acknowledgement first (within a batch of 3 the order may interleave).
  h.written.forEach((id, i) => order.push([Number(id.slice(5)), i]));
  const inversions = order.filter(([n, i]) => n > i + slaMonitorService._test.SLA_CONCURRENCY * 2 + 3).length;
  assert.equal(inversions, 0, 'processing follows oldest-first order');
});

test('a deadline passed in by the caller is honoured: an expired one starts nothing', async (t) => {
  const h = harness(t);
  const db = buildDb(10);

  const result = await sweep(db, h, { deadline: -1 });

  assert.equal(result.deferred, 10);
  assert.equal(result.breached, 0);
  assert.equal(h.written.length, 0, 'no OEM write, no row write');
  assert.equal(breached(db).length, 0);

  const shortBudget = await sweep(db, h, { deadline: undefined, timeBudgetMs: 2000 });
  assert.ok(shortBudget.breached > 0 && shortBudget.deferred > 0, 'a caller-chosen budget limits the run');
});

test('parallelism is bounded, and two mappings of one lead are never processed at the same moment', async (t) => {
  const h = harness(t);
  const db = buildDb(60, { sameLeadTwice: true });

  await sweep(db, h, { timeBudgetMs: 10 * 60 * 1000 });

  assert.ok(h.flight.peak <= slaMonitorService._test.SLA_CONCURRENCY, `peak in flight ${h.flight.peak}`);
  assert.ok(slaMonitorService._test.SLA_CONCURRENCY <= 6, 'the configured ceiling can never exceed 6');
  assert.ok(h.flight.peak >= 2, 'it does run in parallel');
  assert.deepEqual(h.overlapSameLead, [], 'no lead had two writes in flight together');
});

test('audit timestamps are preserved: the acknowledgement time and SLA age quoted in the breach record are the real ones', async (t) => {
  const h = harness(t);
  const db = buildDb(5);
  const before = db.tables.lead_integrations.map((m) => m.last_synced_at);

  await sweep(db, h);

  assert.deepEqual(db.tables.lead_integrations.map((m) => m.last_synced_at), before,
    'a breached mapping keeps its dealer-acknowledgement time');
  const second = h.scenarios.find((s) => s.leadRow.crm_record_id === 'lead-0001');
  const ackIso = new Date(`${before[1].replace(' ', 'T')}Z`).toISOString();
  assert.ok(second.reason.includes(`Acknowledged by dealer ${ackIso}`), second.reason);
  const expectedAge = Math.round((BASE_NOW - Date.parse(`${before[1].replace(' ', 'T')}Z`)) / 60000);
  assert.ok(second.reason.includes(`SLA age ${expectedAge} min`), second.reason);
  assert.equal(second.dealerCode, 'D1');
  assert.ok(db.tables.lead_integrations.every((m) => m.last_error === 'DEALER_ACTION_SLA_BREACH' && m.last_attempted_at));
});

test('an empty overdue set finishes immediately with nothing deferred', async (t) => {
  const h = harness(t);
  const db = buildDb(0);
  const result = await sweep(db, h);
  assert.equal(result.candidates, 0);
  assert.equal(result.deferred, 0);
  assert.equal(result.elapsedMs, 0);
});
