'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const leadList = require('../services/leadListService');
const cache = require('../services/leadFacetsCache');

test.beforeEach(() => { delete process.env.LEAD_FACETS_CACHE_SECONDS; cache.clear(); });

function app() {
  const queries = [];
  return {
    queries,
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        queries.push(sql);
        if (sql.startsWith('SELECT COUNT(ROWID) FROM leads')) return [{ leads: { 'COUNT(ROWID)': '1' } }];
        if (sql.startsWith('SELECT * FROM leads')) return [{ leads: { ROWID: '1', crm_record_id: 'c1', dealer_code: 'D1' } }];
        if (sql.includes('GROUP BY happy_unhappy_path_name')) return [{ leads: { happy_unhappy_path_name: null, sync_status: 'SYNCED', lead_status: 'Open', 'COUNT(ROWID)': '1' } }];
        if (sql.includes('GROUP BY dealer_code')) return [{ leads: { dealer_code: 'D1', 'COUNT(ROWID)': '1' } }];
        if (sql.includes('FROM dealers WHERE dealer_code IN')) return [{ dealers: { dealer_code: 'D1', dealer_name: 'Dealer One' } }];
        return [];
      },
    }),
  };
}
const groupReads = (a) => a.queries.filter((q) => q.includes('GROUP BY')).length;

test('facets are reused within the cache time; lead rows are always read fresh', async () => {
  const a = app();
  const first = await leadList.getLeadsPage(a, { page: 1, pageSize: 10, includeFacets: true });
  const reads = groupReads(a);
  assert.ok(reads > 0);
  const second = await leadList.getLeadsPage(a, { page: 1, pageSize: 10, includeFacets: true });
  assert.equal(groupReads(a), reads, 'no new facet reads');
  assert.deepEqual(second.facets, first.facets);
  assert.equal(a.queries.filter((q) => q.startsWith('SELECT * FROM leads')).length, 2, 'the page is read each time');
});

test('freshFacets bypasses and replaces the cached facets', async () => {
  const a = app();
  await leadList.getLeadsPage(a, { page: 1, pageSize: 10, includeFacets: true });
  const reads = groupReads(a);
  await leadList.getLeadsPage(a, { page: 1, pageSize: 10, includeFacets: true, freshFacets: 'true' });
  assert.ok(groupReads(a) > reads);
});

test('LEAD_FACETS_CACHE_SECONDS=0 turns the cache off', async () => {
  process.env.LEAD_FACETS_CACHE_SECONDS = '0';
  const a = app();
  await leadList.getLeadsPage(a, { page: 1, pageSize: 10, includeFacets: true });
  const reads = groupReads(a);
  await leadList.getLeadsPage(a, { page: 1, pageSize: 10, includeFacets: true });
  assert.equal(groupReads(a), reads * 2);
});

test('a page without facets never reads them, and a stale entry is ignored', async () => {
  const a = app();
  await leadList.getLeadsPage(a, { page: 1, pageSize: 10 });
  assert.equal(groupReads(a), 0);
  cache.store({ total: 9 }, Date.now() - 61000);
  assert.equal(cache.peek(), null);
});
