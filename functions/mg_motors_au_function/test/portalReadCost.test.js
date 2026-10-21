'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const dashboard = require('../services/adminDashboardService');
const stats = require('../services/dashboardStatsService');
const lists = require('../services/leadListService');

test('legacy dealer-filtered request reads only its matching leads, not the other 648', async () => {
  const db = createInMemoryZcql({
    leads: Array.from({ length: 650 }, (_, i) => ({ dealer_code: i < 2 ? 'D1' : 'D2', lead_status: 'Contacted', customer_name: `Customer ${i}` })),
    dealers: [{ dealer_code: 'D1', dealer_name: 'One' }, { dealer_code: 'D2', dealer_name: 'Two' }],
  });
  const result = await dashboard.getAllLeads(db.app, { dealerCode: 'D1', leadStatus: 'Contacted' });
  assert.equal(result.length, 2);
  assert.ok(result.every((row) => row.dealer_name === 'One'));
  const leadQueries = db.queries.filter((sql) => sql.startsWith('SELECT * FROM leads'));
  assert.equal(leadQueries.length, 1, 'the original unfiltered implementation needed four pages');
  assert.match(leadQueries[0], /WHERE dealer_code = 'D1' AND lead_status = 'Contacted'/);
  assert.equal(db.queries.some((sql) => sql.startsWith('SELECT * FROM dealers')), false);
  assert.match(db.queries.find((sql) => sql.includes('FROM dealers')), /dealer_code IN \('D1'\)/);
});

test('legacy list stays complete past page boundaries and escapes dealer/status filters', async () => {
  const db = createInMemoryZcql({
    leads: Array.from({ length: 650 }, (_, i) => ({ dealer_code: "D'1", lead_status: "O'Brien", crm_record_id: `crm-${i}` })),
    dealers: [{ dealer_code: "D'1", dealer_name: 'One' }],
  });
  const result = await dashboard.getAllLeads(db.app, { dealerCode: "D'1", leadStatus: "O'Brien" });
  assert.equal(result.length, 650);
  assert.equal(new Set(result.map((row) => row.ROWID)).size, 650);
  assert.match(db.queries[0], /dealer_code = 'D''1' AND lead_status = 'O''Brien'/);
  assert.equal((await dashboard.getAllLeads(db.app)).length, 650, 'unfiltered legacy consumers retain their full response');
});

test('externally supplied sync-log limits cannot drain the entire history', async () => {
  for (const [limit, expected] of [[Infinity, 50], [1e12, 500], ['bad', 50], [-5, 1], [500.9, 500], [8, 8]]) {
    const db = createInMemoryZcql({ sync_logs: Array.from({ length: 700 }, (_, i) => ({ start_time: `2026-10-01 10:${String(i % 60).padStart(2, '0')}:00` })) });
    assert.equal((await stats.recentSyncLogs(db.app, limit)).length, expected, String(limit));
    assert.ok(db.queries.every((sql) => Number(/, (\d+)$/.exec(sql)[1]) <= 300));
  }
});

test('path-only pages skip global grouping while scenario/facet requests retain it in stable order', async () => {
  const db = createInMemoryZcql({
    leads: [{ dealer_code: 'D1', lead_status: 'Contacted', sync_status: 'SYNCED', happy_unhappy_path_name: 'Happy 1' }],
    dealers: [{ dealer_code: 'D1', dealer_name: 'One' }],
  });
  await lists.getLeadsPage(db.app, { page: 1, path: 'happy' });
  await lists.getLeadsPage(db.app, { page: 2, path: 'happy' });
  assert.equal(db.queries.filter((sql) => sql.includes('GROUP BY happy_unhappy_path_name')).length, 0,
    'the original implementation issued one global grouping query per path page');
  const scenario = await lists.getLeadsPage(db.app, { page: 1, scenario: 'Happy 1', includeFacets: true });
  assert.equal(scenario.leads.length, 1);
  assert.equal(scenario.facets.pathCounts.happy, 1);
  assert.ok(db.queries.some((sql) => /GROUP BY happy_unhappy_path_name.*ORDER BY happy_unhappy_path_name, sync_status, lead_status/.test(sql)));
});

test('all-time dealer errors come from actual integration state and exclude removed dealers', async () => {
  const db = createInMemoryZcql({
    dealers: [{ dealer_code: 'D1', status: 'Active' }, { dealer_code: 'D2', status: 'Active' }, { dealer_code: 'REMOVED', status: 'Active', sync_status: 'Removed' }],
    dealer_integrations: [{ dealer_code: 'D1', status: 'ERROR' }, { dealer_code: 'D1', status: 'ERROR' }, { dealer_code: 'D2', status: 'CONNECTED' }, { dealer_code: 'REMOVED', status: 'ERROR' }],
    leads: [], integration_logs: [], sync_logs: [],
  });
  assert.equal((await dashboard.getLeadExchangeHealth(db.app)).dealerHealth.withErrorsInRange, 1);
  assert.equal((await dashboard.getLeadExchangeHealth(db.app, { dealerCode: 'D2' })).dealerHealth.withErrorsInRange, 0);
  assert.equal((await dashboard.getLeadExchangeHealth(db.app, { dealerCode: 'D1' })).dealerHealth.withErrorsInRange, 1);
});
