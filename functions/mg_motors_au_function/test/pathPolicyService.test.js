'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../services/integrations/pathPolicyService');
const leadSyncService = require('../services/leadSyncService');

function validLead(overrides = {}) {
  return {
    crm_record_id: 'MG-1001',
    enquiry_id: 'ENQ-1001',
    dealer_code: 'D001',
    customer_name: 'Alex Morgan',
    mobile_number: '+61 412 345 678',
    email_address: 'alex@example.com',
    postcode: '3000',
    vehicle_model: 'MG4',
    enquiry_variant: 'Essence',
    nature_of_enquiry: 'Test Drive',
    lead_source: 'Website',
    lead_status: 'Update Pending',
    accept_privacy_policy: true,
    assigned_date: '2026-09-23 10:10:00',
    ...overrides,
  };
}

test('the requested pilot catalog contains Happy 1-5 and Unhappy 1-10', () => {
  const expected = [
    ...Array.from({ length: 5 }, (_, index) => `Happy ${index + 1}`),
    ...Array.from({ length: 10 }, (_, index) => `Unhappy ${index + 1}`),
  ];
  expected.forEach((code) => assert.ok(policy.SCENARIOS[code], `${code} is missing`));
});

test('negative business outcomes stay Happy 2 and only spam/junk is Unhappy 9', () => {
  ['Lost', 'Lost (final)', 'Lost Lead', 'Not Qualified', 'Dropped', 'Converted'].forEach((status) => {
    assert.equal(policy.classifyDealerStatus(status).code, 'Happy 2');
  });
  ['Spam', 'Junk', 'Junk Lead', 'Junk Lead / Spam'].forEach((status) => {
    assert.equal(policy.classifyDealerStatus(status).code, 'Unhappy 9');
  });
  assert.equal(policy.classifyDealerStatus('Rejected'), null);
});

test('every live AU008 dealer lifecycle value is classified', () => {
  const expectedHappy = [
    'Received / Acknowledged',
    'Follow-up 1 / In progress',
    'Follow-up 2',
    'Contacted',
    'Nurture / Future',
    'Dropped',
    'Lost (final)',
    'Not Qualified',
    'Attempted to Contact',
    'Contact in Future',
    'Lost Lead',
    'Not Contacted',
    'Pre-Qualified',
  ];
  expectedHappy.forEach((status) => {
    assert.equal(policy.classifyDealerStatus(status)?.code, 'Happy 2', status);
  });
  assert.equal(policy.classifyDealerStatus('Junk Lead')?.code, 'Unhappy 9');
});

test('SLA waiting-state detection handles compound acknowledgement values', () => {
  ['Update Pending', 'Not Contacted', 'Received / Acknowledged'].forEach((status) => {
    assert.equal(policy.isWaitingForDealerActionStatus(status), true, status);
  });
  ['Follow-up 1 / In progress', 'Contacted', 'Lost (final)'].forEach((status) => {
    assert.equal(policy.isWaitingForDealerActionStatus(status), false, status);
  });
});

test('mandatory validation separates privacy and routing from invalid data', () => {
  assert.deepEqual(policy.validateLeadForDelivery(validLead()), {
    valid: true,
    issues: [],
    privacyIssue: null,
    routingIssue: null,
  });

  const invalid = policy.validateLeadForDelivery(validLead({
    customer_name: 'Alex',
    mobile_number: '0000000000',
    email_address: 'bad',
    postcode: 'abc',
    accept_privacy_policy: false,
    dealer_code: '',
  }));
  assert.deepEqual(invalid.issues.map((issue) => issue.field), [
    'customer_name', 'mobile_number', 'email_address', 'postcode',
  ]);
  assert.equal(invalid.privacyIssue.field, 'accept_privacy_policy');
  assert.equal(invalid.routingIssue.field, 'dealer_code');
});

