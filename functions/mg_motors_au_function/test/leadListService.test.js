'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const leadList = require('../services/leadListService');

const { classifyTriple, buildWhere, buildPathCondition, normalizePaging, MAX_ANDS } = leadList._test;

// A recording ZCQL fake. `respond` maps a query to its rows; everything that
// reaches the datastore is captured so tests can assert on the exact SQL —
// which is the contract (ZCQL itself was verified against the live Data Store
// when this was written).
function fakeApp(respond) {
  const queries = [];
  return {
    queries,
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        queries.push(sql);
        return respond(sql);
      },
    }),
  };
}

const leadRow = (n, extra = {}) => ({ leads: { ROWID: String(n), crm_record_id: `crm-${n}`, customer_name: `Customer ${n}`, dealer_code: 'D1', ...extra } });
const countRow = (n) => [{ leads: { 'COUNT(ROWID)': String(n) } }];

function standardResponder({ total = 0, rows = [], dealers = [], dealerNames = [] } = {}) {
  return (sql) => {
    if (sql.startsWith('SELECT COUNT(ROWID) FROM leads')) return countRow(total);
    if (sql.startsWith('SELECT * FROM leads')) return rows;
    if (sql.includes('FROM dealers WHERE dealer_name LIKE')) return dealers.map((code) => ({ dealers: { dealer_code: code } }));
    if (sql.includes('FROM dealers WHERE dealer_code IN')) {
      return dealerNames.map(([dealer_code, dealer_name]) => ({ dealers: { dealer_code, dealer_name } }));
    }
    return [];
  };
}

const pageQuery = (app) => app.queries.find((q) => q.startsWith('SELECT * FROM leads'));
const countQuery = (app) => app.queries.find((q) => q.startsWith('SELECT COUNT(ROWID) FROM leads'));
const whereOf = (sql) => (/ WHERE (.*?)( ORDER BY| LIMIT|$)/.exec(sql) || [])[1] || '';

// --- pagination ------------------------------------------------------------

test('default page is 50 rows and metadata describes the whole result set', async () => {
  const app = fakeApp(standardResponder({ total: 120, rows: [leadRow(1), leadRow(2)] }));
  const result = await leadList.getLeadsPage(app, {});

  assert.match(pageQuery(app), /LIMIT 1, 50$/, 'offset 0 is sent as LIMIT 1 (ZCQL offsets are 1-based)');
  assert.deepEqual(result.pagination, { page: 1, pageSize: 50, total: 120, totalPages: 3, hasMore: true });
  assert.equal(result.leads.length, 2);
});

test('page N starts exactly after page N-1 (no repeated or skipped row) and hasMore ends on the last page', async () => {
  const offsets = [];
  for (const page of [1, 2, 3]) {
    const app = fakeApp(standardResponder({ total: 45, rows: Array.from({ length: page === 3 ? 5 : 20 }, (_, i) => leadRow(i)) }));
    const result = await leadList.getLeadsPage(app, { page, pageSize: 20 });
    offsets.push(Number(/LIMIT (\d+), 20$/.exec(pageQuery(app))[1]) - 1); // back to a true 0-based offset
    assert.equal(result.pagination.hasMore, page < 3);
  }
  assert.deepEqual(offsets, [0, 20, 40], 'true offsets are contiguous: 0, 20, 40');
});

test('paging inputs are normalised: size capped at 200, junk falls back to defaults', () => {
  assert.deepEqual(normalizePaging({ page: 3, pageSize: 20 }), { page: 3, pageSize: 20 });
  assert.deepEqual(normalizePaging({ pageSize: 1000 }), { page: 1, pageSize: 200 });
  assert.deepEqual(normalizePaging({ page: 'abc', pageSize: '-5' }), { page: 1, pageSize: 50 });
  assert.deepEqual(normalizePaging({ page: 0, pageSize: 0 }), { page: 1, pageSize: 50 });
  assert.deepEqual(normalizePaging({ page: '2.9', pageSize: '10' }), { page: 2, pageSize: 10 });
});

test('page and COUNT queries share the same WHERE so the total always matches the rows', async () => {
  const app = fakeApp(standardResponder({ total: 3, rows: [leadRow(1)] }));
  await leadList.getLeadsPage(app, { status: 'Contacted', dealerCode: 'D9', showRemoved: false, search: 'jane' });

  const where = whereOf(pageQuery(app));
  assert.ok(where.includes("lead_status = 'Contacted'"));
  assert.equal(where, whereOf(countQuery(app)));
  assert.doesNotMatch(countQuery(app), /LIMIT|ORDER BY/);
});

