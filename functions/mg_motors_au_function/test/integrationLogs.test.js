'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const dashboard = require('../services/adminDashboardService');
const stats = require('../services/dashboardStatsService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const dailyErrorReport = require('../services/integrations/dailyErrorReportService');
const aiTools = require('../services/aiAssistantToolService');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const adminDashboardRoutes = require('../routes/adminDashboardRoutes');

// The integration-log report used to load only the newest 5,000 rows and filter
// them in JavaScript, so any historical or busy-dealer report quietly described
// a sample. These tests use datasets far beyond that bound and check that every
// filter, count and page is exact, that old records are reachable, and that
// day boundaries are millisecond-exact. The in-memory engine follows Catalyst's
// real rules (1-based LIMIT offset, 300-row cap, millisecond CREATEDTIME).

const pad = (n, w = 2) => String(n).padStart(w, '0');

// A deterministic spread of events over `days` days from 2026-09-01.
function buildLogs(count, days = 40) {
  const scenarios = ['Happy 1', 'Happy 2', 'Unhappy 1', 'Unhappy 2', 'Unhappy 10'];
  const dealers = ['D1', 'D2', 'D3'];
  return Array.from({ length: count }, (_, i) => {
    const day = Math.floor((i * days) / count); // 0..days-1, oldest first
    const date = new Date(Date.UTC(2026, 8, 1 + day));
    const secs = (i * 37) % 86400;
    return {
      CREATEDTIME: `${date.toISOString().slice(0, 10)} ${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}:${pad(i % 1000, 3)}`,
      dealer_code: dealers[i % dealers.length],
      happy_unhappy_path_name: scenarios[i % scenarios.length],
      happy_unhappy_path_message: 'message',
      status: scenarios[i % scenarios.length].startsWith('Unhappy') ? 'FAILED' : 'SUCCESS',
      direction: i % 4 === 0 ? 'EXTERNAL_CRM_TO_ZOHO' : 'ZOHO_TO_EXTERNAL_CRM',
      operation: 'CREATE_LEAD',
      zoho_lead_id: `lead-${i % 500}`,
      error_message: '',
    };
  });
}

function dbWith(logs, extra = {}) {
  return createInMemoryZcql({
    integration_logs: logs,
    dealers: [
      { dealer_code: 'D1', dealer_name: 'Alpha MG' },
      { dealer_code: 'D2', dealer_name: 'Beta MG' },
      { dealer_code: 'D3', dealer_name: 'Gamma MG' },
    ],
    leads: Array.from({ length: 500 }, (_, i) => ({ crm_record_id: `lead-${i}`, customer_name: `Customer ${i}` })),
    ...extra,
  });
}

// Newest first; CREATEDTIME ties broken by ROWID, exactly as the query orders them.
function reference(logs, f = {}) {
  return logs
    .map((l, idx) => ({ ...l, ROWID: String(1000 + idx) }))
    .filter((l) => {
      const day = l.CREATEDTIME.slice(0, 10);
      return (!f.fromDate || day >= f.fromDate) && (!f.toDate || day <= f.toDate)
        && (!f.dealerCode || l.dealer_code === f.dealerCode)
        && (!f.scenarioCode || l.happy_unhappy_path_name === f.scenarioCode)
        && (!f.status || l.status === f.status)
        && (!f.integration || l.direction === f.integration);
    })
    .sort((a, b) => b.CREATEDTIME.localeCompare(a.CREATEDTIME) || Number(b.ROWID) - Number(a.ROWID));
}

async function walkAll(db, filters, pageSize = 200) {
  const ids = [];
  let last;
  for (let page = 1; page < 1000; page += 1) {
    last = await dashboard.getIntegrationLogs(db.app, { ...filters, page, pageSize });
    ids.push(...last.logs.map((l) => l.ROWID));
    if (!last.hasMore) break;
  }
  return { ids, last };
}

// --- history beyond the old 5,000-row window -----------------------------------------

const BIG = buildLogs(12000);

test('the total is the complete count (12,000), not the 5,000 newest', async () => {
  const db = dbWith(BIG);
  const result = await dashboard.getIntegrationLogs(db.app, { page: 1, pageSize: 25 });

  assert.equal(result.total, 12000);
  assert.equal(result.totalPages, 480);
  assert.equal(result.logs.length, 25);
  assert.equal(result.hasMore, true);
  assert.equal(result.truncated, false);
});

test('the response distinguishes a page from the complete count', async () => {
  const db = dbWith(BIG);
  const result = await dashboard.getIntegrationLogs(db.app, { page: 3, pageSize: 50 });

  assert.equal(result.scope, 'page');
  assert.equal(result.totalIsComplete, true);
  assert.equal(result.logs.length, 50, '`logs` is only this page');
  assert.equal(result.total, 12000, '`total` counts every matching event');
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 50);
});

