'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) {
  process.env[key] = `test-${key}`;
}
process.env.ZOHO_API_DOMAIN = 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = 'https://accounts.zoho.in';

const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('zcatalyst-sdk-node');
const axios = require('axios');
const { Readable } = require('node:stream');
const app = require('../index');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const { VIEW_USER_ROLE_ID } = require('../middleware/requireAdminOrViewRole');

async function harness(t, initialRole) {
  let role = initialRole;
  const calls = [];
  const dealer = { ROWID: 'dealer-1', Name: 'Test Dealer', APIKey: 'test-private-key', APIEndpoint: 'https://127.0.0.1/leads' };
  const lead = { ROWID: 'lead-1', DealerID: dealer.ROWID, CustomerName: 'Test Customer', AttemptCount: 0 };
  const catalystApp = {
    userManagement: () => ({ getCurrentUser: async () => role === null ? null : { role_details: { role_id: role } } }),
    datastore: () => ({ table: (name) => ({
      getPagedRows: async () => {
        calls.push(['read', name]);
        return { data: [name === '37148000000425015' ? dealer : lead], more_records: false };
      },
      getRow: async () => { calls.push(['read', name]); return name === '37148000000425015' ? dealer : lead; },
      insertRow: async (row) => { calls.push(['insert', name, row]); return { ROWID: 'new', ...row }; },
      updateRow: async (row) => { calls.push(['update', name, row]); return row; },
      deleteRow: async () => { calls.push(['delete', name]); },
    }) }),
  };
  t.mock.method(sdk, 'initialize', () => catalystApp);
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  t.after(() => listener.close());
  return {
    calls,
    setRole: (next) => { role = next; },
    setEndpoint: (next) => { dealer.APIEndpoint = next; },
    request: async (path, method = 'GET', body) => {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

const readRoutes = ['/dealers', '/dealers/dealer-1', '/leads', '/leads/lead-1'];
const writeRoutes = [
  ['POST', '/dealers'], ['PUT', '/dealers/dealer-1'], ['POST', '/dealers/dealer-1/regenerate-key'],
  ['DELETE', '/dealers/dealer-1'], ['POST', '/leads'], ['POST', '/leads/lead-1/deliver'], ['DELETE', '/leads/lead-1'],
];

test('legacy reads and mutations reject dealer/unknown roles before any datastore access', async (t) => {
  const h = await harness(t, '37148000000430005');
  for (const role of ['37148000000430005', 'unknown']) {
    h.setRole(role);
    for (const path of readRoutes) assert.equal((await h.request(path)).status, 403, path);
    for (const [method, path] of writeRoutes) assert.equal((await h.request(path, method, {})).status, 403, path);
  }
  assert.equal(h.calls.length, 0);
});

test('legacy delivery closes the dealer response after headers and handles success/error status without reading its body', async (t) => {
  const h = await harness(t, ADMIN_ROLE_ID);
  h.setEndpoint('https://8.8.8.8/leads');
  const streams = [];
  t.mock.method(axios, 'post', async (_url, _body, options) => {
    assert.equal(options.responseType, 'stream', 'do not buffer a dealer response');
    const stream = new Readable({ read() { throw new Error('response body must not be read'); } });
    streams.push(stream);
    return { status: streams.length === 1 ? 201 : 503, data: stream };
  });
  const success = await h.request('/leads/lead-1/deliver', 'POST', {});
  const failure = await h.request('/leads/lead-1/deliver', 'POST', {});
  assert.equal(success.body.attemptResult.result, 'success');
  assert.equal(failure.body.attemptResult.result, 'failed');
  assert.ok(streams.every((stream) => stream.destroyed));
});

test('legacy dealer edits cannot change ROWID or overwrite its secret through ordinary PUT', async (t) => {
  const h = await harness(t, ADMIN_ROLE_ID);
  const response = await h.request('/dealers/dealer-1', 'PUT', {
    ROWID: 'foreign-dealer', APIKey: 'caller-supplied-key', Name: 'Updated dealer',
  });
  assert.equal(response.status, 200);
  const update = h.calls.find(([operation]) => operation === 'update')[2];
  assert.equal(update.ROWID, 'dealer-1');
  assert.equal(update.Name, 'Updated dealer');
  assert.equal(update.APIKey, undefined);
});

test('legacy view role can read without receiving dealer keys and cannot mutate', async (t) => {
  const h = await harness(t, VIEW_USER_ROLE_ID);
  for (const path of readRoutes) {
    const response = await h.request(path);
    assert.equal(response.status, 200, path);
    assert.equal(JSON.stringify(response.body).includes('test-private-key'), false, path);
  }
  const before = h.calls.length;
  for (const [method, path] of writeRoutes) assert.equal((await h.request(path, method, {})).status, 403, path);
  assert.equal(h.calls.length, before);
});

test('legacy anonymous requests require a session', async (t) => {
  const h = await harness(t, null);
  assert.equal((await h.request('/leads')).status, 401);
  assert.equal((await h.request('/dealers', 'POST', {})).status, 401);
  assert.equal(h.calls.length, 0);
});

test('legacy admin can generate a random key; private delivery destinations never receive credentials', async (t) => {
  const h = await harness(t, ADMIN_ROLE_ID);
  const one = await h.request('/dealers/dealer-1/regenerate-key', 'POST', {});
  const two = await h.request('/dealers/dealer-1/regenerate-key', 'POST', {});
  assert.equal(one.status, 200);
  assert.match(one.body.dealer.APIKey, /^[0-9a-f]{64}$/);
  assert.notEqual(one.body.dealer.APIKey, two.body.dealer.APIKey);
  let sent = false;
  t.mock.method(axios, 'post', async () => { sent = true; throw new Error('must not send'); });
  const delivery = await h.request('/leads/lead-1/deliver', 'POST', {});
  assert.equal(delivery.status, 200);
  assert.equal(delivery.body.attemptResult.result, 'failed');
  assert.equal(sent, false);
});
