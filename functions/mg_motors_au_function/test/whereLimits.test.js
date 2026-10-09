'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const leadList = require('../services/leadListService');
const { FilterTooComplexError, translateZcqlError } = require('../utils/zcqlErrors');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const adminDashboardRoutes = require('../routes/adminDashboardRoutes');

const { or, and, cond, MAX_CHAIN } = leadList._test;

// Catalyst rejects an over-complex WHERE with "More than 10 conditions are not
// allowed in where clause". Measured against the live Data Store (not the
// documented "five"): a flat chain holds 10 comparisons and the 11th is refused;
// parenthesised groups each get their own chain; an IN list counts as one.
// These tests pin that behaviour in the test engine, prove the lead-list
// builder never produces a query the platform would refuse for any filter
// combination the UI can send, and check that anything it cannot guarantee is
// reported as a clean client error — never a bare 502.

const col = (c, n) => Array.from({ length: n }, (_, i) => `${c} = 'v${i}'`);
const count = (db, where) => db.app.zcql().executeZCQLQuery(`SELECT COUNT(ROWID) FROM leads WHERE ${where}`);

test('engine rule: a flat chain may hold 10 comparisons, the 11th is refused — OR and AND alike', async () => {
  const db = createInMemoryZcql({ leads: [{ lead_status: 'v1' }] });
  await count(db, col('lead_status', 10).join(' OR '));
  await count(db, col('lead_status', 10).join(' AND '));
  await assert.rejects(count(db, col('lead_status', 11).join(' OR ')), /More than 10 conditions/);
  await assert.rejects(count(db, col('lead_status', 11).join(' AND ')), /More than 10 conditions/);
});

test('engine rule: parenthesised groups each start their own chain; an IN list counts as one', async () => {
  const db = createInMemoryZcql({ leads: [{ lead_status: 'v1', dealer_code: 'D1' }] });
  const group = (c, n) => `(${col(c, n).join(' OR ')})`;
  await count(db, [group('lead_status', 6), group('dealer_code', 6)].join(' AND '));
  const inList = `lead_status IN (${Array.from({ length: 500 }, (_, i) => `'v${i}'`).join(', ')})`;
  await count(db, inList);
  await assert.rejects(count(db, group('lead_status', 11)), /More than 10 conditions/);
});

test('builder: it tracks flat-chain length and refuses what it cannot guarantee', () => {
  const leaf = (n) => Array.from({ length: n }, (_, i) => cond(`lead_status = 'v${i}'`));
  assert.equal(or(...leaf(10)).chain, 10);
  assert.throws(() => or(...leaf(11)), FilterTooComplexError);
  assert.equal(and(...leaf(10)).chain, 10);
  assert.throws(() => and(...leaf(11)), FilterTooComplexError);
  assert.equal(MAX_CHAIN, 10);

  // ANDed parts are parenthesised, so a long OR inside one does not merge into the AND chain...
  const nested = and(or(...leaf(6)), or(...leaf(6)));
  assert.equal(nested.chain, 2);
  // ...but ORed parts are not, so their chains add up.
  assert.equal(or(or(...leaf(4)), or(...leaf(4))).chain, 8);
  assert.throws(() => or(or(...leaf(6)), or(...leaf(6))), FilterTooComplexError);
});

test('builder: a long list of values is a single comparison, not a long chain', async () => {
  const where = leadList._test.buildWhere(
    { search: 'x' },
    { searchDealerCodes: Array.from({ length: 300 }, (_, i) => `D${i}`) }
  );
  const db = createInMemoryZcql({ leads: [{ customer_name: 'x' }] });
  const result = await count(db, where.replace(/^WHERE /, ''));
  assert.equal(result.length, 1, 'accepted by the platform rules even with 300 dealer codes');
});

// A dataset covering every scenario shape: valid and invalid stored labels, duplicates, holds, junk.
function scenarioDataset() {
  const stored = [null, '', 'Happy 1', 'Happy 3', 'Unhappy 2', 'Unhappy 5', 'Unhappy 9', 'Unhappy 10'];
  const sync = ['SYNCED', 'ROUTING_HOLD', 'CONSENT_HOLD', 'DUPLICATE_LINKED', 'FAILED', 'SLA_BREACH', null];
  const status = ['Not Contacted', 'Junk Lead', 'Contacted', 'Rejected', 'Dealer Unavailable'];
  const leads = [];
  stored.forEach((s) => sync.forEach((y) => status.forEach((l) => {
    leads.push({
      crm_record_id: `c${leads.length}`, customer_name: 'Alex MG', dealer_code: 'D1', lead_status: l,
      sync_status: y, happy_unhappy_path_name: s, mobile_number: '0400000000', email_address: 'a@x.com', vehicle_model: 'MG3',
    });
  })));
  return createInMemoryZcql({ leads, dealers: [{ dealer_code: 'D1', dealer_name: 'Alpha MG' }] });
}