test('an empty result returns well-formed metadata and skips the dealer-name lookup', async () => {
  const app = fakeApp(standardResponder({ total: 0, rows: [] }));
  const result = await leadList.getLeadsPage(app, { search: 'zzz' });

  assert.deepEqual(result.leads, []);
  assert.deepEqual(result.pagination, { page: 1, pageSize: 50, total: 0, totalPages: 1, hasMore: false });
  assert.equal(app.queries.some((q) => q.includes('FROM dealers WHERE dealer_code IN')), false);
});

test('a page past the end is empty but still reports the real total', async () => {
  const app = fakeApp(standardResponder({ total: 45, rows: [] }));
  const result = await leadList.getLeadsPage(app, { page: 99, pageSize: 20 });
  assert.equal(result.leads.length, 0);
  assert.equal(result.pagination.total, 45);
  assert.equal(result.pagination.totalPages, 3);
  assert.equal(result.pagination.hasMore, false);
});

// --- sorting ---------------------------------------------------------------

test('sorting is deterministic: every order ends with the unique ROWID tie-break', async () => {
  for (const [sortBy, expected] of [
    ['recent', 'ORDER BY MODIFIEDTIME DESC, ROWID DESC'],
    ['alpha', 'ORDER BY customer_name ASC, ROWID ASC'],
    [undefined, 'ORDER BY MODIFIEDTIME DESC, ROWID DESC'],
    ['bogus; DROP TABLE leads', 'ORDER BY MODIFIEDTIME DESC, ROWID DESC'],
  ]) {
    const app = fakeApp(standardResponder({ total: 1, rows: [leadRow(1)] }));
    await leadList.getLeadsPage(app, { sortBy });
    assert.ok(pageQuery(app).includes(expected), `${sortBy} -> ${expected}`);
  }
});

// --- filters ---------------------------------------------------------------

test('search matches customer, email, mobile and vehicle case-insensitively (ZCQL * wildcard)', () => {
  const where = buildWhere({ search: 'Jane' });
  for (const column of ['customer_name', 'email_address', 'mobile_number', 'vehicle_model']) {
    assert.ok(where.includes(`${column} LIKE '*Jane*'`), column);
  }
  assert.ok(!where.includes('%'));
});

test('search also matches the dealer NAME, resolved to dealer codes', async () => {
  const app = fakeApp(standardResponder({ total: 1, rows: [leadRow(1)], dealers: ['D7', 'D8'] }));
  await leadList.getLeadsPage(app, { search: 'ringwood' });

  assert.ok(app.queries.some((q) => q.includes("FROM dealers WHERE dealer_name LIKE '*ringwood*'")));
  assert.ok(whereOf(pageQuery(app)).includes("dealer_code IN ('D7', 'D8')"));
});

test('quotes in user input are escaped; a literal * (an unescapable wildcard) matches nothing', () => {
  assert.ok(buildWhere({ search: "O'Brien" }).includes("LIKE '*O''Brien*'"));
  assert.ok(buildWhere({ status: "x' OR '1'='1" }).includes("lead_status = 'x'' OR ''1''=''1'"));
  assert.ok(buildWhere({ search: 'a*b' }).includes("ROWID = '0'"));
});

test('status, dealer, removed and date-range filters are all applied in the database', () => {
  assert.equal(buildWhere({}), '');
  const where = buildWhere({
    status: 'Contacted',
    dealerCode: 'D1',
    showRemoved: false,
    fromDate: '2026-10-01',
    toDate: '2026-10-31',
  });
  assert.ok(where.includes("lead_status = 'Contacted'"));
  assert.ok(where.includes("dealer_code = 'D1'"));
  assert.ok(where.includes("sync_status != 'Removed'"));
  assert.ok(where.includes("CREATEDTIME >= '2026-10-01 00:00:00'"));
  assert.ok(where.includes("CREATEDTIME < '2026-11-01 00:00:00'"), 'end date is exclusive of the next day (millisecond-safe)');
  // Removed leads stay visible unless explicitly hidden, as in the old UI.
  assert.ok(!buildWhere({ showRemoved: true }).includes('Removed'));
  // A malformed date is ignored, not injected.
  assert.equal(buildWhere({ fromDate: "2026-10-01'; --" }), '');
});

// --- Happy / Unhappy classification ---------------------------------------

