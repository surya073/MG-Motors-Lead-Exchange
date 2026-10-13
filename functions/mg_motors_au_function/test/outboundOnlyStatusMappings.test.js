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
const { mapStatus, isInboundOnlyStatus } = require('../services/integrations/leadMappingService');

// H2 / Q1: many MG statuses go out as one Fusion status (D1 sends Contacted,
// Contact in Future, Follow-up 1 ... as "Open"). An outbound-only row maps MG
// -> dealer without claiming the reverse, so it cannot make "Open" ambiguous
// coming back.

// Mirrors FUSION_DEFAULT_STATUS_MAPPINGS in mg-motor-web DealerCRMConfig.jsx
// (D1, extended to every MG status; answer to Q1, 13 Oct 2026).
const FUSION_D1_PRESET = [
  { source_status: 'Not Contacted', target_status: 'Open' },
  { source_status: 'Follow-up 1', target_status: 'Open', outbound_only: true },
  { source_status: 'Follow-up 2', target_status: 'Open', outbound_only: true },
  { source_status: 'Attempted to Contact', target_status: 'Open', outbound_only: true },
  { source_status: 'Contacted', target_status: 'Open', outbound_only: true },
  { source_status: 'Contact in Future', target_status: 'Open', outbound_only: true },
  { source_status: 'Pre-Qualified', target_status: 'Open', outbound_only: true },
  { source_status: 'Finance Intro', target_status: 'Open', outbound_only: true },
  { source_status: 'Not Qualified', target_status: 'Prospect Lost' },
  { source_status: 'Dropped', target_status: 'Prospect Lost', outbound_only: true },
  { source_status: 'Lost', target_status: 'Prospect Lost', outbound_only: true },
  { source_status: 'Junk Lead', target_status: 'Prospect Lost', outbound_only: true },
  { source_status: 'Lost Lead', target_status: 'Prospect Lost', outbound_only: true },
  { source_status: 'Lost Lead', target_status: 'Lost', inbound_only: true },
];

const FIELDS = pathPolicy.REQUIRED_DELIVERY_MAPPING_FIELDS.map((f) => ({
  source_field: f, target_field: `t_${f}`, data_type: 'string', required: true,
}));

