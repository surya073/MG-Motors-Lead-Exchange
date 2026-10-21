'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { adminSuggestions, dealerSuggestions } = require('../services/searchSuggestionsService');
const adminRoutes = require('../routes/adminDashboardRoutes');
const dealerRoutes = require('../routes/dealerLeadRoutes');

const dealers = [
  { dealer_code: 'AU001', dealer_name: 'Melbourne North', city: 'Melbourne', state: 'VIC', region: 'South' },
  { dealer_code: 'AU002', dealer_name: "O'Brien Sydney", city: 'Sydney', state: 'NSW', region: 'East' },
];
const leads = [
  { customer_name: 'Alice Brown', vehicle_model: 'MG4', dealer_code: 'AU001', email_address: 'alice@example.com' },
  { customer_name: 'Alice West', vehicle_model: 'MG3', dealer_code: 'AU002', mobile_number: '0412999000' },
  { customer_name: 'Bob Smith', vehicle_model: 'MG4', dealer_code: 'AU001', mobile_number: '0412000001' },
  { customer_name: "O'Brien Customer", vehicle_model: 'HS', dealer_code: 'AU002' },
  { customer_name: 'Unmapped Customer', vehicle_model: 'ZS', dealer_code: 'MISSING' },
  { customer_name: 'Unassigned Customer', vehicle_model: 'MG4', dealer_code: null },
];
const tokens = (query) => query.trim().toLowerCase().split(/\s+/);
const matches = (values, query) => tokens(query).every((token) => values.map((value) => value ?? '').join(' ').toLowerCase().includes(token));

test('admin suggestions preserve case-insensitive tokens across customer, dealer name/code, vehicle and contact fields', async () => {
  for (const query of ['ALICE MELBOURNE', 'Alice AU002', 'MG4 alice@example', 'Bob 0001', "O'Brien Sydney", 'unknown MG4', 'UNKNOWN Unmapped', 'south melbourne']) {
    const db = createInMemoryZcql({ dealers: dealers.map((row) => ({ ...row })), leads: leads.map((row) => ({ ...row })) });
    const names = new Map(dealers.map((dealer) => [dealer.dealer_code, dealer.dealer_name]));
    const result = await adminSuggestions(db.app, query);
    const expected = leads.filter((lead) => matches([
      lead.customer_name, lead.email_address, lead.mobile_number, lead.vehicle_model,
      names.get(lead.dealer_code) || 'Unknown', lead.dealer_code,
    ], query)).slice(0, 5);
    assert.deepEqual(result.leads.map((row) => row.customer_name), expected.map((row) => row.customer_name), query);
    const expectedDealers = dealers.filter((dealer) => matches(
      [dealer.dealer_name, dealer.dealer_code, dealer.city, dealer.state, dealer.region], query
    )).slice(0, 4);
    assert.deepEqual(result.dealers.map((row) => row.dealer_code), expectedDealers.map((row) => row.dealer_code), query);
    assert.ok(db.queries.some((sql) => /FROM leads .*LIMIT 1, 5$/.test(sql)));
    assert.equal(db.queries.some((sql) => /COUNT\(|SELECT \* FROM leads|dealer_integrations/.test(sql)), false);
  }
});

test('suggestions read only five projected leads from a 650-lead match without counting or loading them all', async () => {
  const db = createInMemoryZcql({ dealers, leads: Array.from({ length: 650 }, (_, i) => ({ customer_name: `Alice ${i}`, dealer_code: 'AU001', dealer_remarks: 'Do not transfer' })) });
  const result = await adminSuggestions(db.app, 'Alice');
  assert.equal(result.leads.length, 5);
  assert.equal(result.leads.some((row) => 'dealer_remarks' in row), false);
  assert.equal(db.queries.filter((sql) => sql.includes('FROM leads')).length, 1);
  assert.equal(db.queries.length, 2, 'one lightweight directory query plus one bounded lead query');
});

test('directory paging stays complete and suggestions can find a dealer after the first 300 rows', async () => {
  const directory = Array.from({ length: 350 }, (_, i) => ({ dealer_code: `D${i}`, dealer_name: `Dealer ${i}`, city: 'Town' }));
  const db = createInMemoryZcql({ dealers: directory, leads: [{ customer_name: 'Jane', dealer_code: 'D349' }] });
  const result = await adminSuggestions(db.app, 'Jane 349');
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].dealer_name, 'Dealer 349');
  assert.deepEqual(db.queries.filter((sql) => sql.includes('FROM dealers')).map((sql) => Number(/LIMIT (\d+),/.exec(sql)[1])), [1, 301]);
});

