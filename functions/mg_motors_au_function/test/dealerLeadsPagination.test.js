'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const access = require('../services/leadAccessService');
const dealerLeadRoutes = require('../routes/dealerLeadRoutes');
const aiTools = require('../services/aiAssistantToolService');

// A dealer must always see ALL of their own leads — never just the first
// rows Catalyst returns by default (a bare SELECT silently stops at 300 on
// this project) — and never anyone else's. These tests use dealers with 0,
// 100, 101 and 650 leads next to another busy dealer whose customers share
// names and numbers with theirs, so any leak or cut-off shows up.

const STATUSES = ['Not Contacted', 'Contacted', 'Lost', 'Follow-up 1', 'Contact in Future'];
const MODELS = ['MG3', 'MG4', 'ZS'];
const pad = (n, w = 4) => String(n).padStart(w, '0');

function leadsFor(dealerCode, count) {
  return Array.from({ length: count }, (_, i) => ({
    crm_record_id: `${dealerCode}-${i}`,
    dealer_code: dealerCode,
    // Same naming scheme for every dealer on purpose: a search must never match across dealers.
    customer_name: `Customer ${pad(i)}`,
    email_address: `customer${pad(i)}@example.com`,
    mobile_number: `0412${pad(i, 6)}`,
    vehicle_model: i % 3 === 0 ? null : MODELS[i % 3],
    lead_status: STATUSES[i % STATUSES.length],
    last_status_update: i % 4 === 0 ? null : `2026-10-0${1 + (i % 9)} 10:${pad(i % 60, 2)}:00`,
    sync_status: 'SYNCED',
  }));
}

const DEALER_SIZES = { D0: 0, D100: 100, D101: 101, DBIG: 650, OTHER: 120 };
const USERS = { 'u-d0': 'D0', 'u-d100': 'D100', 'u-d101': 'D101', 'u-big': 'DBIG', 'u-other': 'OTHER' };

function buildDb(sizes = DEALER_SIZES) {
  return createInMemoryZcql({
    leads: Object.entries(sizes).flatMap(([code, n]) => leadsFor(code, n)),
    dealer_user_mapping: Object.entries(USERS).map(([catalyst_user_id, dealer_code]) => ({ catalyst_user_id, dealer_code })),
    dealers: [],
  });
}

const ownLeads = (db, code) => db.tables.leads.filter((l) => l.dealer_code === code);

async function walk(db, code, query = {}, pageSize = 50) {
  const ids = [];
  const metas = [];
  for (let page = 1; page < 200; page += 1) {
    const r = await access.getDealerLeadsPage(db.app, code, { ...query, page, pageSize });
    r.leads.forEach((l) => {
      assert.equal(l.dealer_code, code, 'a page must never contain another dealer\'s lead');
      ids.push(l.crm_record_id);
    });
    metas.push(r.pagination);
    if (!r.pagination.hasMore) break;
  }
  return { ids, metas };
}

// --- the cut-off this fix removes ------------------------------------------------

test('the old call shape really did stop early: a bare SELECT for a 650-lead dealer returns only 300', async () => {
  const db = buildDb();
  const bare = await db.app.zcql().executeZCQLQuery("SELECT * FROM leads WHERE dealer_code = 'DBIG'");
  assert.equal(bare.length, 300);
  assert.equal(ownLeads(db, 'DBIG').length, 650);
});

for (const [code, size] of [['D0', 0], ['D100', 100], ['D101', 101], ['DBIG', 650]]) {
  test(`dealer with ${size} leads: every lead is reachable, counts and page metadata are exact`, async () => {
    const db = buildDb();
    const expected = ownLeads(db, code).map((l) => l.crm_record_id);

    const { ids, metas } = await walk(db, code);
    assert.deepEqual(ids, expected, 'every lead exactly once, in order, no repeats or gaps across pages');

    const first = metas[0];
    assert.equal(first.total, size);
    assert.equal(first.totalPages, Math.max(1, Math.ceil(size / 50)));
    assert.equal(metas[metas.length - 1].hasMore, false);
    metas.slice(0, -1).forEach((m) => assert.equal(m.hasMore, true));

    const counts = await access.getDealerLeadCounts(db.app, code);
    assert.equal(counts.total, size, 'the KPI total is exact, not capped');

    // The complete legacy list is also complete (no 300-row cut-off).
    const everything = await access.getAllLeadsForDealer(db.app, code);
    assert.equal(everything.leads.length, size);
    assert.equal(everything.truncated, false);
    assert.deepEqual((await access.getLeadsForDealer(db.app, code)).map((l) => l.crm_record_id), expected);
  });
}