test('records older than the newest 5,000 are reachable, page by page', async () => {
  const db = dbWith(BIG);
  const ref = reference(BIG);

  // Row 11,226–11,250 sits far beyond anything the old code could load.
  const deep = await dashboard.getIntegrationLogs(db.app, { page: 450, pageSize: 25 });
  assert.deepEqual(deep.logs.map((l) => l.ROWID), ref.slice(11225, 11250).map((l) => l.ROWID));
  assert.equal(deep.logs[0].date.slice(0, 7), '2026-09', 'these are the oldest, September, events');

  const oldest = await dashboard.getIntegrationLogs(db.app, { fromDate: '2026-09-01', toDate: '2026-09-01', pageSize: 200 });
  assert.equal(oldest.total, reference(BIG, { fromDate: '2026-09-01', toDate: '2026-09-01' }).length);
  assert.ok(oldest.total > 0);
});

test('walking every page returns each of the 12,000 events exactly once, newest first', async () => {
  const db = dbWith(BIG);
  const { ids, last } = await walkAll(db, {});
  assert.equal(ids.length, 12000);
  assert.equal(new Set(ids).size, 12000);
  assert.deepEqual(ids, reference(BIG).map((l) => l.ROWID));
  assert.equal(last.hasMore, false);
});

test('a report never reads more rows than one page plus a count', async () => {
  const db = dbWith(BIG);
  await dashboard.getIntegrationLogs(db.app, { dealerCode: 'D2', status: 'FAILED', page: 7, pageSize: 25 });

  const logQueries = db.queries.filter((q) => q.includes('FROM integration_logs'));
  assert.equal(logQueries.length, 2, 'one COUNT and one page');
  assert.ok(logQueries.some((q) => /^SELECT COUNT\(ROWID\)/.test(q)));
  const pageQuery = logQueries.find((q) => q.startsWith('SELECT *'));
  assert.match(pageQuery, /LIMIT \d+, 25$/);
  assert.ok(pageQuery.includes("dealer_code = 'D2'") && pageQuery.includes("status = 'FAILED'"), 'filters are in the WHERE clause');
  assert.match(pageQuery, /ORDER BY CREATEDTIME DESC, ROWID DESC/);
});

// --- filters and accurate counts -----------------------------------------------------------

test('every filter, alone and combined, gives the exact count and the exact rows', async () => {
  const db = dbWith(BIG);
  for (const filters of [
    {},
    { dealerCode: 'D1' },
    { status: 'FAILED' },
    { status: 'SUCCESS' },
    { scenarioCode: 'Unhappy 10' },
    { integration: 'EXTERNAL_CRM_TO_ZOHO' },
    { integration: 'ZOHO_TO_EXTERNAL_CRM', status: 'FAILED' },
    { fromDate: '2026-10-01' },
    { toDate: '2026-09-05' },
    { fromDate: '2026-09-10', toDate: '2026-09-20' },
    { fromDate: '2026-09-10', toDate: '2026-09-20', dealerCode: 'D3', status: 'FAILED', scenarioCode: 'Unhappy 2' },
    { dealerCode: 'NOBODY' },
    { fromDate: '2030-01-01' },
  ]) {
    const expected = reference(BIG, filters);
    const first = await dashboard.getIntegrationLogs(db.app, { ...filters, page: 1, pageSize: 25 });
    assert.equal(first.total, expected.length, `count for ${JSON.stringify(filters)}`);
    assert.deepEqual(first.logs.map((l) => l.ROWID), expected.slice(0, 25).map((l) => l.ROWID), JSON.stringify(filters));
    assert.equal(first.totalPages, Math.max(1, Math.ceil(expected.length / 25)));
    assert.equal(first.hasMore, expected.length > 25);
  }
});

