'use strict';

// Audit handover §6: a lead must never be dropped silently. When the dealer
// or integration lookup itself fails (a temporary datastore error) before the
// lead is handed to a dealer CRM, the lead stayed PENDING with nothing but a
// console line: no integration log row and no alert. It is now recorded as
// Unhappy 1 (DISPATCH_FAILED) with an alert; the lead's state is not changed.

const test = require('node:test');
const assert = require('node:assert/strict');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const leadSyncService = require('../services/leadSyncService');

const { dispatchNewLeadToDealer } = leadSyncService._test;

function fakeApp() {
  const updates = [];
  return {
    updates,
    datastore: () => ({ table: () => ({ updateRow: async (row) => { updates.push(row); return row; } }) }),
  };
}

function leadRow() {
  return { ROWID: '9001', crm_record_id: 'z-1', dealer_code: '725001', sync_status: 'PENDING' };
}

test('a dealer lookup that throws is recorded as Unhappy 1 with an alert, and the lead state is untouched', async (t) => {
  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => {
    throw new Error('ZCQL temporarily unavailable');
  });
  const recordScenario = t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  const app = fakeApp();
  const lead = leadRow();

  const result = await dispatchNewLeadToDealer(app, lead);

  assert.equal(result.ok, false);
  assert.equal(result.scenarioCode, 'Unhappy 1');
  assert.equal(recordScenario.mock.callCount(), 1);
  const [, args] = recordScenario.mock.calls[0].arguments;
  assert.equal(args.scenarioCode, 'Unhappy 1');
  assert.equal(args.errorCode, 'DISPATCH_FAILED');
  assert.equal(args.notify, true);
  assert.equal(args.dealerCode, '725001');
  assert.match(args.reason, /ZCQL temporarily unavailable/);
  assert.equal(lead.sync_status, 'PENDING');
  assert.deepEqual(app.updates, []);
});

test('an integration lookup that throws is recorded the same way', async (t) => {
  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => ({ dealer_code: '725001', sync_status: 'Synced' }));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => {
    throw new Error('read timeout');
  });
  const recordScenario = t.mock.method(crmIntegrationService, 'recordScenario', async () => {});

  const result = await dispatchNewLeadToDealer(fakeApp(), leadRow());

  assert.equal(result.ok, false);
  assert.equal(recordScenario.mock.callCount(), 1);
  assert.equal(recordScenario.mock.calls[0].arguments[1].errorCode, 'DISPATCH_FAILED');
});

test('a failure after the lead state was already recorded adds no second scenario', async (t) => {
  // PORTAL path: the lead is marked SYNCED, then its Happy 1 log write fails.
  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => ({ dealer_code: '725001', sync_status: 'Synced' }));
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({ integration_type: 'PORTAL' }));
  const recordScenario = t.mock.method(crmIntegrationService, 'recordScenario', async () => {
    throw new Error('log table unavailable');
  });
  const lead = leadRow();

  const result = await dispatchNewLeadToDealer(fakeApp(), lead);

  assert.equal(result.ok, false);
  assert.equal(lead.sync_status, 'SYNCED');
  assert.equal(recordScenario.mock.callCount(), 1, 'only the original Happy 1 attempt');
});

test('if recording the failure also fails, dispatch still never throws', async (t) => {
  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => {
    throw new Error('datastore down');
  });
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {
    throw new Error('datastore down');
  });

  const result = await dispatchNewLeadToDealer(fakeApp(), leadRow());
  assert.equal(result.ok, false);
});

test('a usable EXTERNAL_CRM dealer is still handed to syncLeadToExternalCrm unchanged', async (t) => {
  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => ({ dealer_code: '725001', sync_status: 'Synced' }));
  const integration = { integration_type: 'EXTERNAL_CRM', crm_type: 'FUSION_SD' };
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => integration);
  const sync = t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async () => ({ ok: true, scenarioCode: 'Happy 1' }));
  const recordScenario = t.mock.method(crmIntegrationService, 'recordScenario', async () => {});

  const result = await dispatchNewLeadToDealer(fakeApp(), leadRow());

  assert.deepEqual(result, { ok: true, scenarioCode: 'Happy 1' });
  assert.equal(sync.mock.callCount(), 1);
  assert.equal(sync.mock.calls[0].arguments[1], integration);
  assert.equal(recordScenario.mock.callCount(), 0);
});
