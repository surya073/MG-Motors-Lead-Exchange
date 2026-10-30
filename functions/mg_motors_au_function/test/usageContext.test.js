'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = 'usage-notify-token';

// COST_OPTIMIZATION_PLAN.md, Batch 1: every request writes one `[usage]` line
// with what it cost. These tests prove the counts equal the operations an
// in-memory Data Store actually received, that counting changes no result or
// error, and that the line carries no secret or customer data.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const axios = require('axios');
const catalyst = require('zcatalyst-sdk-node');
const usageContext = require('../services/usageContext');
const zohoAuthService = require('../services/zohoAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');

// Wraps the in-memory app with its own independent tally: the ground truth
// the usage counters are compared against.
function talliedApp(seed = {}) {
  // Any table the code under test touches exists, empty unless seeded.
  const tables = new Proxy(seed, {
    get: (target, name) => (typeof name === 'string' ? (target[name] = target[name] || []) : target[name]),
  });
  const store = createInMemoryZcql(tables);
  const truth = { fetch: 0, fetchRows: 0, insert: 0, update: 0, delete: 0 };
  const app = {
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        truth.fetch += 1;
        const rows = await store.app.zcql().executeZCQLQuery(sql);
        truth.fetchRows += rows.length;
        return rows;
      },
    }),
    datastore: () => ({
      table: (name) => {
        const table = store.app.datastore().table(name);
        return {
          getRow: async (id) => {
            truth.fetch += 1;
            const row = await table.getRow(id);
            truth.fetchRows += row ? 1 : 0;
            return row;
          },
          insertRow: async (fields) => { truth.insert += 1; return table.insertRow(fields); },
          updateRow: async (fields) => { truth.update += 1; return table.updateRow(fields); },
          deleteRow: async (id) => { truth.delete += 1; return table.deleteRow(id); },
        };
      },
    }),
    userManagement: () => ({ marker: 'passed-through' }),
  };
  return { app, truth, store };
}

function captureLogs(t) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => { lines.push(args.join(' ')); });
  t.mock.method(console, 'error', (...args) => { lines.push(args.join(' ')); });
  return lines;
}

function usageLines(lines) {
  return lines
    .filter((line) => line.includes('[usage] '))
    .map((line) => JSON.parse(line.slice(line.indexOf('[usage] ') + 8).trim()));
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function post(server, path, body, headers = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function withUsageLog(t, value) {
  const before = process.env.USAGE_LOG;
  if (value === null) delete process.env.USAGE_LOG; else process.env.USAGE_LOG = value;
  t.after(() => { if (before === undefined) delete process.env.USAGE_LOG; else process.env.USAGE_LOG = before; });
}

test('USAGE_LOG is on unless set to false', (t) => {
  const { isUsageLogEnabled } = require('../config/env');
  for (const value of [null, '', 'true', 'yes', '1']) {
    withUsageLog(t, value);
    assert.equal(isUsageLogEnabled(), true, String(value));
  }
  for (const value of ['false', ' FALSE ']) {
    withUsageLog(t, value);
    assert.equal(isUsageLogEnabled(), false, value);
  }
});

test('counts equal the reads and writes the Data Store received', async () => {
  const { app, truth } = talliedApp({ leads: [{ crm_id: 'a' }, { crm_id: 'b' }] });
  await usageContext.runWithContext({}, async (ctx) => {
    const counted = usageContext.instrument(app);
    await counted.zcql().executeZCQLQuery('SELECT * FROM leads');
    await counted.zcql().executeZCQLQuery("SELECT * FROM leads WHERE crm_id = 'a'");
    const leads = counted.datastore().table('leads');
    await leads.getRow('1000');
    await leads.getRow('1099'); // missing: one fetch, no row
    const inserted = await leads.insertRow({ crm_id: 'c' });
    await leads.updateRow({ ROWID: inserted.ROWID, crm_id: 'c2' });
    await counted.datastore().table('leads').deleteRow(inserted.ROWID);

    assert.deepEqual(ctx.ds, truth);
    assert.deepEqual(ctx.ds, { fetch: 4, fetchRows: 4, insert: 1, update: 1, delete: 1 });
  });
});

test('the wrapper returns the same values and throws the same errors', async () => {
  const failure = Object.assign(new Error('ZCQL boom'), { code: 'X' });
  const rows = [{ leads: { ROWID: '1' } }];
  const raw = {
    zcql: () => ({ executeZCQLQuery: async (sql) => { if (sql === 'bad') throw failure; return rows; } }),
    datastore: () => ({
      table: () => ({
        insertRow: async (f) => ({ ROWID: '9', ...f }),
        updateRow: () => Promise.reject(failure),
        tableName: 'leads',
      }),
    }),
    userManagement: () => 'user-management',
  };
  await usageContext.runWithContext({}, async (ctx) => {
    const counted = usageContext.instrument(raw);
    assert.equal(await counted.zcql().executeZCQLQuery('ok'), rows, 'same array, not a copy');
    await assert.rejects(counted.zcql().executeZCQLQuery('bad'), (err) => err === failure);
    assert.deepEqual(await counted.datastore().table('leads').insertRow({ a: 1 }), { ROWID: '9', a: 1 });
    await assert.rejects(counted.datastore().table('leads').updateRow({ ROWID: '9' }), (err) => err === failure);
    assert.equal(counted.datastore().table('leads').tableName, 'leads');
    assert.equal(counted.userManagement(), 'user-management');
    // A failed call still counts: the request was made.
    assert.deepEqual(ctx.ds, { fetch: 2, fetchRows: 1, insert: 1, update: 1, delete: 0 });
  });
});

test('outside a request nothing is wrapped or counted', async () => {
  const raw = { zcql: () => ({ executeZCQLQuery: async () => [] }) };
  assert.equal(usageContext.instrument(raw), raw);
  assert.equal(usageContext.currentCid(), null);
  usageContext.countToken('refresh');
  assert.deepEqual(await usageContext.trackApiCall('mg', async () => ({ data: 1 })), { data: 1 });
});

test('CRM calls count per org; a credits header is kept, an absent one stays unknown', async () => {
  const failure = Object.assign(new Error('503'), { response: { status: 503, headers: { 'x-api-credits-remaining': '41' } } });
  await usageContext.runWithContext({}, async (ctx) => {
    const ok = { data: 1, headers: { 'x-api-credits-remaining': '4999' } };
    assert.equal(await usageContext.trackApiCall('mg', async () => ok), ok);
    await usageContext.trackApiCall('mg', async () => ({ data: 2, headers: {} }));
    await assert.rejects(usageContext.trackApiCall('AU008', async () => { throw failure; }), (err) => err === failure);
    await usageContext.trackApiCall('725001', async () => ({ data: 3 }));
    assert.deepEqual(ctx.api, { mg: 2, AU008: 1, 725001: 1 });
    assert.deepEqual(ctx.credits, { mg: 4999, AU008: 41 }, 'no entry for 725001: unknown, not zero');
  });
});

test('MG token: one refresh, then cache hits', async (t) => {
  zohoAuthService._resetForTests();
  t.after(() => zohoAuthService._resetForTests());
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'secret-access-123', expires_in: 3600 } }));
  await usageContext.runWithContext({}, async (ctx) => {
    await zohoAuthService.getAccessToken();
    await zohoAuthService.getAccessToken();
    await zohoAuthService.getAccessToken();
    assert.deepEqual(ctx.token, { refresh: 1, hit: 2 });
  });
});