test('filters that match nothing return an empty page with a zero total', async () => {
  const db = dbWith(BIG);
  const result = await dashboard.getIntegrationLogs(db.app, { dealerCode: 'NOBODY' });
  assert.deepEqual(result.logs, []);
  assert.equal(result.total, 0);
  assert.equal(result.totalPages, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.totalIsComplete, true);
});

// --- date boundaries ---------------------------------------------------------------------------

const boundary = (created, tag) => ({
  CREATEDTIME: created, dealer_code: 'D1', happy_unhappy_path_name: 'Happy 1', status: 'SUCCESS',
  direction: 'ZOHO_TO_EXTERNAL_CRM', zoho_lead_id: tag, happy_unhappy_path_message: '', error_message: '',
});

test('day boundaries are exact to the millisecond', async () => {
  const logs = [
    boundary('2026-10-04 23:59:59:999', 'before-start'),   // out
    boundary('2026-10-05 00:00:00:000', 'first-ms'),        // in
    boundary('2026-10-05 12:00:00:000', 'midday'),          // in
    boundary('2026-10-05 23:59:59:000', 'last-second'),     // in
    boundary('2026-10-05 23:59:59:999', 'last-ms'),         // in — a ≤ 'date 23:59:59' filter would drop this
    boundary('2026-10-06 00:00:00:000', 'after-end'),       // out
  ];
  const db = dbWith(logs);

  const day = await dashboard.getIntegrationLogs(db.app, { fromDate: '2026-10-05', toDate: '2026-10-05', pageSize: 50 });
  assert.equal(day.total, 4);
  assert.deepEqual(day.logs.map((l) => l.leadId).sort(), ['first-ms', 'last-ms', 'last-second', 'midday']);

  assert.equal((await dashboard.getIntegrationLogs(db.app, { fromDate: '2026-10-06' })).total, 1, 'from-only starts at midnight');
  assert.equal((await dashboard.getIntegrationLogs(db.app, { toDate: '2026-10-04' })).total, 1, 'to-only ends at the last ms of that day');
  assert.equal((await dashboard.getIntegrationLogs(db.app, { fromDate: '2026-10-06', toDate: '2026-10-05' })).total, 0, 'an inverted range is empty');
  assert.equal((await dashboard.getIntegrationLogs(db.app, { fromDate: '2026-10-04', toDate: '2026-10-06' })).total, 6);
});

test('month and year rollovers in the end-of-range day are handled', async () => {
  const logs = [
    boundary('2026-12-31 23:59:59:999', 'new-years-eve'),
    boundary('2027-01-01 00:00:00:000', 'new-year'),
    boundary('2028-02-29 23:59:59:999', 'leap-day'),
  ];
  const db = dbWith(logs);
  assert.equal((await dashboard.getIntegrationLogs(db.app, { toDate: '2026-12-31' })).total, 1);
  assert.equal((await dashboard.getIntegrationLogs(db.app, { fromDate: '2027-01-01', toDate: '2028-02-29' })).total, 2);
});

test('a malformed date is ignored, never injected into the query', async () => {
  const db = dbWith(buildLogs(50, 5));
  const result = await dashboard.getIntegrationLogs(db.app, { fromDate: "2026-09-01'; DROP TABLE integration_logs; --", dealerCode: "D1' OR '1'='1" });
  assert.equal(result.total, 0, 'the quoted dealer filter matches no dealer');
  assert.ok(db.queries.every((q) => !q.includes('DROP TABLE')));
});

// --- paging inputs -------------------------------------------------------------------------------