test('classifyTriple matches the Lead Exchange page classification', () => {
  const cases = [
    [{ storedPath: 'Happy 3', syncStatus: 'SYNCED', leadStatus: 'Rejected' }, 'happy', 'Happy 3'],
    [{ storedPath: null, syncStatus: 'DUPLICATE_LINKED', leadStatus: 'Not Contacted' }, 'happy', 'Happy 3'],
    [{ storedPath: 'Unhappy 5', syncStatus: 'ROUTING_HOLD', leadStatus: 'Not Contacted' }, 'unhappy', 'Unhappy 5'],
    [{ storedPath: 'Happy 1', syncStatus: 'SYNCED', leadStatus: 'Not Contacted' }, 'happy', 'Happy 1'],
    [{ storedPath: 'Happy 1', syncStatus: 'ROUTING_HOLD', leadStatus: 'Not Contacted' }, 'unhappy', 'Happy 1'],
    [{ storedPath: null, syncStatus: 'CONSENT_HOLD', leadStatus: 'Contacted' }, 'unhappy', 'Unhappy 8'],
    [{ storedPath: '', syncStatus: 'FAILED', leadStatus: 'Contacted' }, 'happy', 'Unhappy 1'],
    [{ storedPath: null, syncStatus: 'SYNCED', leadStatus: 'Junk Lead' }, 'unhappy', 'Unhappy 9'],
    [{ storedPath: null, syncStatus: 'SYNCED', leadStatus: 'Rejected' }, 'unhappy', 'Unhappy 9'],
    [{ storedPath: null, syncStatus: 'SYNCED', leadStatus: 'Contacted' }, 'happy', ''],
  ];
  for (const [triple, path, label] of cases) {
    assert.deepEqual(classifyTriple(triple), { path, label }, JSON.stringify(triple));
  }
});

const GROUPS = [
  { storedPath: 'Happy 1', syncStatus: 'SYNCED', leadStatus: 'Not Contacted', count: 5 },
  { storedPath: 'Happy 3', syncStatus: 'DUPLICATE_LINKED', leadStatus: 'Not Qualified', count: 2 },
  { storedPath: 'Unhappy 5', syncStatus: 'ROUTING_HOLD', leadStatus: 'Not Contacted', count: 7 },
  { storedPath: null, syncStatus: 'CONSENT_HOLD', leadStatus: 'Update Pending', count: 1 },
];

test('path and scenario filters become rule conditions inside the ZCQL AND budget', () => {
  const unhappy = buildPathCondition(GROUPS, { path: 'unhappy' });
  assert.ok(unhappy.sql.includes("happy_unhappy_path_name LIKE 'unhappy *'"));
  assert.ok(unhappy.sql.includes('DUPLICATE_LINKED'), 'duplicates are excluded from Unhappy');

  const happy = buildPathCondition(GROUPS, { path: 'happy' });
  assert.ok(happy.sql.includes('NOT LIKE'));

  const scenario = buildPathCondition(GROUPS, { scenario: 'Unhappy 5' });
  assert.ok(scenario.sql.includes("happy_unhappy_path_name IN ('Unhappy 5')"));
  assert.ok(scenario.sql.includes("'ROUTING_HOLD'"), 'unlabelled rows are matched through their sync status');

  for (const c of [unhappy, happy, scenario]) assert.ok(c.ands <= MAX_ANDS);
});

test('a scenario nobody has, or one that contradicts the path, matches nothing', () => {
  assert.equal(buildPathCondition(GROUPS, { scenario: 'Unhappy 99' }), null);
  assert.equal(buildPathCondition(GROUPS, { scenario: 'Happy 3', path: 'unhappy' }), null);
  assert.equal(buildPathCondition(GROUPS, { path: 'all' }), undefined);
});

