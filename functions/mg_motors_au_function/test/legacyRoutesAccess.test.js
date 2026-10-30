'use strict';

// The legacy inline /dealers and /leads CRUD in index.js (pre-dating the
// route-module split, on their own old tables) was removed on 27 Oct 2026:
// the portal never called it and live logs showed no calls in 3 days. These
// tests pin that the paths are gone and that the session check in front of
// every portal route still applies.

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) {
  process.env[key] = `test-${key}`;
}
process.env.ZOHO_API_DOMAIN = 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = 'https://accounts.zoho.in';

const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('zcatalyst-sdk-node');
const app = require('../index');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');

async function harness(t, role) {
  const calls = [];
  const catalystApp = {
    userManagement: () => ({ getCurrentUser: async () => (role === null ? null : { role_details: { role_id: role } }) }),
    datastore: () => ({ table: (name) => new Proxy({}, { get: (_target, op) => async () => { calls.push([op, name]); return {}; } }) }),
    zcql: () => ({ executeZCQLQuery: async (sql) => { calls.push(['zcql', sql]); return []; } }),
  };
  t.mock.method(sdk, 'initialize', () => catalystApp);
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
  t.after(() => listener.close());
  return {
    calls,
    request: async (path, method = 'GET') => {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}${path}`, {
        method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}',
      });
      return { status: response.status };
    },
  };
}

const REMOVED = [
  ['GET', '/dealers'], ['GET', '/dealers/dealer-1'], ['POST', '/dealers'], ['PUT', '/dealers/dealer-1'],
  ['POST', '/dealers/dealer-1/regenerate-key'], ['DELETE', '/dealers/dealer-1'],
  ['GET', '/leads'], ['GET', '/leads/lead-1'], ['POST', '/leads'], ['POST', '/leads/lead-1/deliver'], ['DELETE', '/leads/lead-1'],
];

test('removed legacy /dealers and /leads routes return 404 for an admin and touch no data', async (t) => {
  const h = await harness(t, ADMIN_ROLE_ID);
  for (const [method, path] of REMOVED) assert.equal((await h.request(path, method)).status, 404, `${method} ${path}`);
  assert.deepEqual(h.calls, []);
});

test('portal paths still require a session', async (t) => {
  const h = await harness(t, null);
  assert.equal((await h.request('/leads')).status, 401);
  assert.equal((await h.request('/sync/dealers', 'POST')).status, 401);
  assert.deepEqual(h.calls, []);
});