test('dealer suggestions preserve dealer-code/multi-token matching and never read another dealer or directory', async () => {
  const db = createInMemoryZcql({ dealers, leads: leads.map((row) => ({ ...row })) });
  const result = await dealerSuggestions(db.app, 'AU001', 'Alice AU001');
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].customer_name, 'Alice Brown');
  assert.equal((await dealerSuggestions(db.app, 'AU001', 'Alice AU002')).leads.length, 0);
  assert.equal(db.queries.some((sql) => sql.includes('FROM dealers')), false);
  assert.ok(db.queries.every((sql) => sql.includes("dealer_code = 'AU001'")));
  await assert.rejects(dealerSuggestions(db.app, '', ''), (err) => err.statusCode === 403);
});

test('empty/one-character queries do no reads; long/over-complex/wildcard input is rejected explicitly', async () => {
  const db = createInMemoryZcql({ dealers, leads });
  for (const query of ['', 'a', undefined]) assert.deepEqual(await adminSuggestions(db.app, query), { leads: [], dealers: [] });
  for (const query of ['one two three four five six seven eight nine ten', 'x'.repeat(257), ['alice'], 'a*']) {
    await assert.rejects(adminSuggestions(db.app, query), (err) => err.statusCode === 400);
  }
  assert.equal(db.queries.length, 0);
});

test('nine tokens with dealer scope remain inside the tested ZCQL WHERE limit', async () => {
  const query = 'one two three four five six seven eight nine';
  const db = createInMemoryZcql({ leads: [{ customer_name: query, dealer_code: 'AU001' }] });
  assert.equal((await dealerSuggestions(db.app, 'AU001', query)).leads.length, 1);
});

test('dealer HTTP route ignores a client-supplied dealer code and requires an authenticated mapping', async () => {
  const db = createInMemoryZcql({ dealers, leads, dealer_user_mapping: [{ catalyst_user_id: 'u1', dealer_code: 'AU001' }] });
  const handler = dealerRoutes.stack.find((entry) => entry.route?.path === '/dealer/search-suggestions').route.stack.at(-1).handle;
  const res = { locals: { catalystApp: db.app, currentUser: { user_id: 'u1' } }, statusCode: 200,
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ query: { search: 'Alice', dealerCode: 'AU002' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.leads.map((row) => row.dealer_code), ['AU001']);
  res.locals.currentUser = { user_id: 'not-mapped' };
  await handler({ query: { search: 'Alice' } }, res);
  assert.equal(res.statusCode, 403);
  res.locals.currentUser = null;
  await handler({ query: { search: 'Alice' } }, res);
  assert.equal(res.statusCode, 401);
});

test('admin HTTP suggestions retain explicit role authorization', () => {
  const guard = adminRoutes.stack.find((entry) => entry.route?.path === '/admin/search-suggestions').route.stack[0].handle;
  for (const role_id of ['37148000000359008', '37148000000430003', '37148000000899033', '37148000000430005']) {
    let passed = false;
    const res = { locals: { currentUser: { role_details: { role_id } } },
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    guard({}, res, () => { passed = true; });
    assert.equal(passed, role_id !== '37148000000430005');
    if (!passed) assert.equal(res.statusCode, 403);
  }
});