test('fast-recover stages: Data Store work is attributed to the stage that did it', async () => {
  const { app } = talliedApp({ leads: [{ crm_id: 'a' }] });
  await usageContext.runWithContext({}, async (ctx) => {
    const counted = usageContext.instrument(app);
    usageContext.setStage('slaCheck');
    await counted.zcql().executeZCQLQuery('SELECT * FROM leads');
    await counted.datastore().table('leads').insertRow({ crm_id: 'b' });
    usageContext.setStage('outbound');
    await counted.zcql().executeZCQLQuery('SELECT * FROM leads');
    usageContext.setStage(null);
    await counted.zcql().executeZCQLQuery('SELECT * FROM leads');
    assert.equal(ctx.ds.fetch, 3);
    assert.deepEqual(ctx.stages.slaCheck, { fetch: 1, fetchRows: 1, insert: 1, update: 0, delete: 0 });
    assert.deepEqual(ctx.stages.outbound, { fetch: 1, fetchRows: 2, insert: 0, update: 0, delete: 0 });
  });
});

function crmNotifyApp() {
  const webhookRoutes = require('../routes/webhookRoutes');
  const app = express();
  app.use(usageContext.middleware);
  app.use(webhookRoutes);
  return app;
}

function mockMgCrm(t, leads) {
  zohoAuthService._resetForTests();
  t.after(() => zohoAuthService._resetForTests());
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'secret-access-123', expires_in: 3600 } }));
  t.mock.method(axios, 'get', async () => ({
    data: { data: leads, info: { more_records: false } },
    headers: { 'x-api-credits-remaining': '12345' },
  }));
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
}