test('an impossible path filter returns an empty page without running the leads query', async () => {
  const app = fakeApp((sql) => {
    if (sql.includes('GROUP BY')) {
      return GROUPS.map((g) => ({
        leads: {
          happy_unhappy_path_name: g.storedPath, sync_status: g.syncStatus, lead_status: g.leadStatus, 'COUNT(ROWID)': String(g.count),
        },
      }));
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const result = await leadList.getLeadsPage(app, { scenario: 'Unhappy 99' });
  assert.deepEqual(result.leads, []);
  assert.equal(result.pagination.total, 0);
});

test('the AND budget is enforced before the query reaches Catalyst', () => {
  assert.throws(
    () => buildWhere({ status: 'x' }, { pathCondition: { sql: 'a = 1', ands: MAX_ANDS + 1 } }),
    (err) => err instanceof leadList.FilterTooComplexError && err.code === 'FILTER_TOO_COMPLEX'
  );

  // The heaviest combination the UI can produce (search, status, dealer, removed
  // and a scenario) still fits.
  const worst = buildWhere(
    { search: 'mg', status: 'Not Contacted', dealerCode: 'D1', showRemoved: false },
    { pathCondition: buildPathCondition(GROUPS, { scenario: 'Unhappy 5', path: 'unhappy' }), searchDealerCodes: ['D1', 'D2'] }
  );
  assert.ok(worst.startsWith('WHERE '));

  // The API also accepts a date range (the page does not send one). Added to the
  // heaviest scenario it is either accepted or refused cleanly — never sent to
  // Catalyst in a shape the builder cannot vouch for.
  const withDates = () => buildWhere(
    { search: 'mg', status: 'Not Contacted', dealerCode: 'D1', showRemoved: false, fromDate: '2026-10-01', toDate: '2026-10-31' },
    {
      pathCondition: buildPathCondition(
        [...GROUPS, { storedPath: 'Unhappy 9', syncStatus: 'SYNCED', leadStatus: 'Junk Lead', count: 1 }],
        { scenario: 'Unhappy 9' }
      ),
      searchDealerCodes: ['D1'],
    }
  );
  try {
    assert.ok(withDates().startsWith('WHERE '));
  } catch (err) {
    assert.ok(err instanceof leadList.FilterTooComplexError, err.message);
  }
});

// --- facets, enrichment, detail lookup -------------------------------------

test('facets are global: statuses, scenarios, dealers and Happy/Unhappy counts', async () => {
  const app = fakeApp((sql) => {
    if (sql.includes('GROUP BY happy_unhappy_path_name')) {
      return GROUPS.map((g) => ({
        leads: {
          happy_unhappy_path_name: g.storedPath, sync_status: g.syncStatus, lead_status: g.leadStatus, 'COUNT(ROWID)': String(g.count),
        },
      }));
    }
    if (sql.includes('GROUP BY dealer_code')) return [{ leads: { dealer_code: 'B' } }, { leads: { dealer_code: 'A' } }];
    if (sql.includes('FROM dealers WHERE dealer_code IN')) {
      return [{ dealers: { dealer_code: 'A', dealer_name: 'Alpha MG' } }, { dealers: { dealer_code: 'B', dealer_name: 'Beta MG' } }];
    }
    return [];
  });

  const facets = await leadList.getLeadFacets(app);

  assert.equal(facets.total, 15);
  assert.deepEqual(facets.pathCounts, { happy: 7, unhappy: 8 });
  assert.deepEqual(facets.statuses, ['Not Contacted', 'Not Qualified', 'Update Pending']);
  assert.deepEqual(facets.dealers, [{ code: 'A', name: 'Alpha MG' }, { code: 'B', name: 'Beta MG' }]);
  assert.ok(facets.scenarios.includes('Unhappy 5') && facets.scenarios.includes('Happy 3'));
});

test('rows come back with dealer_name, defaulting to Unknown', async () => {
  const app = fakeApp(standardResponder({
    total: 2,
    rows: [leadRow(1, { dealer_code: 'D1' }), leadRow(2, { dealer_code: 'GONE' })],
    dealerNames: [['D1', 'Alpha MG']],
  }));
  const { leads } = await leadList.getLeadsPage(app, {});
  assert.deepEqual(leads.map((l) => l.dealer_name), ['Alpha MG', 'Unknown']);
  assert.equal(leads[0].ROWID, '1', 'the full lead row is preserved');
});

test('lead detail resolves by ROWID or crm_record_id and never queries ROWID with a non-numeric id', async () => {
  const byRowId = fakeApp((sql) => (sql.includes("ROWID = '123'") ? [leadRow(123)] : []));
  assert.equal((await leadList.getLeadByIdentifier(byRowId, '123')).ROWID, '123');

  const byCrmId = fakeApp((sql) => (sql.includes("crm_record_id = 'abc-9'") ? [leadRow(9, { crm_record_id: 'abc-9' })] : []));
  const found = await leadList.getLeadByIdentifier(byCrmId, 'abc-9');
  assert.equal(found.crm_record_id, 'abc-9');
  assert.equal(byCrmId.queries.some((q) => /WHERE ROWID =/.test(q)), false);

  const missing = fakeApp(() => []);
  assert.equal(await leadList.getLeadByIdentifier(missing, 'nope'), null);
  assert.equal(await leadList.getLeadByIdentifier(missing, '   '), null);
});
