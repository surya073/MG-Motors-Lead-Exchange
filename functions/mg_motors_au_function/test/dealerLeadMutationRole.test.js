'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { APP_ROLES, CATALYST_ROLE_ID_MAP } = require('../constants/roles.constants');

const roleId = (role) => Object.keys(CATALYST_ROLE_ID_MAP).find((id) => CATALYST_ROLE_ID_MAP[id] === role);
const dealerUser = { user_id: 'u1', role_details: { role_id: roleId(APP_ROLES.DEALER) } };

function harness(t, { mapped = true } = {}) {
  const db = createInMemoryZcql({
    dealer_user_mapping: mapped ? [{ catalyst_user_id: 'u1', dealer_code: 'AU001' }] : [],
    leads: [{ crm_record_id: 'Z1', dealer_code: 'AU001', customer_name: 'Test customer', lead_status: 'Not Contacted' }],
  });
  const writes = { oem: [], notifications: [], scenarios: [] };
  t.mock.method(require('../services/zohoCrmService'), 'updateOemLead', async (...args) => { writes.oem.push(args); });
  t.mock.method(require('../services/notificationService'), 'notifyAdmins', async (...args) => { writes.notifications.push(args); });
  t.mock.method(require('../services/integrations/crmIntegrationService'), 'recordScenario', async (...args) => { writes.scenarios.push(args); });
  const modulePath = require.resolve('../routes/dealerLeadRoutes');
  delete require.cache[modulePath];
  const router = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  const handler = router.stack.find((entry) => entry.route?.path === '/dealer/leads/:rowId').route.stack.at(-1).handle;
  async function patch(user, body) {
    const res = {
      locals: { catalystApp: db.app, currentUser: user },
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    await handler({ params: { rowId: '1000' }, body }, res);
    return res;
  }
  return { db, writes, patch };
}

const deniedUsers = [
  ['View User', { ...dealerUser, role_details: { role_id: roleId(APP_ROLES.VIEW_USER) } }],
  ['Admin', { ...dealerUser, role_details: { role_id: roleId(APP_ROLES.ADMIN) } }],
  ['Super Admin', { ...dealerUser, role_details: { role_id: roleId(APP_ROLES.SUPER_ADMIN) } }],
  ['unknown role with a stale Dealer name', { ...dealerUser, role_details: { role_id: 'retired-role-id', role_name: 'Dealer' } }],
  ['removed role', { user_id: 'u1' }],
  ['anonymous session', null],
];

for (const [name, user] of deniedUsers) {
  for (const mapped of [true, false]) {
    test(`${name}, ${mapped ? 'with retained' : 'without'} dealer mapping, cannot mutate leads`, async (t) => {
      const h = harness(t, { mapped });
      const originalLead = { ...h.db.tables.leads[0] };
      for (const body of [{ next_followup_date: '2026-10-15' }, { lead_status: 'Contacted' }]) {
        const res = await h.patch(user, body);
        assert.equal(res.statusCode, user ? 403 : 401);
      }
      assert.deepEqual(h.db.tables.leads[0], originalLead);
      assert.deepEqual(h.writes, { oem: [], notifications: [], scenarios: [] });
      assert.equal(h.db.queries.length, 0, 'authorization fails before reading a retained mapping');
    });
  }
}

test('current Dealer with owned lead can update follow-up and status', async (t) => {
  const h = harness(t);
  assert.equal((await h.patch(dealerUser, { next_followup_date: '2026-10-15' })).statusCode, 200);
  assert.equal(h.db.tables.leads[0].next_followup_date, '2026-10-15');
  assert.equal(h.writes.oem.length, 0);
  assert.equal((await h.patch(dealerUser, { lead_status: 'Contacted' })).statusCode, 200);
  assert.deepEqual(h.writes.oem, [['Z1', { Lead_Status: 'Contacted' }]]);
  assert.equal(h.db.tables.leads[0].lead_status, 'Contacted');
  assert.equal(h.writes.notifications.length, 2);
});

test('current Dealer without a mapping cannot mutate a lead', async (t) => {
  const h = harness(t, { mapped: false });
  assert.equal((await h.patch(dealerUser, { lead_status: 'Contacted' })).statusCode, 403);
  assert.deepEqual(h.writes, { oem: [], notifications: [], scenarios: [] });
});

test('current Dealer cannot mutate a lead belonging to another dealer', async (t) => {
  const h = harness(t);
  h.db.tables.leads[0].dealer_code = 'AU002';
  assert.equal((await h.patch(dealerUser, { lead_status: 'Contacted' })).statusCode, 404);
  assert.deepEqual(h.writes, { oem: [], notifications: [], scenarios: [] });
});
