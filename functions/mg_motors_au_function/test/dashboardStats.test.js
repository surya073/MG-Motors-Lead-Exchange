'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const dashboard = require('../services/adminDashboardService');
const { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const adminDashboardRoutes = require('../routes/adminDashboardRoutes');

// The dashboards must report exactly what the old "read every row, count in
// JavaScript" code reported. The old per-row logic is still exported
// (summarizeLeadsByStatus, summarizeLeadsByRealStatus, getTopDealers), so each
// test computes the reference from the raw rows with it and compares that to
// the new database-aggregate result — on datasets that include duplicates,
// soft-removed leads, a removed dealer, a dealer with no leads and leads with
// missing fields. The in-memory engine reproduces Catalyst's real ZCQL rules
// (1-based LIMIT offset, 300-row cap, 10-condition cap, NULL semantics).

// --- dataset -----------------------------------------------------------------

const DEALERS = [
  { dealer_code: 'D1', dealer_name: 'Alpha MG', region: 'VIC', status: 'Active', sync_status: 'Synced' },
  { dealer_code: 'D2', dealer_name: 'Beta MG', region: 'NSW', status: 'Active', sync_status: 'Synced' },
  { dealer_code: 'D3', dealer_name: 'Gamma MG', region: 'QLD', status: 'Inactive', sync_status: 'Synced' },
  { dealer_code: 'D4', dealer_name: 'Delta MG', region: 'WA', status: 'Active', sync_status: 'Removed' },
  { dealer_code: 'D5', dealer_name: 'Epsilon MG', region: 'SA', status: 'Pending', sync_status: 'Synced' },
];

let seq = 0;
const lead = (dealer_code, lead_status, extra = {}) => ({
  crm_record_id: `crm-${++seq}`,
  dealer_code,
  lead_status,
  sync_status: 'SYNCED',
  CREATEDTIME: '2026-10-05 10:00:00:000',
  ...extra,
});

function buildLeads() {
  seq = 0;
  return [
    // D1 — 10 leads, 2 delivered
    lead('D1', 'Delivered'), lead('D1', 'Delivered'), lead('D1', 'Contacted'), lead('D1', 'Not Contacted'),
    lead('D1', 'Lost'), lead('D1', 'Update Pending'), lead('D1', 'Follow-up 1'),
    lead('D1', 'Not Qualified', { sync_status: 'DUPLICATE_LINKED', happy_unhappy_path_name: 'Happy 3' }), // duplicate
    lead('D1', 'Junk Lead', { sync_status: 'Removed' }),                                                 // soft-removed
    lead('D1', null),                                                                                    // no status
    // D2 — 6 leads, 1 delivered
    lead('D2', 'Delivered'), lead('D2', 'Contacted'), lead('D2', 'Contacted'), lead('D2', 'Quotation'),
    lead('D2', 'Not Qualified', { sync_status: 'DUPLICATE_LINKED' }), lead('D2', 'Lost Lead', { sync_status: 'Removed' }),
    // D3 — 2 leads
    lead('D3', 'Test Drive'), lead('D3', 'Dealer Unavailable'),
    // D4 (removed dealer) — 3 delivered: must not rank, but its leads still count everywhere
    lead('D4', 'Delivered'), lead('D4', 'Delivered'), lead('D4', 'Delivered'),
    // lead with no dealer at all
    lead(null, 'Contacted'),
  ];
}

function datasetApp(extraTables = {}) {
  return createInMemoryZcql({
    dealers: DEALERS.map((d) => ({ ...d })),
    leads: buildLeads(),
    dealer_integrations: [{ dealer_code: 'D1', status: 'CONNECTED', last_sync_at: '2026-10-09 01:00:00' }],
    sync_logs: [],
    integration_logs: [],
    ...extraTables,
  });
}

const leadsOf = (db) => db.tables.leads;
const isAggregateOnly = (db, table) =>
  db.queries.filter((q) => new RegExp(`FROM ${table}\\b`).test(q)).every((q) => /COUNT\(ROWID\)|MAX\(/.test(q));

// --- lead statistics ----------------------------------------------------------

test('dashboard summary matches the row-by-row result on a dataset with duplicates, removed leads and several dealers', async () => {
  const db = datasetApp();
  const leads = leadsOf(db);

  const summary = await dashboard.getDashboardSummary(db.app);

  // Reference: the original per-row functions over the raw rows.
  assert.equal(summary.totalLeads, leads.length);
  assert.deepEqual(summary.leadStatusSummary, dashboard.summarizeLeadsByStatus(leads));
  assert.deepEqual(summary.leadStatusBreakdown, dashboard.summarizeLeadsByRealStatus(leads));
  assert.deepEqual(summary.topDealers, dashboard.getTopDealers(db.tables.dealers, leads));
  assert.equal(summary.totalDealers, DEALERS.length);
  assert.deepEqual(summary.dealerStatusSummary, dashboard.summarizeDealerStatus(db.tables.dealers));

  // And the numbers themselves, spelled out so a regression is obvious.
  assert.equal(summary.totalLeads, 22);
  assert.equal(summary.leadStatusSummary.total, 22);
  assert.equal(summary.leadStatusSummary.delivered, 6); // 2 + 1 + 3 (removed dealer's included)
  assert.equal(summary.leadStatusSummary.contacted, 4); // D1 1, D2 2, no-dealer 1
  assert.equal(summary.leadStatusSummary.lost, 1);      // 'Lost' only; 'Lost Lead' is not a bucket
  assert.equal(summary.leadStatusBreakdown.total, 20);  // the 2 Removed leads are excluded
  // 'other' = leads whose status is not one of the donut's groups: Delivered x6,
  // Quotation, Test Drive and the lead with no status — none is silently dropped.
  assert.equal(summary.leadStatusBreakdown.other, 9);
});

test('top dealers: removed dealers and dealers without leads are excluded, ties break on conversion rate', async () => {
  const db = datasetApp();
  const { topDealers } = await dashboard.getDashboardSummary(db.app);

  assert.deepEqual(topDealers.map((d) => d.dealer_code), ['D1', 'D2', 'D3']);
  assert.deepEqual(topDealers[0], { dealer_code: 'D1', name: 'Alpha MG', region: 'VIC', total_leads: 10, delivered: 2, conversion_rate: 20 });
  assert.ok(!topDealers.some((d) => d.dealer_code === 'D4'), 'removed dealer must not rank');
  assert.ok(!topDealers.some((d) => d.dealer_code === 'D5'), 'dealer with no leads must not rank');
});

test('dealer lead counts include duplicates and soft-removed leads, as before', async () => {
  const db = datasetApp();
  const dealers = await dashboard.getAllDealersWithLeadCounts(db.app);

  const counts = Object.fromEntries(dealers.map((d) => [d.dealer_code, d.lead_count]));
  assert.deepEqual(counts, { D1: 10, D2: 6, D3: 2, D4: 3, D5: 0 });
  assert.equal(dealers.find((d) => d.dealer_code === 'D1').integration_status, 'CONNECTED');
  assert.equal(dealers.find((d) => d.dealer_code === 'D2').integration_status, null);

  for (const d of dealers) {
    assert.equal(d.lead_count, leadsOf(db).filter((l) => l.dealer_code === d.dealer_code).length, d.dealer_code);
  }
});

test('dealer performance equals the per-dealer row-by-row summary', async () => {
  const db = datasetApp();
  const performance = await dashboard.getDealerPerformance(db.app);

  assert.equal(performance.length, DEALERS.length);
  for (const row of performance) {
    const dealerLeads = leadsOf(db).filter((l) => l.dealer_code === row.dealer_code);
    const { dealer_code, dealer_name, region, ...metrics } = row;
    assert.deepEqual(metrics, dashboard.summarizeLeadsByStatus(dealerLeads), row.dealer_code);
    assert.ok(dealer_code && dealer_name && region);
  }
  assert.equal(performance.find((r) => r.dealer_code === 'D5').total, 0);
});

test('overall lead summary endpoint data equals summarizeLeadsByStatus over every lead', async () => {
  const db = datasetApp();
  assert.deepEqual(await dashboard.getLeadStatusSummary(db.app), dashboard.summarizeLeadsByStatus(leadsOf(db)));
});

test('no dashboard reads lead rows just to count them', async () => {
  const db = datasetApp();
  await dashboard.getDashboardSummary(db.app);
  await dashboard.getAllDealersWithLeadCounts(db.app);
  await dashboard.getDealerPerformance(db.app);
  await dashboard.getLeadStatusSummary(db.app);
  await dashboard.getLeadExchangeHealth(db.app, { fromDate: '2026-10-01' });

  assert.ok(db.queries.some((q) => q.includes('FROM leads')), 'leads were queried');
  assert.ok(isAggregateOnly(db, 'leads'), 'every leads query is a COUNT/GROUP BY, never SELECT *');
});

test('statistics stay exact on a large table and never read the rows', async () => {
  const dealers = Array.from({ length: 20 }, (_, i) => ({
    dealer_code: `X${i}`, dealer_name: `Dealer ${i}`, region: 'VIC', status: 'Active', sync_status: 'Synced',
  }));
  const statuses = ['Delivered', 'Contacted', 'Lost', 'Quotation', 'Not Contacted', 'Junk Lead', 'Test Drive', null];
  const leads = Array.from({ length: 5000 }, (_, i) => ({
    crm_record_id: `big-${i}`,
    dealer_code: i % 53 === 0 ? null : `X${i % 20}`,
    lead_status: statuses[i % statuses.length],
    sync_status: i % 7 === 0 ? 'Removed' : i % 11 === 0 ? 'DUPLICATE_LINKED' : 'SYNCED',
    CREATEDTIME: '2026-10-05 10:00:00:000',
  }));
  const db = createInMemoryZcql({ dealers, leads, dealer_integrations: [], sync_logs: [], integration_logs: [] });

  const summary = await dashboard.getDashboardSummary(db.app);

  assert.equal(summary.totalLeads, 5000);
  assert.deepEqual(summary.leadStatusSummary, dashboard.summarizeLeadsByStatus(leads));
  assert.deepEqual(summary.leadStatusBreakdown, dashboard.summarizeLeadsByRealStatus(leads));
  assert.deepEqual(summary.topDealers, dashboard.getTopDealers(dealers, leads));
  assert.ok(isAggregateOnly(db, 'leads'));
  assert.ok(db.queries.filter((q) => q.includes('FROM leads')).length <= 4, 'a handful of aggregate queries, not one per page of rows');
});

test('more than 300 dealers are all counted once (the ZCQL offset quirk no longer double-counts)', async () => {
  const dealers = Array.from({ length: 350 }, (_, i) => ({
    dealer_code: `Z${i}`, dealer_name: `Dealer ${i}`, region: 'VIC', status: 'Active', sync_status: 'Synced',
  }));
  const db = createInMemoryZcql({ dealers, leads: [], dealer_integrations: [], sync_logs: [], integration_logs: [] });

  const summary = await dashboard.getDashboardSummary(db.app);
  assert.equal(summary.totalDealers, 350);
  assert.equal(summary.dealerStatusSummary.active, 350);
  assert.equal((await dashboard.getAllDealersWithLeadCounts(db.app)).length, 350);
});

// --- sync logs -----------------------------------------------------------------

const syncLogs = (n) =>
  Array.from({ length: n }, (_, i) => ({
    sync_type: i % 2 ? 'Dealer_Sync' : 'Lead_Sync',
    sync_trigger: 'Webhook',
    status: 'Success',
    start_time: `2026-10-0${1 + (i % 9)} ${String(10 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`,
    total_records_fetched: i,
    records_failed: 0,
  }));

test('activity timeline and recent sync logs come from a bounded newest-first read', async () => {
  const logs = syncLogs(120);
  const db = datasetApp({ sync_logs: logs });

  const summary = await dashboard.getDashboardSummary(db.app);
  const newestFirst = [...logs].sort((a, b) => b.start_time.localeCompare(a.start_time));

  assert.equal(summary.activityTimeline.length, 8);
  assert.equal(summary.recentSyncLogs.length, 5);
  assert.deepEqual(summary.recentSyncLogs.map((l) => l.start_time), newestFirst.slice(0, 5).map((l) => l.start_time));
  assert.deepEqual(summary.activityTimeline.map((e) => e.time), newestFirst.slice(0, 8).map((l) => l.start_time));
  assert.ok(db.queries.filter((q) => q.includes('FROM sync_logs')).every((q) => /LIMIT/.test(q)), 'never an unbounded sync_logs read');

  const page = await dashboard.getSyncLogs(db.app, { limit: 50 });
  assert.equal(page.length, 50);
  assert.deepEqual(page.map((l) => l.start_time), newestFirst.slice(0, 50).map((l) => l.start_time));
  assert.equal((await dashboard.getSyncLogs(db.app, { limit: 500 })).length, 120, 'a limit above one ZCQL page still returns everything available');
});

// --- Lead Exchange health (Happy / Unhappy path metrics) --------------------------

const log = (created, dealer, path, extra = {}) => ({
  CREATEDTIME: `${created} 12:00:00:000`,
  dealer_code: dealer,
  happy_unhappy_path_name: path,
  happy_unhappy_path_message: path ? `${path} message` : '',
  status: path && path.startsWith('Unhappy') ? 'FAILED' : 'SUCCESS',
  zoho_lead_id: `lead-${created}-${dealer}-${path}`,
  error_message: '',
  field_changes: '[]',
  ...extra,
});

const dupLink = (from, to, gap) => JSON.stringify([{ field: 'duplicate_link', from, to, gap_minutes: gap }]);

const INTEGRATION_LOGS = [
  log('2026-10-01', 'D1', 'Happy 1'), log('2026-10-02', 'D1', 'Happy 1'), log('2026-10-08', 'D1', 'Happy 1'),
  log('2026-10-03', 'D2', 'Happy 1'), log('2026-10-09', 'D2', 'Happy 1'),
  log('2026-10-04', 'D1', 'Happy 4'),
  log('2026-10-02', 'D1', 'Happy 3', { field_changes: dupLink('orig-1', 'dup-1', 4) }),
  log('2026-10-06', 'D1', 'Happy 3', { field_changes: dupLink('orig-2', 'dup-2', 9) }),
  log('2026-10-07', 'D2', 'Happy 3', { field_changes: dupLink('orig-3', 'dup-3', 12) }),
  log('2026-10-05', 'D2', 'Unhappy 2'), log('2026-10-09', 'D2', 'Unhappy 2'),
  log('2026-10-03', 'D1', 'Unhappy 10', { error_message: 'No dealer action; SLA age 45 min; threshold 30' }),
  log('2026-10-08', 'D1', 'Unhappy 10', { error_message: 'No dealer action; SLA age 75 min; threshold 30' }),
  log('2026-10-08', 'D3', 'Unhappy 10', { error_message: 'breach without a parsable duration' }),
  log('2026-10-05', 'D1', '', { status: 'SUCCESS' }), log('2026-10-06', 'D2', null, { status: 'FAILED' }),
];

const healthApp = () => datasetApp({ integration_logs: INTEGRATION_LOGS.map((l) => ({ ...l })) });
const pathByName = (list) => Object.fromEntries(list.map((p) => [p.name, p]));

test('health: path counts, dealers affected, duplicates, SLA and exchange totals on a known log set', async () => {
  const db = healthApp();
  const health = await dashboard.getLeadExchangeHealth(db.app, {});

  const happy = pathByName(health.happyPaths);
  const unhappy = pathByName(health.unhappyPaths);
  assert.equal(happy['Happy 1'].count, 5);
  assert.equal(happy['Happy 1'].dealersAffected, 2);
  assert.equal(happy['Happy 1'].message, 'Happy 1 message');
  assert.equal(happy['Happy 1'].lastOccurrence, '2026-10-09 12:00:00:000');
  assert.equal(happy['Happy 4'].count, 1);
  assert.equal(happy['Happy 3'].count, 3);
  assert.equal(unhappy['Unhappy 2'].count, 2);
  assert.equal(unhappy['Unhappy 10'].count, 3);
  assert.equal(unhappy['Unhappy 10'].dealersAffected, 2);
  assert.deepEqual(health.happyPaths.map((p) => p.name), ['Happy 1', 'Happy 3', 'Happy 4'], 'most frequent first');

  // Duplicates (Happy 3): total, dealers affected, newest-first detail.
  assert.equal(health.duplicates.total, 3);
  assert.equal(health.duplicates.dealersAffected, 2);
  assert.deepEqual(health.duplicates.recent.map((r) => [r.originalLeadId, r.linkedLeadId, r.gapMinutes]), [
    ['orig-3', 'dup-3', 12], ['orig-2', 'dup-2', 9], ['orig-1', 'dup-1', 4],
  ]);

  // SLA: monitored = Happy 1 + Happy 4 = 6; 3 breaches; durations only from parsable rows.
  assert.equal(health.sla.monitored, 6);
  assert.equal(health.sla.breached, 3);
  assert.equal(health.sla.met, 3);
  assert.equal(health.sla.breachPercent, 50);
  assert.equal(health.sla.avgBreachMinutes, 60);
  assert.equal(health.sla.maxBreachMinutes, 75);

  // 16 events in all (2 have no scenario); successes are Happy rows, failures Unhappy rows.
  assert.equal(health.exchangeHealth.totalEvents, INTEGRATION_LOGS.length);
  assert.equal(health.exchangeHealth.successfulExchanges, 9);
  assert.equal(health.exchangeHealth.failedExchanges, 5);
  assert.equal(health.exchangeHealth.successRate, 64);
  assert.equal(health.truncated, false);
});

test('health: date range and dealer filter narrow every figure consistently', async () => {
  const db = healthApp();

  const range = await dashboard.getLeadExchangeHealth(db.app, { fromDate: '2026-10-05', toDate: '2026-10-08' });
  const inRange = INTEGRATION_LOGS.filter((l) => l.CREATEDTIME.slice(0, 10) >= '2026-10-05' && l.CREATEDTIME.slice(0, 10) <= '2026-10-08');
  assert.equal(range.exchangeHealth.totalEvents, inRange.length);
  const count = (name) => inRange.filter((l) => l.happy_unhappy_path_name === name).length;
  assert.equal(pathByName(range.happyPaths)['Happy 1'].count, count('Happy 1'));
  assert.equal(range.duplicates.total, count('Happy 3'));
  assert.equal(range.sla.breached, count('Unhappy 10'));
  assert.deepEqual(range.range, { fromDate: '2026-10-05', toDate: '2026-10-08', dealerCode: null });
  // Dealer health uses "any SUCCESS event in range": D1 (Happy 1, Happy 3, blank-path SUCCESS) and D2 (Happy 3).
  assert.equal(range.dealerHealth.activeInRange, 2);
  assert.equal(range.dealerHealth.withErrorsInRange, 3); // D1 (Unhappy 10), D2 (Unhappy 2 + blank FAILED), D3 (Unhappy 10)... D4 removed
  assert.equal(range.dealerHealth.total, 4); // D1, D2, D3, D5 — the removed dealer is not counted

  const oneDealer = await dashboard.getLeadExchangeHealth(db.app, { dealerCode: 'D2' });
  assert.equal(oneDealer.exchangeHealth.totalEvents, INTEGRATION_LOGS.filter((l) => l.dealer_code === 'D2').length);
  assert.equal(oneDealer.duplicates.total, 1);
  assert.equal(oneDealer.sla.breached, 0);
  assert.deepEqual(oneDealer.leadStatusSummary, dashboard.summarizeLeadsByStatus(leadsOf(db).filter((l) => l.dealer_code === 'D2')));

  const empty = await dashboard.getLeadExchangeHealth(db.app, { fromDate: '2030-01-01' });
  assert.equal(empty.exchangeHealth.totalEvents, 0);
  assert.equal(empty.exchangeHealth.successRate, 0);
  assert.deepEqual(empty.happyPaths, []);
  assert.equal(empty.sla.avgBreachMinutes, null);
  assert.equal(empty.leadStatusSummary.total, 0);
});

test('health: lead counts honour the dealer and the CREATEDTIME date range exactly like the old in-memory filter', async () => {
  const leads = [
    lead('D1', 'Delivered', { CREATEDTIME: '2026-10-01 00:00:00:000' }),
    lead('D1', 'Contacted', { CREATEDTIME: '2026-10-05 23:59:59:999' }), // last millisecond of the end date
    lead('D1', 'Delivered', { CREATEDTIME: '2026-10-06 00:00:00:000' }),
    lead('D2', 'Delivered', { CREATEDTIME: '2026-10-05 12:00:00:000' }),
    lead('D2', 'Lost', { CREATEDTIME: '2026-09-30 23:59:59:000' }),
  ];
  const db = createInMemoryZcql({ dealers: DEALERS.map((d) => ({ ...d })), leads, dealer_integrations: [], sync_logs: [], integration_logs: [] });

  for (const filters of [
    { fromDate: '2026-10-01', toDate: '2026-10-05' },
    { fromDate: '2026-10-05' },
    { toDate: '2026-10-01' },
    { dealerCode: 'D1', fromDate: '2026-10-02', toDate: '2026-10-06' },
    { dealerCode: 'D2' },
    {},
  ]) {
    const expected = leads.filter((l) => {
      if (filters.dealerCode && l.dealer_code !== filters.dealerCode) return false;
      const day = l.CREATEDTIME.slice(0, 10);
      return (!filters.fromDate || day >= filters.fromDate) && (!filters.toDate || day <= filters.toDate);
    });
    const health = await dashboard.getLeadExchangeHealth(db.app, filters);
    assert.deepEqual(health.leadStatusSummary, dashboard.summarizeLeadsByStatus(expected), JSON.stringify(filters));
  }
});

test('health: a malformed date is ignored rather than injected into the query', async () => {
  const db = healthApp();
  const health = await dashboard.getLeadExchangeHealth(db.app, { fromDate: "2026-10-01'; DROP TABLE leads; --" });
  assert.equal(health.range.fromDate, null);
  assert.equal(health.exchangeHealth.totalEvents, INTEGRATION_LOGS.length);
});

// --- routes: role-based access ----------------------------------------------------

const VIEW_USER_ROLE_ID = '37148000000899033';
const DEALER_ROLE_ID = '11111111111111111';

async function get(t, roleId, path) {
  const db = healthApp();
  const server = express();
  server.use((req, res, next) => {
    res.locals.catalystApp = db.app;
    if (roleId !== null) res.locals.currentUser = { email_id: 'tester@example.com', role_details: { role_id: roleId } };
    next();
  });
  server.use(adminDashboardRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`);
  return { status: response.status, body: await response.json() };
}

const DASHBOARD_ROUTES = [
  '/admin/dashboard-summary',
  '/admin/leads/summary',
  '/admin/dealers/performance',
  '/admin/dealers',
  '/admin/sync-logs',
  '/admin/lead-exchange-health?fromDate=2026-10-01',
];

test('dashboard endpoints keep their role checks and response shapes', async (t) => {
  for (const path of DASHBOARD_ROUTES) {
    assert.equal((await get(t, DEALER_ROLE_ID, path)).status, 403, `dealer on ${path}`);
    assert.equal((await get(t, null, path)).status, 401, `anonymous on ${path}`);
    for (const role of [ADMIN_ROLE_ID, SUPER_ADMIN_ROLE_ID, VIEW_USER_ROLE_ID]) {
      const { status, body } = await get(t, role, path);
      assert.equal(status, 200, `${role} on ${path}`);
      assert.equal(body.success, true);
    }
  }

  const summary = (await get(t, ADMIN_ROLE_ID, '/admin/dashboard-summary')).body;
  assert.equal(summary.totalLeads, 22);
  assert.ok(summary.leadStatusBreakdown && summary.topDealers && summary.activityTimeline);

  const leadsSummary = (await get(t, ADMIN_ROLE_ID, '/admin/leads/summary')).body;
  assert.equal(leadsSummary.summary.total, 22);
  assert.equal(leadsSummary.summary.delivered, 6);

  const dealers = (await get(t, ADMIN_ROLE_ID, '/admin/dealers')).body;
  assert.equal(dealers.count, DEALERS.length);
});