test('every filter combination the UI can send is accepted AND returns exactly the rows a brute-force classification selects', async () => {
  const db = scenarioDataset();
  const { facets } = await leadList.getLeadsPage(db.app, { page: 1, pageSize: 5, includeFacets: true });
  assert.ok(facets.scenarios.length >= 8, 'the dataset exercises many scenarios');
  const { classifyTriple } = leadList._test;
  const triple = (l) => ({ storedPath: l.happy_unhappy_path_name, syncStatus: l.sync_status, leadStatus: l.lead_status });

  let ran = 0;
  for (const scenario of ['', ...facets.scenarios]) {
    for (const path of ['', 'happy', 'unhappy']) {
      for (const heavy of [false, true]) {
        const query = {
          page: 1, pageSize: 200, scenario, path,
          ...(heavy ? { search: 'mg', status: 'Contacted', dealerCode: 'D1', showRemoved: false } : {}),
        };
        // Would throw if the engine (= measured platform rules) or the builder refused it.
        const result = await leadList.getLeadsPage(db.app, query);

        const expected = db.tables.leads.filter((l) => {
          const c = classifyTriple(triple(l));
          return (!heavy || l.lead_status === 'Contacted')
            && (!path || c.path === path)
            && (!scenario || c.label === scenario);
        });
        assert.equal(result.pagination.total, expected.length, `${scenario || 'any'} / ${path || 'any'} / ${heavy ? 'all filters' : 'no filters'}`);
        ran += 1;
      }
    }
  }
  assert.ok(ran >= 6 * 3 * 2);
});

test('the API-only date range on top of the heaviest filters either works or is refused cleanly — never a raw failure', async () => {
  const db = scenarioDataset();
  const { facets } = await leadList.getLeadsPage(db.app, { page: 1, pageSize: 5, includeFacets: true });
  for (const scenario of facets.scenarios) {
    try {
      await leadList.getLeadsPage(db.app, {
        page: 1, pageSize: 5, scenario, search: 'mg', status: 'Contacted', dealerCode: 'D1',
        showRemoved: false, fromDate: '2026-10-01', toDate: '2026-10-09',
      });
    } catch (err) {
      assert.ok(err instanceof FilterTooComplexError, `${scenario}: ${err.message}`);
      assert.equal(err.code, 'FILTER_TOO_COMPLEX');
    }
  }
});

test('the path-enumeration fallback cannot build an over-long chain: it is refused, not sent', () => {
  // A bare "Unhappy" label has no rule (the stored value is not "Unhappy <n>"), so it is
  // enumerated triple by triple — one OR clause each.
  const triples = (n) => Array.from({ length: n }, (_, i) => ({
    storedPath: `Unhappy 5 x${i}`, syncStatus: 'SYNCED', leadStatus: 'Contacted', count: 1,
  }));
  const small = leadList._test.buildPathCondition(triples(5), { scenario: 'Unhappy' });
  assert.equal(small.chain, 5, 'a handful of triples is fine');
  assert.throws(
    () => leadList._test.buildPathCondition(triples(12), { scenario: 'Unhappy' }),
    FilterTooComplexError
  );
});

// --- a platform rejection becomes a clear 400 --------------------------------------------------

test('translateZcqlError turns the platform complexity rejection into a client error and leaves others alone', () => {
  const rejected = translateZcqlError(new Error('More than 10 conditions are not allowed in where clause'));
  assert.ok(rejected instanceof FilterTooComplexError);
  assert.equal(rejected.code, 'FILTER_TOO_COMPLEX');
  const other = new Error('connection reset');
  assert.equal(translateZcqlError(other), other);
});

async function get(t, app, path) {
  const server = express();
  server.use((req, res, next) => {
    res.locals.catalystApp = app;
    res.locals.currentUser = { email_id: 't@example.com', role_details: { role_id: ADMIN_ROLE_ID } };
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

test('if Catalyst itself refuses a query as too complex, the lead list and the log report answer 400, not 502', async (t) => {
  const refusing = {
    zcql: () => ({
      executeZCQLQuery: async () => {
        throw new Error('More than 10 conditions are not allowed in where clause');
      },
    }),
  };
  const leads = await get(t, refusing, '/admin/leads?page=1&status=Contacted');
  assert.equal(leads.status, 400);
  assert.match(leads.body.error, /Too many filters/);

  const logs = await get(t, refusing, '/admin/integration-logs?dealerCode=D1&status=FAILED');
  assert.equal(logs.status, 400);
  assert.match(logs.body.error, /Too many filters/);

  const broken = { zcql: () => ({ executeZCQLQuery: async () => { throw new Error('boom'); } }) };
  assert.equal((await get(t, broken, '/admin/leads?page=1')).status, 502, 'unrelated failures are still server errors');
});
