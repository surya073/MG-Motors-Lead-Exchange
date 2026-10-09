'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = 'route-test-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const axios = require('axios');
const catalyst = require('zcatalyst-sdk-node');
const zohoAuthService = require('../services/zohoAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');

// Wiring test for POST /webhooks/crm-notify: a Leads notification that names
// record ids must fetch only those ids; one without ids must use the
// modified-since sweep. Neither may fall back to a full OEM lead scan.

function fakeCatalystApp() {
  return {
    zcql: () => ({ executeZCQLQuery: async () => [] }),
    datastore: () => ({
      table: () => ({
        insertRow: async (f) => ({ ROWID: 'r1', ...f }),
        updateRow: async (f) => f,
        deleteRow: async () => {},
      }),
    }),
  };
}

async function post(server, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/webhooks/crm-notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

function startServer() {
  const webhookRoutes = require('../routes/webhookRoutes');
  const app = express();
  app.use(webhookRoutes);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('Leads notification with ids fetches only those ids; without ids uses the modified-since sweep', async (t) => {
  zohoAuthService._resetForTests();
  t.mock.method(catalyst, 'initialize', () => fakeCatalystApp());
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  const gets = [];
  t.mock.method(axios, 'get', async (url, config) => {
    gets.push(config);
    return { data: { data: [], info: { more_records: false } } };
  });

  const server = await startServer();
  t.after(() => server.close());

  const withIds = await post(server, { token: 'route-test-token', module: 'Leads', ids: ['111', '222'], operation: 'update' });
  assert.equal(withIds.status, 200);
  assert.equal(gets.length, 1);
  assert.equal(gets[0].params.ids, '111,222');
  assert.equal(gets[0].params.page, undefined);

  const withoutIds = await post(server, { token: 'route-test-token', module: 'Leads' });
  assert.equal(withoutIds.status, 200);
  assert.equal(gets.length, 2);
  assert.ok(gets[1].headers['If-Modified-Since'], 'falls back to the modified-since sweep, not a full fetch');
  assert.equal(gets[1].params.ids, undefined);
});

test('a webhook with a wrong token is rejected before any sync work', async (t) => {
  t.mock.method(catalyst, 'initialize', () => fakeCatalystApp());
  const gets = [];
  t.mock.method(axios, 'get', async (url, config) => { gets.push(config); return { data: { data: [] } }; });

  const server = await startServer();
  t.after(() => server.close());

  const response = await post(server, { token: 'wrong', module: 'Leads', ids: ['111'] });
  assert.equal(response.status, 401);
  assert.equal(gets.length, 0);
});
