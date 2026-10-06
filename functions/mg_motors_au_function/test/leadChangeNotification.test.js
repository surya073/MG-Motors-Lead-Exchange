'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLeadChangeNotification } = require('../services/leadChangeNotificationService');

const lead = { customer_name: 'Rahul Sharma', dealer_name: 'MG Sydney' };

test('a status change names the dealer, the lead and the new status', () => {
  const n = buildLeadChangeNotification({
    dealerCode: 'AU008',
    leadRow: lead,
    fieldChanges: [{ field: 'lead_status', from: 'Not Contacted', to: 'In Progress' }],
  });
  assert.equal(n.type, 'LEAD_STATUS_UPDATED');
  assert.equal(n.title, 'MG Sydney (AU008) moved Rahul Sharma to In Progress');
  assert.equal(n.message, 'Status: Not Contacted → In Progress');
});

test('status plus other fields: status line comes first, every change is listed', () => {
  const n = buildLeadChangeNotification({
    dealerCode: 'AU008',
    leadRow: lead,
    fieldChanges: [
      { field: 'next_followup_date', from: '', to: '2026-10-12' },
      { field: 'lead_status', from: 'New', to: 'Contacted' },
    ],
  });
  assert.equal(n.type, 'LEAD_STATUS_UPDATED');
  assert.deepEqual(n.message.split('\n'), [
    'Status: New → Contacted',
    'Next follow-up: — → 2026-10-12',
  ]);
});

test('field-only changes use the fields-updated type and an "updated" title', () => {
  const n = buildLeadChangeNotification({
    dealerCode: 'AU008',
    leadRow: lead,
    fieldChanges: [{ field: 'vehicle_model', from: 'MG ZS', to: 'MG Hector' }],
  });
  assert.equal(n.type, 'LEAD_FIELDS_UPDATED');
  assert.equal(n.title, 'MG Sydney (AU008) updated Rahul Sharma');
  assert.equal(n.message, 'Vehicle: MG ZS → MG Hector');
});

test('sensitive values are masked, not shown in clear', () => {
  const n = buildLeadChangeNotification({
    dealerCode: 'AU008',
    leadRow: lead,
    fieldChanges: [
      { field: 'mobile_number', from: '0412345678', to: '0498765432' },
      { field: 'email_address', from: 'old@example.com', to: 'new@example.com' },
    ],
  });
  assert.ok(!n.message.includes('0412345678'));
  assert.ok(!n.message.includes('0498765432'));
  assert.ok(!n.message.includes('old@'));
  assert.match(n.message, /Mobile: \*{7}678 → \*{7}432/);
  assert.match(n.message, /Email: o\*\*\*@example\.com → n\*\*\*@example\.com/);
});

test('bookkeeping fields and no-op changes produce no notification', () => {
  assert.equal(
    buildLeadChangeNotification({
      dealerCode: 'AU008',
      leadRow: lead,
      fieldChanges: [
        { field: 'last_status_update', from: 'a', to: 'b' },
        { field: 'sync_status', from: 'x', to: 'y' },
        { field: 'vehicle_model', from: 'MG ZS', to: 'MG ZS' },
      ],
    }),
    null
  );
  assert.equal(buildLeadChangeNotification({ dealerCode: 'AU008', leadRow: lead, fieldChanges: [] }), null);
  assert.equal(buildLeadChangeNotification({ dealerCode: 'AU008', leadRow: lead }), null);
});

test('falls back to the dealer code and a generic lead when names are missing; long lists are capped', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ field: `custom_field_${i}`, from: 'a', to: 'b' }));
  const n = buildLeadChangeNotification({ dealerCode: 'AU008', leadRow: {}, fieldChanges: many });
  assert.equal(n.title, 'AU008 updated a lead');
  const lines = n.message.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[5], '+3 more fields');
  assert.ok(n.message.length <= 480);
  assert.match(lines[0], /^Custom field 0: a → b$/);
});