test('page size is capped at 200 and junk paging inputs fall back to safe defaults', async () => {
  const db = dbWith(BIG);
  assert.equal((await dashboard.getIntegrationLogs(db.app, { pageSize: 5000 })).pageSize, 200);
  const junk = await dashboard.getIntegrationLogs(db.app, { page: 'abc', pageSize: '-3' });
  assert.equal(junk.page, 1);
  assert.equal(junk.pageSize, 25);
  const past = await dashboard.getIntegrationLogs(db.app, { page: 9999, pageSize: 25 });
  assert.deepEqual(past.logs, []);
  assert.equal(past.total, 12000, 'a page past the end still reports the true total');
  assert.equal(past.hasMore, false);
});

test('rows keep the fields the Integration Errors table renders', async () => {
  const db = dbWith(buildLogs(30, 3));
  const { logs } = await dashboard.getIntegrationLogs(db.app, { pageSize: 5 });
  const row = logs[0];
  for (const key of ['ROWID', 'date', 'dealerCode', 'dealerName', 'leadId', 'customerName', 'integration', 'operation', 'scenarioCode', 'scenarioMessage', 'priority', 'errorMessage', 'status']) {
    assert.ok(key in row, key);
  }
  assert.match(row.dealerName, /MG$/);
  assert.match(row.customerName, /^Customer \d+$/);
});

// --- who can read it ---------------------------------------------------------------------------------