test('Happy 3 requires every duplicate key to match within 15 minutes', () => {
  const original = validLead({ crm_record_id: 'MG-1', assigned_date: '2026-09-23 10:00:00' });
  const duplicate = validLead({ crm_record_id: 'MG-2', assigned_date: '2026-09-23 10:15:00' });
  assert.equal(policy.isBusinessDuplicate(duplicate, original), true);
  assert.equal(policy.isBusinessDuplicate(
    { ...duplicate, vehicle_model: 'ZS' },
    original
  ), false);
  assert.equal(policy.isBusinessDuplicate(
    { ...duplicate, nature_of_enquiry: 'Pre-order' },
    original
  ), false);
  assert.equal(policy.isBusinessDuplicate(
    { ...duplicate, assigned_date: '2026-09-23 10:15:01' },
    original
  ), false);
});

test('CRM Created_Time supplies duplicate timing without inventing Assigned_Date', () => {
  const mapped = leadSyncService._test.mapCrmRecordToLeadRow({
    id: 'MG-10',
    First_Name: 'Alex',
    Last_Name: 'Morgan',
    Created_Time: '2026-09-23T10:00:00+00:00',
    Lead_Status_Modified_Time: '2026-09-23T10:05:00+00:00',
  });
  assert.equal(mapped.assigned_date, '2026-09-23 10:00:00');
  assert.equal(mapped.last_status_update, '2026-09-23 10:05:00');
  assert.equal(Object.prototype.hasOwnProperty.call(mapped, 'dealer_remarks'), false);
  assert.equal(leadSyncService._test.hasChanges(
    { ...mapped, assigned_date: '' },
    mapped
  ), false);
  assert.equal(leadSyncService._test.needsAssignedDateBackfill(
    { ...mapped, assigned_date: '' },
    mapped
  ), true);
});

test('a matching original that failed delivery is never suppressed', () => {
  const incoming = validLead({ crm_record_id: 'MG-2', assigned_date: '2026-09-23 10:05:00' });
  const failedOriginal = validLead({
    crm_record_id: 'MG-1',
    assigned_date: '2026-09-23 10:00:00',
    sync_status: 'DELIVERY_FAILED',
  });
  const deliveredOriginal = { ...failedOriginal, sync_status: 'SYNCED' };
  assert.equal(
    leadSyncService._test.findDeliveredBusinessDuplicate(
      incoming,
      new Map([[failedOriginal.crm_record_id, failedOriginal]])
    ),
    null
  );
  assert.equal(
    leadSyncService._test.findDeliveredBusinessDuplicate(
      incoming,
      new Map([[deliveredOriginal.crm_record_id, deliveredOriginal]])
    )?.crm_record_id,
    'MG-1'
  );
});

test('ownership permits approved dealer fields and holds MG-owned changes', () => {
  const result = policy.partitionInboundByOwnership({
    lead_status: 'Contacted',
    dealer_remarks: 'Called customer',
    enquiry_outcome: 'Test drive booked',
    email_address: 'changed@example.com',
    accept_privacy_policy: false,
  }, validLead({ lead_status: 'Not Contacted', dealer_remarks: '' }));

  assert.deepEqual(result.allowed, {
    lead_status: 'Contacted',
    dealer_remarks: 'Called customer',
    enquiry_outcome: 'Test drive booked',
  });
  assert.deepEqual(result.conflicts.map((item) => item.field), ['email_address']);
  assert.deepEqual(result.ignored.map((item) => item.field), ['accept_privacy_policy']);
});

test('ownership protects contact fields and never blanks an MG value', () => {
  const result = policy.partitionInboundByOwnership({
    mobile_number: '0499999999',
    customer_message: 'Prefers Saturday',
    postcode: '',
  }, validLead({ customer_message: 'Hi', postcode: '3000' }));

  assert.deepEqual(result.allowed, { customer_message: 'Prefers Saturday' });
  assert.deepEqual(result.conflicts.map((item) => item.field), ['mobile_number']);
  assert.deepEqual(result.ignored.map((item) => item.field), ['postcode']);
});