test('crm-notify: one usage line whose counts match the Data Store, with the sync result', async (t) => {
  withUsageLog(t, null);
  const { app: fake, truth } = talliedApp();
  t.mock.method(catalyst, 'initialize', () => fake);
  mockMgCrm(t, []);
  const lines = captureLogs(t);
  const server = await listen(crmNotifyApp());
  t.after(() => server.close());

  const response = await post(server, '/webhooks/crm-notify',
    { token: 'usage-notify-token', module: 'Leads', ids: ['111', '222'], operation: 'update' });
  assert.equal(response.status, 200);
  await new Promise((resolve) => setImmediate(resolve));

  const usage = usageLines(lines);
  assert.equal(usage.length, 1, 'exactly one usage line per request');
  const [line] = usage;
  assert.equal(line.route, '/webhooks/crm-notify');
  assert.equal(line.trigger, 'Zoho CRM');
  assert.equal(line.status, 200);
  assert.deepEqual(line.ds, truth, 'counted ops equal what the Data Store received');
  assert.deepEqual(line.api, { mg: 1 }, 'the MG CRM read is counted through express.json');
  assert.deepEqual(line.credits, { mg: 12345 });
  assert.deepEqual(line.token, { refresh: 1, hit: 0 });
  assert.equal(line.module, 'Leads');
  assert.equal(line.operation, 'update');
  assert.equal(line.ids, 2);
  assert.equal(line.outcome, 'unchanged');
  assert.equal(line.result.inserted, 0);
  assert.match(line.cid, /^[0-9a-f-]{36}$/);
  assert.equal(typeof line.ms, 'number');

  // Every other line this request logged carries the same id.
  const others = lines.filter((l) => l.includes('[INFO]') && !l.includes('[usage] '));
  assert.ok(others.length > 0);
  for (const other of others) assert.ok(other.includes(`[cid=${line.cid}]`), other);
});

test('crm-notify: a new lead is counted exactly and the line carries no secret or customer data', async (t) => {
  withUsageLog(t, null);
  const { app: fake, truth } = talliedApp();
  t.mock.method(catalyst, 'initialize', () => fake);
  mockMgCrm(t, [{
    id: '777', First_Name: 'Jane', Last_Name: 'Citizen', Email: 'jane.citizen@example.com',
    Phone: '0412999888', Franchise_Code: 'AU008', Created_Time: '2026-10-20T10:00:00+10:00',
  }]);
  const lines = captureLogs(t);
  const server = await listen(crmNotifyApp());
  t.after(() => server.close());

  await post(server, '/webhooks/crm-notify',
    { token: 'usage-notify-token', module: 'Leads', ids: ['777'], operation: 'insert' },
    { authorization: 'Zoho-oauthtoken header-secret-456' });
  await new Promise((resolve) => setImmediate(resolve));

  const raw = lines.find((l) => l.includes('[usage] '));
  assert.ok(raw, 'usage line written');
  const [line] = usageLines(lines);
  assert.equal(line.status, 200);
  assert.equal(line.outcome, 'changed');
  assert.equal(line.result.inserted, 1);
  assert.ok(line.ds.insert > 0, 'the insert path ran');
  assert.deepEqual(line.ds, truth, 'counted ops equal what the Data Store received');
  for (const secret of ['usage-notify-token', 'secret-access-123', 'header-secret-456',
    'test-client-secret', 'test-refresh-token', 'jane.citizen', 'Citizen', '0412999888']) {
    assert.ok(!raw.includes(secret), `usage line leaks ${secret}`);
  }
});

test('USAGE_LOG=false: no usage line, no id prefix, the app is not wrapped', async (t) => {
  withUsageLog(t, 'false');
  const { app: fake } = talliedApp();
  const seen = [];
  t.mock.method(catalyst, 'initialize', () => fake);
  mockMgCrm(t, []);
  const lines = captureLogs(t);
  const app = express();
  app.use(usageContext.middleware);
  app.post('/probe', express.json(), (req, res) => {
    seen.push(usageContext.initialize(catalyst, req));
    res.json({ ok: true });
  });
  const server = await listen(app);
  t.after(() => server.close());

  assert.equal((await post(server, '/probe', {})).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen[0], fake);
  assert.equal(usageLines(lines).length, 0);
  assert.ok(lines.every((l) => !l.includes('[cid=')));
});

test('route label uses the route pattern, not the ids in the URL; one line even if the client disconnects', async (t) => {
  withUsageLog(t, null);
  const { app: fake } = talliedApp({ leads: [{ crm_id: 'a' }] });
  t.mock.method(catalyst, 'initialize', () => fake);
  const lines = captureLogs(t);
  const app = express();
  app.use(usageContext.middleware);
  app.post('/webhooks/dealers/:dealerCode', express.raw({ type: 'application/json' }), async (req, res) => {
    const catalystApp = usageContext.initialize(catalyst, req);
    await catalystApp.zcql().executeZCQLQuery('SELECT * FROM leads');
    res.status(202).json({ ok: true });
  });
  const server = await listen(app);
  t.after(() => server.close());

  assert.equal((await post(server, '/webhooks/dealers/AU008', { lead_id: 'x' })).status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  const usage = usageLines(lines);
  assert.equal(usage.length, 1);
  assert.equal(usage[0].route, '/webhooks/dealers/:dealerCode');
  assert.equal(usage[0].trigger, 'webhook');
  assert.equal(usage[0].ds.fetch, 1);
});
