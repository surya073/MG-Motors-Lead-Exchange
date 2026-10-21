'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupOutbound, withEnv } = require('./helpers/outboundHarness');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const factory = require('../services/integrations/crmAdapterFactory');
const oem = require('../services/zohoCrmService');

const record = {
  id: 'ZL1', Enq_ID: 'ENQ-1', First_Name: 'Jane', Last_Name: 'Citizen', Mobile: '0412345678',
  Email: 'jane@example.com', Postcode: '3000', Enquiry_Model: 'MG ZS', Nature_of_enquiry: 'Test Drive',
  Lead_Source: 'Website', Lead_Status: 'Not Contacted', Franchise_Code: 'AU999', Accept_Privacy_Polic: true,
  Created_Time: '2026-10-01T10:00:00Z',
};

function harness(t) {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'true', LEAD_SYNC_SINCE: undefined });
  const h = setupOutbound(t);
  h.db.tables.sync_logs = [];
  h.db.tables.notifications = [];
  h.db = createInMemoryZcql(h.db.tables, { enforceUnique: true });
  const sent = [];
  t.mock.method(factory, 'getAdapter', () => ({
    createLead: async (_app, _integration, payload) => { sent.push(payload); return { externalLeadId: 'new-id', httpStatus: 201 }; },
    updateLead: async (_app, _integration, externalLeadId, payload) => { sent.push(payload); return { externalLeadId, httpStatus: 200 }; },
  }));
  const source = { current: { ...record }, beforeBatchReturns: async () => {}, refreshError: null, refreshUnderClaim: [] };
  t.mock.method(oem, 'fetchOemLeads', async () => {
    const staleBatch = [{ ...record }];
    await source.beforeBatchReturns();
    return staleBatch;
  });
  t.mock.method(oem, 'fetchOemLeadsByIds', async () => {
    const claimed = h.db.tables.outbound_sync_claims.some((row) => !row.__deleted && row.claim_key === 'lead:ZL1');
    source.refreshUnderClaim.push(claimed);
    if (source.refreshError) throw source.refreshError;
    return source.current ? [{ ...source.current }] : [];
  });
  // leadSyncService destructures its OEM methods. Load it after installing
  // the synthetic source; all lifecycle/claim/dispatch code remains real.
  const modulePath = require.resolve('../services/leadSyncService');
  delete require.cache[modulePath];
  const sync = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  h.db.tables.leads[0] = { ...sync._test.mapCrmRecordToLeadRow(record), sync_status: 'SYNCED' };
  return { h, source, sent, sync };
}

test('an OEM batch fetched before a delete cannot revive or dispatch the tombstoned lead', async (t) => {
  const { h, source, sent, sync } = harness(t);
  source.beforeBatchReturns = async () => {
    source.current = null;
    await sync.syncLeadsByIds(h.db.app, ['ZL1'], { operation: 'delete' });
    assert.equal(h.db.tables.leads[0].sync_status, 'Removed');
  };
  const result = await sync.syncLeads(h.db.app);
  assert.equal(result.recordsFailed, 0);
  assert.equal(h.db.tables.leads[0].sync_status, 'Removed');
  assert.equal(h.db.tables.lead_integrations[0].last_error, 'LEAD_REMOVED');
  assert.equal(sent.length, 0);
  assert.equal(h.oemWrites.length, 0);
  assert.deepEqual(source.refreshUnderClaim, [true]);
});

test('an older OEM batch cannot undo a consent revocation applied by another sync', async (t) => {
  const { h, source, sent, sync } = harness(t);
  source.beforeBatchReturns = async () => {
    source.current = { ...record, Accept_Privacy_Polic: false };
    const changed = await sync.syncLeadsByIds(h.db.app, ['ZL1']);
    assert.equal(changed.recordsFailed, 0);
    assert.equal(h.db.tables.leads[0].accept_privacy_policy, false);
  };
  const result = await sync.syncLeads(h.db.app);
  assert.equal(result.recordsFailed, 0);
  assert.equal(h.db.tables.leads[0].accept_privacy_policy, false);
  assert.equal(h.db.tables.leads[0].sync_status, 'CONSENT_HOLD');
  assert.equal(sent.length, 0);
  assert.equal(h.oemWrites.length, 0);
  assert.equal(source.refreshUnderClaim.at(-1), true);
});

test('an unavailable authoritative OEM refresh leaves a newer local record untouched and marks the run incomplete', async (t) => {
  const { h, source, sent, sync } = harness(t);
  h.db.tables.leads[0].customer_name = 'Newer customer name';
  const before = { ...h.db.tables.leads[0] };
  source.refreshError = new Error('Synthetic authoritative OEM read unavailable');
  const result = await sync.syncLeads(h.db.app);
  assert.equal(result.recordsFailed, 1);
  assert.deepEqual(h.db.tables.leads[0], before);
  assert.equal(sent.length, 0);
  assert.equal(h.oemWrites.length, 0);
  assert.equal(h.db.tables.sync_logs.at(-1).records_failed, 1);
  assert.deepEqual(source.refreshUnderClaim, [true]);
  assert.equal(h.db.tables.outbound_sync_claims.filter((row) => !row.__deleted).length, 0);
});
