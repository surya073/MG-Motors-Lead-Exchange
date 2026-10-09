'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const adminDashboardRoutes = require('../routes/adminDashboardRoutes');

// Authorization and response-shape tests for GET /admin/leads (paginated and
// legacy) and GET /admin/leads/detail/:id. The route is mounted behind the
// same role middleware production uses; only the signed-in user and the
// datastore are faked.

const VIEW_USER_ROLE_ID = '37148000000899033';
const DEALER_ROLE_ID = '11111111111111111'; // any role outside the three allowed ones

function lead(n) {
  return { leads: { ROWID: String(n), crm_record_id: `crm-${n}`, customer_name: `Customer ${n}`, dealer_code: 'D1', lead_status: 'Not Contacted' } };
}

function catalystApp({ total = 7, pageRows = [lead(1), lead(2)], failWith = null } = {}) {
  return {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (failWith) throw failWith;
        if (sql.startsWith('SELECT COUNT(ROWID) FROM leads')) return [{ leads: { 'COUNT(ROWID)': String(total) } }];
        if (sql.includes('FROM dealers WHERE dealer_code IN')) return [{ dealers: { dealer_code: 'D1', dealer_name: 'Alpha MG' } }];
        if (sql.includes('FROM dealers')) return [];
        if (sql.includes('GROUP BY happy_unhappy_path_name')) {
          return [{ leads: { happy_unhappy_path_name: 'Happy 1', sync_status: 'SYNCED', lead_status: 'Not Contacted', 'COUNT(ROWID)': '7' } }];
        }
        if (sql.includes('GROUP BY dealer_code')) return [{ leads: { dealer_code: 'D1' } }];
        if (/WHERE (ROWID|crm_record_id) = /.test(sql)) {
          return sql.includes("ROWID = '1'") || sql.includes("crm_record_id = 'crm-1'") ? [lead(1)] : [];
        }
        if (sql.startsWith('SELECT * FROM leads')) return pageRows;
        return [];
      },
    }),
  };
}

async function request(t, { roleId, app = catalystApp(), path }) {
  const server = express();
  server.use((req, res, next) => {
    res.locals.catalystApp = app;
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

test('paginated request returns the page, count and pagination metadata (admin)', async (t) => {
  const { status, body } = await request(t, { roleId: ADMIN_ROLE_ID, path: '/admin/leads?page=1&pageSize=2' });

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.count, 2);
  assert.equal(body.leads.length, 2);
  assert.equal(body.leads[0].dealer_name, 'Alpha MG');
  assert.deepEqual(body.pagination, { page: 1, pageSize: 2, total: 7, totalPages: 4, hasMore: true });
  assert.equal(body.facets, undefined, 'facets only when asked for');
});

test('facets are returned only with includeFacets=true', async (t) => {
  const { body } = await request(t, { roleId: SUPER_ADMIN_ROLE_ID, path: '/admin/leads?page=1&includeFacets=true' });
  assert.deepEqual(body.facets.pathCounts, { happy: 7, unhappy: 0 });
  assert.deepEqual(body.facets.statuses, ['Not Contacted']);
  assert.deepEqual(body.facets.dealers, [{ code: 'D1', name: 'Alpha MG' }]);
});

test('view-only users can read the paginated list', async (t) => {
  const { status } = await request(t, { roleId: VIEW_USER_ROLE_ID, path: '/admin/leads?page=1' });
  assert.equal(status, 200);
});

test('authorization: dealers are refused, unauthenticated callers get 401, on every leads route', async (t) => {
  for (const path of ['/admin/leads?page=1', '/admin/leads', '/admin/leads/detail/1']) {
    const dealer = await request(t, { roleId: DEALER_ROLE_ID, path });
    assert.equal(dealer.status, 403, `dealer on ${path}`);
    const anonymous = await request(t, { roleId: null, path });
    assert.equal(anonymous.status, 401, `anonymous on ${path}`);
  }
});

test('legacy call without page/pageSize still returns the unpaginated list (navbar search, dealer tabs)', async (t) => {
  const app = catalystApp({ pageRows: [lead(1), lead(2), lead(3)] });
  const { status, body } = await request(t, { roleId: ADMIN_ROLE_ID, app, path: '/admin/leads' });

  assert.equal(status, 200);
  assert.equal(body.count, 3);
  assert.equal(body.leads.length, 3);
  assert.equal(body.pagination, undefined);
});

test('an over-complex filter combination is a clear 400, not a Catalyst error', async (t) => {
  // Not reachable with real filters (the budget is sized to the UI), so force
  // it by failing the way buildWhere does.
  const error = Object.assign(new Error('Too many filters combined for one query. Remove a filter and try again.'), {
    code: 'FILTER_TOO_COMPLEX',
  });
  const { status, body } = await request(t, {
    roleId: ADMIN_ROLE_ID,
    app: catalystApp({ failWith: error }),
    path: '/admin/leads?page=1',
  });
  assert.equal(status, 400);
  assert.match(body.error, /Too many filters/);
});

test('detail lookup works by ROWID and by crm_record_id, and 404s for an unknown lead', async (t) => {
  const byRow = await request(t, { roleId: ADMIN_ROLE_ID, path: '/admin/leads/detail/1' });
  assert.equal(byRow.status, 200);
  assert.equal(byRow.body.lead.ROWID, '1');
  assert.equal(byRow.body.lead.dealer_name, 'Alpha MG');

  const byCrm = await request(t, { roleId: ADMIN_ROLE_ID, path: '/admin/leads/detail/crm-1' });
  assert.equal(byCrm.status, 200);

  const missing = await request(t, { roleId: ADMIN_ROLE_ID, path: '/admin/leads/detail/does-not-exist' });
  assert.equal(missing.status, 404);
});

test('other lead routes are not shadowed by the new detail route', async (t) => {
  const summary = await request(t, { roleId: ADMIN_ROLE_ID, path: '/admin/leads/summary' });
  assert.notEqual(summary.status, 404);
});