function setup(t) {
  const db = createInMemoryZcql({
    dealers: [{ dealer_code: '725001', dealer_name: 'Buckby MG' }],
    dealer_integrations: [{ ROWID: '1000', dealer_code: '725001', integration_type: 'EXTERNAL_CRM', crm_type: 'FUSION_SD' }],
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
  const response = await fetch(`http://127.0.0.1:${listener.address().port}/725001/integration/mappings`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

const save = (t, statusMappings) => call(t, 'PUT', { fieldMappings: FIELDS, statusMappings });
const rowsOf = (db) => db.tables.integration_status_mappings.filter((r) => !r.__deleted);

test('an outbound-only row writes only the MG -> dealer row', async (t) => {
  const db = setup(t);
  const result = await save(t, [
    { source_status: 'Not Contacted', target_status: 'Open' },
    { source_status: 'Contacted', target_status: 'Open', outbound_only: true },
  ]);
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const rows = rowsOf(db);
  assert.equal(rows.length, 3, 'one two-way pair (2 rows) + 1 outbound-only row');
  assert.ok(rows.some((r) => r.direction === 'ZOHO_TO_EXTERNAL' && r.source_status === 'Contacted' && r.target_status === 'Open'));
  assert.equal(rows.filter((r) => r.direction === 'EXTERNAL_TO_ZOHO' && r.target_status === 'Contacted').length, 0);
});

test('two-way rows that share a dealer status are still refused as ambiguous', async (t) => {
  setup(t);
  const result = await save(t, [
    { source_status: 'Not Contacted', target_status: 'Open' },
    { source_status: 'Contacted', target_status: 'Open' },
  ]);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'STATUS_MAPPING_AMBIGUOUS');
});

test('a row cannot be both inbound-only and outbound-only', async (t) => {
  setup(t);
  const result = await save(t, [
    { source_status: 'Not Contacted', target_status: 'Open' },
    { source_status: 'Contacted', target_status: 'Open', inbound_only: true, outbound_only: true },
  ]);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'STATUS_MAPPING_INVALID');
});

test('the Fusion D1 preset saves, sends every MG status, and maps Fusion statuses back as before', async (t) => {
  const db = setup(t);
  const result = await save(t, FUSION_D1_PRESET);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const rows = rowsOf(db);

  const expectedOut = {
    'Not Contacted': 'Open',
    'Follow-up 1': 'Open',
    'Follow-up 2': 'Open',
    'Attempted to Contact': 'Open',
    Contacted: 'Open',
    'Contact in Future': 'Open',
    'Pre-Qualified': 'Open',
    'Finance Intro': 'Open',
    'Not Qualified': 'Prospect Lost',
    Dropped: 'Prospect Lost',
    Lost: 'Prospect Lost',
    'Junk Lead': 'Prospect Lost',
    'Lost Lead': 'Prospect Lost',
  };
  for (const [mg, fusion] of Object.entries(expectedOut)) {
    assert.equal(mapStatus(mg, rows, 'ZOHO_TO_EXTERNAL'), fusion, mg);
    assert.equal(isInboundOnlyStatus(mg, rows), false, mg);
  }
  // Every MG status a dealer can hold is covered; the rest are MG-only.
  for (const mg of pathPolicy.MG_LEAD_STATUS_VALUES) {
    if (mg === '-None-' || pathPolicy.isMgOnlyStatusFor(mg, 'FUSION_SD')) continue;
    assert.ok(expectedOut[mg], `${mg} has an outbound Fusion status`);
  }

  // Coming back: today's rules, unchanged.
  assert.equal(mapStatus('Open', rows, 'EXTERNAL_TO_ZOHO'), 'Not Contacted');
  assert.equal(mapStatus('Prospect Lost', rows, 'EXTERNAL_TO_ZOHO'), 'Not Qualified');
  // Fusion Lost -> MG "Lost", whose stored value is Lost Lead (Q26).
  assert.equal(mapStatus('Lost', rows, 'EXTERNAL_TO_ZOHO'), 'Lost Lead');
  // Won / Delivered: no rule, so MG is left unchanged (Q1 "safe option").
  for (const fusion of ['Won', 'Delivered']) {
    assert.throws(() => mapStatus(fusion, rows, 'EXTERNAL_TO_ZOHO'), (err) => err.code === 'STATUS_MAPPING_NOT_FOUND', fusion);
  }
});

test('reading back flags outbound-only rows, and saving what was read back is stable', async (t) => {
  const db = setup(t);
  await save(t, FUSION_D1_PRESET);
  const read = await call(t, 'GET');

  assert.equal(read.status, 200);
  assert.equal(read.body.statusMappingCleanupRequired, false);
  const view = read.body.statusMappings;
  assert.equal(view.length, FUSION_D1_PRESET.length);
  const contacted = view.find((m) => m.source_status === 'Contacted');
  assert.deepEqual([contacted.target_status, contacted.outbound_only], ['Open', true]);
  const notContacted = view.find((m) => m.source_status === 'Not Contacted');
  assert.equal(notContacted.outbound_only, undefined, 'two-way rows are not flagged');
  assert.deepEqual(
    [view.find((m) => m.inbound_only).source_status, view.find((m) => m.inbound_only).target_status],
    ['Lost Lead', 'Lost']
  );

  const before = rowsOf(db).length;
  const again = await save(t, view);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(rowsOf(db).length, before);
});

test('switching a row between two-way and outbound-only adds or removes its dealer -> MG row', async (t) => {
  const db = setup(t);
  await save(t, [
    { source_status: 'Not Contacted', target_status: 'Open' },
    { source_status: 'Lost', target_status: 'Lost' },
  ]);
  const reverseLost = () => rowsOf(db).filter((r) => r.direction === 'EXTERNAL_TO_ZOHO' && r.source_status === 'Lost').length;
  assert.equal(reverseLost(), 1);

  let view = (await call(t, 'GET')).body.statusMappings;
  await save(t, view.map((m) => (m.source_status === 'Lost' ? { ...m, outbound_only: true } : m)));
  assert.equal(reverseLost(), 0, 'outbound-only drops the dealer -> MG row');
  assert.equal(mapStatus('Lost', rowsOf(db), 'ZOHO_TO_EXTERNAL'), 'Lost');

  view = (await call(t, 'GET')).body.statusMappings;
  await save(t, view.map((m) => (m.source_status === 'Lost' ? { ...m, outbound_only: false } : m)));
  assert.equal(reverseLost(), 1, 'two-way again');
});
