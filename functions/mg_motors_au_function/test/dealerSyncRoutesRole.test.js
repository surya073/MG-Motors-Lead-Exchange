'use strict';

// Role guards on routes/dealerSyncRoutes.js (23 Oct audit: any signed-in user,
// including a dealer, could trigger dealer/lead syncs and read the dealer
// master). Syncs are Admin/Super Admin only; the read-only dealer master
// fetch also allows View User. The sync services are stubbed before the
// router is loaded, because the router destructures them at require time.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const zohoCrmService = require('../services/zohoCrmService');
const dealerSyncService = require('../services/dealerSyncService');
const leadSyncService = require('../services/leadSyncService');
const { SUPER_ADMIN_ROLE_ID, ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');

const calls = { fetchDealerMaster: 0, syncDealers: 0, syncLeads: 0 };
zohoCrmService.fetchDealerMaster = async () => { calls.fetchDealerMaster += 1; return [{ id: '1', Dealer_Code: 'D1', Name: 'Alpha MG' }]; };
dealerSyncService.syncDealers = async () => { calls.syncDealers += 1; return { inserted: 0 }; };
leadSyncService.syncLeads = async () => { calls.syncLeads += 1; return { inserted: 0 }; };

const dealerSyncRoutes = require('../routes/dealerSyncRoutes');

const VIEW_USER_ROLE_ID = '37148000000899033';
const DEALER_ROLE_ID = '11111111111111111'; // any role outside the allowed ones

async function request(t, { roleId, method, path }) {
  const server = express();
  server.use((req, res, next) => {
    res.locals.catalystApp = {};
    if (roleId !== null) res.locals.currentUser = { email_id: 'tester@example.com', role_details: { role_id: roleId } };
    next();
  });
  server.use(dealerSyncRoutes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, { method });
  return { status: response.status, body: await response.json() };
}

function resetCalls() {
  for (const key of Object.keys(calls)) calls[key] = 0;
}

const SYNC_ROUTES = [
  { path: '/sync/dealers', counter: 'syncDealers' },
  { path: '/sync/leads', counter: 'syncLeads' },
];

for (const { path, counter } of SYNC_ROUTES) {
  for (const roleId of [ADMIN_ROLE_ID, SUPER_ADMIN_ROLE_ID]) {
    test(`POST ${path} runs the sync for role ${roleId}`, async (t) => {
      resetCalls();
      const { status, body } = await request(t, { roleId, method: 'POST', path });
      assert.equal(status, 200);
      assert.equal(body.success, true);
      assert.equal(calls[counter], 1);
    });
  }

  for (const [label, roleId] of [['View User', VIEW_USER_ROLE_ID], ['dealer', DEALER_ROLE_ID]]) {
    test(`POST ${path} is refused for a ${label} and does not sync`, async (t) => {
      resetCalls();
      const { status } = await request(t, { roleId, method: 'POST', path });
      assert.equal(status, 403);
      assert.equal(calls[counter], 0);
    });
  }

  test(`POST ${path} is refused without a signed-in user`, async (t) => {
    resetCalls();
    const { status } = await request(t, { roleId: null, method: 'POST', path });
    assert.equal(status, 401);
    assert.equal(calls[counter], 0);
  });
}

for (const roleId of [ADMIN_ROLE_ID, SUPER_ADMIN_ROLE_ID, VIEW_USER_ROLE_ID]) {
  test(`GET /crm/dealers returns the dealer master for role ${roleId}`, async (t) => {
    resetCalls();
    const { status, body } = await request(t, { roleId, method: 'GET', path: '/crm/dealers' });
    assert.equal(status, 200);
    assert.equal(body.count, 1);
    assert.equal(body.dealers[0].dealer_code, 'D1');
  });
}

test('GET /crm/dealers is refused for a dealer and does not call the CRM', async (t) => {
  resetCalls();
  const { status } = await request(t, { roleId: DEALER_ROLE_ID, method: 'GET', path: '/crm/dealers' });
  assert.equal(status, 403);
  assert.equal(calls.fetchDealerMaster, 0);
});
