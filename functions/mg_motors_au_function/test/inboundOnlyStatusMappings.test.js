'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const catalyst = require('zcatalyst-sdk-node');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { ADMIN_ROLE_ID } = require('../middleware/requireAdminRole');
const routes = require('../routes/dealerCrmIntegrationRoutes');
const pathPolicy = require('../services/integrations/pathPolicyService');
const { mapStatus } = require('../services/integrations/leadMappingService');

// A dealer status can be accepted INBOUND without ever being sent OUTBOUND:
// Fusion "Won" -> MG "Contacted" must not also send MG "Contacted" to Fusion as "Won".

const FIELDS = pathPolicy.REQUIRED_DELIVERY_MAPPING_FIELDS.map((f) => ({
  source_field: f, target_field: `t_${f}`, data_type: 'string', required: true,
}));

function setup(t) {
  const db = createInMemoryZcql({
    dealers: [{ dealer_code: '568026', dealer_name: 'Fusion Dealer' }],
    dealer_integrations: [{ ROWID: '1000', dealer_code: '568026', integration_type: 'EXTERNAL_CRM', crm_type: 'FUSION_SD' }],
    integration_status_mappings: [],
    integration_field_mappings: [],
  });
  t.mock.method(catalyst, 'initialize', () => db.app);
  return db;
}

async function call(t, method, body) {
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => {
    res.locals.currentUser = { email_id: 'a@example.com', role_details: { role_id: ADMIN_ROLE_ID } };
    next();
  });
  server.use(routes);
  const listener = await new Promise((resolve) => {
    const l = server.listen(0, '127.0.0.1', () => resolve(l));
  });
  t.after(() => listener.close());
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/568026/integration/mappings`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

const save = (t, statusMappings) => call(t, 'PUT', { fieldMappings: FIELDS, statusMappings });
const rowsOf = (db) => db.tables.integration_status_mappings.filter((r) => !r.__deleted);
const MAPPINGS = [
  { source_status: 'Not Contacted', target_status: 'Open' },
  { source_status: 'Lost', target_status: 'Lost' },
  { source_status: 'Contacted', target_status: 'Won', inbound_only: true },
  { source_status: 'Contact in Future', target_status: 'Delivered', inbound_only: true },
];

test('an inbound-only row writes only the dealer -> MG row', async (t) => {
  const db = setup(t);
  const result = await save(t, MAPPINGS);
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const rows = rowsOf(db);
  assert.equal(rows.length, 6, '2 two-way pairs (4 rows) + 2 inbound-only rows');
  assert.equal(rows.filter((r) => r.direction === 'ZOHO_TO_EXTERNAL' && r.source_status === 'Contacted').length, 0, 'MG Contacted is never sent out');
  assert.equal(rows.filter((r) => r.direction === 'ZOHO_TO_EXTERNAL' && r.source_status === 'Contact in Future').length, 0);
  assert.ok(rows.some((r) => r.direction === 'EXTERNAL_TO_ZOHO' && r.source_status === 'Won' && r.target_status === 'Contacted'));
  assert.ok(rows.some((r) => r.direction === 'EXTERNAL_TO_ZOHO' && r.source_status === 'Delivered' && r.target_status === 'Contact in Future'));
});

test('mapping behaviour: Won/Delivered accepted inbound; Contacted/Contact in Future not sent outbound; two-way rows unchanged', async (t) => {
  const db = setup(t);
  await save(t, MAPPINGS);
  const rows = rowsOf(db);

  assert.equal(mapStatus('Won', rows, 'EXTERNAL_TO_ZOHO'), 'Contacted');
  assert.equal(mapStatus('Delivered', rows, 'EXTERNAL_TO_ZOHO'), 'Contact in Future');
  assert.equal(mapStatus('Open', rows, 'EXTERNAL_TO_ZOHO'), 'Not Contacted');
  assert.equal(mapStatus('Not Contacted', rows, 'ZOHO_TO_EXTERNAL'), 'Open');
  assert.equal(mapStatus('Lost', rows, 'ZOHO_TO_EXTERNAL'), 'Lost');
  for (const mg of ['Contacted', 'Contact in Future']) {
    assert.throws(() => mapStatus(mg, rows, 'ZOHO_TO_EXTERNAL'), (err) => err.code === 'STATUS_MAPPING_NOT_FOUND', mg);
  }
});

test('reading back shows inbound-only rows flagged, in the editor orientation, with no cleanup warning', async (t) => {
  setup(t);
  await save(t, MAPPINGS);
  const result = await call(t, 'GET');

  assert.equal(result.status, 200);
  const view = result.body.statusMappings;
  assert.equal(view.length, 4);
  const won = view.find((m) => m.target_status === 'Won');
  assert.deepEqual([won.source_status, won.inbound_only], ['Contacted', true]);
  assert.equal(view.find((m) => m.target_status === 'Open').inbound_only, undefined, 'two-way rows are not flagged');
  assert.equal(result.body.statusMappingCleanupRequired, false);
});

test('saving what was read back is stable, and switching two-way <-> inbound-only works both ways', async (t) => {
  const db = setup(t);
  await save(t, MAPPINGS);
  const first = (await call(t, 'GET')).body.statusMappings;
  const before = rowsOf(db).length;
  await save(t, first);
  assert.equal(rowsOf(db).length, before);

  // inbound-only -> two-way: the outbound row appears
  const twoWay = first.map((m) => (m.target_status === 'Won' ? { ...m, inbound_only: false } : m));
  await save(t, twoWay);
  assert.equal(rowsOf(db).filter((r) => r.direction === 'ZOHO_TO_EXTERNAL' && r.source_status === 'Contacted').length, 1);

  // two-way -> inbound-only: the outbound row is removed again
  await save(t, twoWay.map((m) => (m.target_status === 'Won' ? { ...m, inbound_only: true } : m)));
  assert.equal(rowsOf(db).filter((r) => r.direction === 'ZOHO_TO_EXTERNAL' && r.source_status === 'Contacted').length, 0);
  assert.equal(mapStatus('Won', rowsOf(db), 'EXTERNAL_TO_ZOHO'), 'Contacted');
});

test('an inbound-only row may share an MG status with a two-way row; two dealer statuses cannot claim different MG statuses', async (t) => {
  setup(t);
  const shared = await save(t, [
    { source_status: 'Contacted', target_status: 'Contacted' },
    { source_status: 'Contacted', target_status: 'Won', inbound_only: true },
  ]);
  assert.equal(shared.status, 200, JSON.stringify(shared.body));

  setup(t);
  const clash = await save(t, [
    { source_status: 'Contacted', target_status: 'Won', inbound_only: true },
    { source_status: 'Lost', target_status: 'Won', inbound_only: true },
  ]);
  assert.equal(clash.status, 400);
  assert.equal(clash.body.error, 'STATUS_MAPPING_AMBIGUOUS');
});