test('the boundary: a dealer with exactly 100 vs 101 leads pages as 2 vs 3 pages of 50', async () => {
  const db = buildDb();
  assert.equal((await access.getDealerLeadsPage(db.app, 'D100', { pageSize: 50 })).pagination.totalPages, 2);
  assert.equal((await access.getDealerLeadsPage(db.app, 'D101', { pageSize: 50 })).pagination.totalPages, 3);
  const last = await access.getDealerLeadsPage(db.app, 'D101', { page: 3, pageSize: 50 });
  assert.equal(last.leads.length, 1, 'the 101st lead is not lost');
  assert.equal(last.leads[0].crm_record_id, 'D101-100');
  assert.deepEqual((await access.getDealerLeadsPage(db.app, 'D0', {})).pagination, { page: 1, pageSize: 50, total: 0, totalPages: 1, hasMore: false });
});

test('a page past the end is empty but reports the true total', async () => {
  const db = buildDb();
  const r = await access.getDealerLeadsPage(db.app, 'D101', { page: 9, pageSize: 50 });
  assert.equal(r.leads.length, 0);
  assert.equal(r.pagination.total, 101);
  assert.equal(r.pagination.hasMore, false);
});

test('the "read everything" call is bounded and says so instead of silently stopping', async () => {
  const db = buildDb({ HUGE: 5200 });
  const r = await access.getAllLeadsForDealer(db.app, 'HUGE');
  assert.equal(r.leads.length, 5000);
  assert.equal(r.truncated, true);
  assert.equal(r.total, 5200);
});

// --- search, filter, sort (parity with the old in-browser behaviour) --------------