async function get(t, roleId, url) {
  const db = dbWith(buildLogs(120, 10));
  const server = express();
  server.use((req, res, next) => {
    res.locals.catalystApp = db.app;
    if (roleId !== null) res.locals.currentUser = { email_id: 't@example.com', role_details: { role_id: roleId } };
    next();
  });
  server.use(adminDashboardRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${url}`);
  return { status: response.status, body: await response.json() };
}

test('GET /admin/integration-logs keeps its role checks and returns the paged, filtered report', async (t) => {
  assert.equal((await get(t, '11111111111111111', '/admin/integration-logs')).status, 403);
  assert.equal((await get(t, null, '/admin/integration-logs')).status, 401);

  const { status, body } = await get(t, ADMIN_ROLE_ID, '/admin/integration-logs?dealerCode=D1&status=FAILED&integration=ZOHO_TO_EXTERNAL_CRM&page=1&pageSize=10');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.scope, 'page');
  assert.equal(body.totalIsComplete, true);
  assert.ok(body.logs.every((l) => l.dealerCode === 'D1' && l.status === 'FAILED' && l.integration === 'ZOHO_TO_EXTERNAL_CRM'));
  assert.equal(body.total, reference(buildLogs(120, 10), { dealerCode: 'D1', status: 'FAILED', integration: 'ZOHO_TO_EXTERNAL_CRM' }).length);
});

test('the assistant\'s integration-log tool gets the same complete, filtered result', async () => {
  const db = dbWith(BIG);
  const viaTool = await aiTools.getIntegrationLogs(db.app, { dealerCode: 'D3', status: 'FAILED', fromDate: '2026-09-10', toDate: '2026-09-20' });
  assert.equal(viaTool.total, reference(BIG, { dealerCode: 'D3', status: 'FAILED', fromDate: '2026-09-10', toDate: '2026-09-20' }).length);
  assert.equal(viaTool.totalIsComplete, true);
});

// --- the daily error report ---------------------------------------------------------------------------

function recentLogs(count, { hoursAgoStart = 23, unhappy = true } = {}) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const at = new Date(now - (hoursAgoStart * 3600 - (i * (hoursAgoStart * 3600 - 60)) / count) * 1000);
    return {
      CREATEDTIME: `${stats.toProjectDateTime(at)}:${pad(i % 1000, 3)}`,
      dealer_code: `D${(i % 3) + 1}`,
      happy_unhappy_path_name: unhappy ? 'Unhappy 2' : 'Happy 1',
      happy_unhappy_path_message: 'm',
      happy_unhappy_path_priority: 'P2',
      status: unhappy ? 'FAILED' : 'SUCCESS',
      zoho_lead_id: `lead-${i % 500}`,
      error_message: 'bad data',
    };
  });
}

test('the daily error report reads every event in its 24h window, not just the newest 2,000', async () => {
  const inWindow = recentLogs(3000);
  const tooOld = recentLogs(50, { hoursAgoStart: 30 }).map((l) => ({ ...l, CREATEDTIME: l.CREATEDTIME.replace(/^\d{4}-\d{2}-\d{2}/, '2026-01-01') }));
  const db = dbWith([...tooOld, ...inWindow]);

  const report = await dailyErrorReport.buildDailyErrorReport(db.app);

  assert.equal(report.totalEvents, 3000, 'all 3,000 events in the window are counted');
  assert.equal(report.truncated, false);
  assert.equal(report.eventsRead, 3000);
  assert.ok(db.queries.filter((q) => q.includes('FROM integration_logs')).every((q) => q.includes('CREATEDTIME >=')), 'the window is applied in the database');
});

test('the read of a window is bounded and says so when the bound is hit', async () => {
  const db = dbWith(recentLogs(250));
  const since = new Date(Date.now() - 24 * 3600 * 1000);

  const bounded = await stats.integrationLogsSince(db.app, since, 100);
  assert.equal(bounded.rows.length, 100);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.total, 250);

  const whole = await stats.integrationLogsSince(db.app, since, 1000);
  assert.equal(whole.rows.length, 250);
  assert.equal(whole.truncated, false);
});

test('a partial daily report states that it is partial, in both the text and HTML versions', async () => {
  const db = dbWith(recentLogs(20));
  const report = await dailyErrorReport.buildDailyErrorReport(db.app);

  const partial = { ...report, truncated: true, eventsInWindow: 25000, eventsRead: 20000 };
  assert.match(dailyErrorReport.renderText(partial), /PARTIAL REPORT.*25000.*20000/);
  assert.match(dailyErrorReport.renderHtml(partial), /Partial report/);

  assert.doesNotMatch(dailyErrorReport.renderText(report), /PARTIAL/);
  assert.doesNotMatch(dailyErrorReport.renderHtml(report), /Partial report/);
});

// --- one lead's timeline -------------------------------------------------------------------------------

test('a lead\'s activity timeline is complete, oldest first, however many events it has', async () => {
  const noisy = Array.from({ length: 756 }, (_, i) => ({
    CREATEDTIME: `2026-10-0${1 + (i % 9)} ${pad(i % 24)}:${pad(i % 60)}:00:${pad(i % 1000, 3)}`,
    zoho_lead_id: 'noisy-lead', dealer_code: 'D1', happy_unhappy_path_name: 'Unhappy 1', status: 'FAILED',
  }));
  const other = Array.from({ length: 40 }, (_, i) => ({ CREATEDTIME: `2026-10-02 10:00:${pad(i)}:000`, zoho_lead_id: 'other-lead', dealer_code: 'D2' }));
  const db = dbWith([...other, ...noisy]);

  const bare = await db.app.zcql().executeZCQLQuery("SELECT * FROM integration_logs WHERE zoho_lead_id = 'noisy-lead'");
  assert.equal(bare.length, 300, 'the old single query stopped at 300 of 756');

  const timeline = await crmIntegrationService.getLeadActivityTimeline(db.app, 'noisy-lead');
  assert.equal(timeline.length, 756);
  assert.ok(timeline.every((e) => e.zoho_lead_id === 'noisy-lead' && e.created_at === e.CREATEDTIME));
  assert.ok(timeline.every((e, i) => i === 0 || timeline[i - 1].CREATEDTIME <= e.CREATEDTIME), 'oldest first');
  assert.equal(new Set(timeline.map((e) => `${e.CREATEDTIME}`)).size > 1, true);
});

// --- retention: nothing here deletes history -----------------------------------------------------------------

test('no code path deletes integration_logs — retention needs an approved period first', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'test'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/table\((?:'integration_logs'|INTEGRATION_LOGS_TABLE)\)\s*\.\s*deleteRow/.test(source) || /DELETE\s+FROM\s+integration_logs/i.test(source)) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