// The old My Leads page logic, applied to the dealer's rows.
function inBrowser(leads, { search, status, sortKey, sortDir }) {
  const term = String(search || '').trim().toLowerCase();
  let rows = leads.filter((l) => {
    const matchesSearch = !term || [l.customer_name, l.email_address, l.mobile_number, l.vehicle_model]
      .filter(Boolean).some((f) => f.toLowerCase().includes(term));
    return matchesSearch && (!status || l.lead_status === status);
  });
  if (sortKey) {
    rows = [...rows].sort((a, b) => {
      const cmp = String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }
  return rows.map((l) => l.crm_record_id);
}

test('search, status and sort give the same rows in the same order as the old client-side logic', async () => {
  const db = buildDb();
  const own = ownLeads(db, 'DBIG');

  for (const query of [
    {},
    { status: 'Contacted' },
    { status: 'Lost', search: '1' },
    { search: 'customer 04' },
    { search: 'CUSTOMER0123@EXAMPLE' },
    { search: '0412000007' },
    { search: 'mg4' },
    { search: 'no-such-thing' },
    { sortKey: 'customer_name', sortDir: 'asc' },
    { sortKey: 'customer_name', sortDir: 'desc' },
    { sortKey: 'vehicle_model', sortDir: 'asc' },
    { sortKey: 'lead_status', sortDir: 'desc' },
    { sortKey: 'last_status_update', sortDir: 'asc' },
    { sortKey: 'last_status_update', sortDir: 'desc' },
    { status: 'Contacted', search: 'mg', sortKey: 'customer_name', sortDir: 'desc' },
  ]) {
    const { ids, metas } = await walk(db, 'DBIG', query, 40);
    const expected = inBrowser(own, query);
    assert.deepEqual(ids, expected, JSON.stringify(query));
    assert.equal(metas[0].total, expected.length, `total for ${JSON.stringify(query)}`);
  }
});

test('sorting is deterministic: equal sort values are tie-broken by ROWID so no row repeats or vanishes between pages', async () => {
  const db = buildDb();
  const { ids } = await walk(db, 'DBIG', { sortKey: 'lead_status', sortDir: 'asc' }, 7);
  assert.equal(ids.length, 650);
  assert.equal(new Set(ids).size, 650);
  assert.match(access._test.orderByClause('lead_status', 'asc'), /ORDER BY lead_status ASC, ROWID ASC$/);
  assert.equal(access._test.orderByClause('not_a_column; DROP TABLE leads', 'asc'), 'ORDER BY ROWID ASC');
});

test('paging inputs are normalised: size capped at 200, junk falls back to defaults', () => {
  const n = access._test.normalizePaging;
  assert.deepEqual(n({ page: 3, pageSize: 20 }), { page: 3, pageSize: 20 });
  assert.deepEqual(n({ pageSize: 5000 }), { page: 1, pageSize: 200 });
  assert.deepEqual(n({ page: 'x', pageSize: '-1' }), { page: 1, pageSize: 50 });
});

// --- tenant isolation -------------------------------------------------------------

test('every dealer query is restricted to the dealer code, as the first condition', async () => {
  const db = buildDb();
  await access.getDealerLeadsPage(db.app, 'D101', { search: 'x', status: 'Lost', sortKey: 'customer_name', page: 2, pageSize: 10 });
  await access.getDealerLeadCounts(db.app, 'D101');
  await access.getDealerLeadSummary(db.app, 'D101');
  await access.getAllLeadsForDealer(db.app, 'D101');

  const leadQueries = db.queries.filter((q) => q.includes('FROM leads'));
  assert.ok(leadQueries.length >= 5);
  leadQueries.forEach((q) => assert.match(q, /WHERE dealer_code = 'D101'( AND |$| GROUP| ORDER| LIMIT)/, q));
});

test('injection attempts in search or status can not widen the query to another dealer', async () => {
  const db = buildDb();
  for (const query of [
    { search: "x' OR dealer_code = 'OTHER" },
    { search: "') OR ('1'='1" },
    { status: "Contacted' OR dealer_code = 'OTHER" },
    { search: 'customer*' },
  ]) {
    const { ids } = await walk(db, 'D101', query);
    assert.ok(ids.every((id) => id.startsWith('D101-')), JSON.stringify(query));
  }
});

test('searching for another dealer\'s customer returns nothing for this dealer, and the other dealer still finds theirs', async () => {
  const db = buildDb({ D101: 101, OTHER: 120 });
  // Make one OTHER customer unmistakable.
  db.tables.leads.find((l) => l.crm_record_id === 'OTHER-5').customer_name = 'Zebediah Unique';
  assert.equal((await access.getDealerLeadsPage(db.app, 'D101', { search: 'zebediah' })).pagination.total, 0);
  assert.equal((await access.getDealerLeadsPage(db.app, 'OTHER', { search: 'zebediah' })).pagination.total, 1);
});

test('a missing dealer code is refused instead of becoming an unrestricted query', async () => {
  const db = buildDb();
  for (const bad of [undefined, null, '', '   ']) {
    await assert.rejects(access.getDealerLeadsPage(db.app, bad, {}), /dealer code is required/);
    await assert.rejects(access.getAllLeadsForDealer(db.app, bad), /dealer code is required/);
    await assert.rejects(access.getDealerLeadCounts(db.app, bad), /dealer code is required/);
  }
  assert.equal(db.queries.filter((q) => q.includes('FROM leads')).length, 0, 'no query reached the datastore');
});

// --- HTTP: authenticated dealer only ------------------------------------------------

async function call(t, { userId, method = 'GET', path, body }) {
  const db = call.db || buildDb();
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => {
    res.locals.catalystApp = db.app;
    if (userId) res.locals.currentUser = { user_id: userId, email_id: `${userId}@example.com` };
    next();
  });
  server.use(dealerLeadRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json(), db };
}

test('GET /dealer/leads?page= returns the signed-in dealer\'s page with exact pagination metadata', async (t) => {
  const { status, body } = await call(t, { userId: 'u-big', path: '/dealer/leads?page=3&pageSize=100' });
  assert.equal(status, 200);
  assert.equal(body.dealerCode, 'DBIG');
  assert.equal(body.leads.length, 100);
  assert.ok(body.leads.every((l) => l.dealer_code === 'DBIG'));
  assert.deepEqual(body.pagination, { page: 3, pageSize: 100, total: 650, totalPages: 7, hasMore: true });
  assert.equal(body.summary, undefined);
});

test('includeSummary returns exact KPI counts for the dealer', async (t) => {
  const { body } = await call(t, { userId: 'u-d101', path: '/dealer/leads?page=1&pageSize=10&includeSummary=true' });
  const own = buildDb().tables.leads.filter((l) => l.dealer_code === 'D101');
  assert.equal(body.summary.total, 101);
  for (const status of STATUSES) {
    assert.equal(body.summary.byStatus[status], own.filter((l) => l.lead_status === status).length, status);
  }
});

test('without page/pageSize the full list is complete (no silent cut-off) and says how many there are', async (t) => {
  const { body } = await call(t, { userId: 'u-big', path: '/dealer/leads' });
  assert.equal(body.leads.length, 650);
  assert.equal(body.total, 650);
  assert.equal(body.truncated, undefined);
  assert.ok(body.leads.every((l) => l.dealer_code === 'DBIG'));
});

test('cross-dealer attempts: client-supplied dealer codes are ignored', async (t) => {
  for (const path of [
    '/dealer/leads?page=1&dealerCode=OTHER',
    '/dealer/leads?page=1&dealer_code=OTHER',
    '/dealer/leads?page=1&pageSize=200&search=customer&dealerCode=OTHER&status=',
    '/dealer/leads?dealerCode=OTHER',
  ]) {
    const { body } = await call(t, { userId: 'u-d100', path });
    assert.equal(body.dealerCode, 'D100', path);
    assert.ok(body.leads.length > 0);
    assert.ok(body.leads.every((l) => l.dealer_code === 'D100'), path);
  }
});

test('dealer isolation across users: each dealer gets only their own total and rows', async (t) => {
  for (const [userId, code, size] of [['u-d100', 'D100', 100], ['u-d101', 'D101', 101], ['u-other', 'OTHER', 120], ['u-d0', 'D0', 0]]) {
    const { body } = await call(t, { userId, path: '/dealer/leads?page=1&pageSize=200' });
    assert.equal(body.dealerCode, code);
    assert.equal(body.pagination.total, size);
    assert.ok(body.leads.every((l) => l.dealer_code === code));
  }
});

test('a signed-in user with no dealership gets 403; an anonymous caller gets 401 — on every dealer lead route', async (t) => {
  for (const path of ['/dealer/leads?page=1', '/dealer/leads', '/dealer/leads/summary']) {
    assert.equal((await call(t, { userId: 'u-nobody', path })).status, 403, path);
    assert.equal((await call(t, { userId: null, path })).status, 401, path);
  }
});

test('GET /dealer/leads/summary is exact and dealer-scoped for a large dealer', async (t) => {
  const { status, body } = await call(t, { userId: 'u-big', path: '/dealer/leads/summary' });
  const own = buildDb().tables.leads.filter((l) => l.dealer_code === 'DBIG');
  assert.equal(status, 200);
  assert.equal(body.dealerCode, 'DBIG');
  assert.deepEqual(body.summary, access.summarizeLeadsByStatus(own));
  assert.equal(body.summary.total, 650);
  assert.equal(body.summary.contacted, own.filter((l) => l.lead_status === 'Contacted').length);
  assert.equal(body.summary.lost, own.filter((l) => l.lead_status === 'Lost').length);
});

test('existing lead action is still dealer-scoped: updating another dealer\'s lead is refused (404) before anything is written', async (t) => {
  const db = buildDb();
  call.db = db;
  try {
    const otherRowId = 1000 + db.tables.leads.findIndex((l) => l.crm_record_id === 'OTHER-3');
    const cross = await call(t, { userId: 'u-d101', method: 'PATCH', path: `/dealer/leads/${otherRowId}`, body: { lead_status: 'Contacted' } });
    assert.equal(cross.status, 404);

    const badStatus = await call(t, { userId: 'u-d101', method: 'PATCH', path: `/dealer/leads/${otherRowId}`, body: { lead_status: 'Not A Status' } });
    assert.equal(badStatus.status, 400);

    const anonymous = await call(t, { userId: null, method: 'PATCH', path: `/dealer/leads/${otherRowId}`, body: { lead_status: 'Contacted' } });
    assert.equal(anonymous.status, 401);
  } finally {
    call.db = null;
  }
});

// --- AI assistant tool that read the same capped list ---------------------------------

test('the assistant\'s "my leads" tool reports the exact total for a large dealer and lists 30', async () => {
  const db = buildDb();
  const own = ownLeads(db, 'DBIG');

  const all = await aiTools.getMyLeads(db.app, 'DBIG');
  assert.equal(all.count, 650);
  assert.equal(all.leads.length, 30);

  const contacted = await aiTools.getMyLeads(db.app, 'DBIG', { leadStatus: 'Contacted' });
  assert.equal(contacted.count, own.filter((l) => l.lead_status === 'Contacted').length);
  assert.ok(contacted.leads.length <= 30 && contacted.leads.length > 0);
  contacted.leads.forEach((l) => assert.equal(l.dealerCode, 'DBIG'));
});
