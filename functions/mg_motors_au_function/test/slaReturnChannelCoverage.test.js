'use strict';

for (const key of ['ZOHO_CLIENT_ID', 'ZOHO_CLIENT_SECRET', 'ZOHO_REFRESH_TOKEN', 'ZOHO_WEBHOOK_TOKEN']) {
  process.env[key] = process.env[key] || 'test-fixture';
}
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlaFixture } = require('./helpers/slaFixture');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const sla = require('../services/integrations/slaMonitorService');
const oem = require('../services/zohoCrmService');
const crm = require('../services/integrations/crmIntegrationService');

function setup(t, count = 301) {
  _resetForTests();
  for (const key of ['FUSION_INBOUND_V2', 'SLA_DEALER_ACTION_CLOCK', 'DEALER_ACTION_SLA_DEALERS']) {
    const before = process.env[key];
    delete process.env[key];
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  const db = createSlaFixture({
    dealer_integrations: [
      ...Array.from({ length: count }, (_, i) => ({ dealer_code: `F${i}`, crm_type: 'FUSION_SD', status: 'CONNECTED', inbound_enabled: false })),
      { dealer_code: 'Z1', crm_type: 'ZOHO_CRM', status: 'CONNECTED' },
    ],
    lead_integrations: [
      { integration_id: String(999 + count), zoho_lead_id: 'fusion-last', dealer_code: `F${count - 1}`, sync_status: 'SYNCED', last_synced_at: '2000-01-01 00:00:00' },
      { integration_id: String(1000 + count), zoho_lead_id: 'zoho-1', dealer_code: 'Z1', sync_status: 'SYNCED', last_synced_at: '2000-01-01 00:00:00' },
    ],
    leads: ['fusion-last', 'zoho-1'].map((id) => ({ crm_record_id: id, lead_status: 'Not Contacted' })),
    outbound_sync_claims: [],
  }, { enforceUnique: true });
  const writes = t.mock.method(oem, 'updateOemLead', async () => ({}));
  t.mock.method(crm, 'recordScenario', async () => {});
  return { db, writes };
}

const sweep = (db) => sla.runSlaSweep(db.app, new Date(), { clock: () => 0 });

test('the 301st Fusion dealer is checked only when it has an overdue mapping; Zoho still breaches', async (t) => {
  const { db, writes } = setup(t);
  const original = { ...db.tables.lead_integrations[0] };
  const result = await sweep(db);
  assert.deepEqual(result.exemptNoReturnChannel, [{ dealerCode: 'F300', reason: 'INBOUND_OFF' }]);
  assert.deepEqual(db.tables.lead_integrations[0], original);
  assert.equal(db.tables.lead_integrations[1].sync_status, 'SLA_BREACH');
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(db.queries.some((sql) => sql.includes("crm_type = 'FUSION_SD'")), false);
});

test('even 5001 idle Fusion integrations incur no global channel scan', async (t) => {
  const { db, writes } = setup(t, 5001);
  const result = await sweep(db);
  assert.equal(result.skippedNoReturnChannel, 1);
  assert.equal(writes.mock.callCount(), 1);
  assert.ok(db.queries.filter((sql) => sql.includes('FROM dealer_integrations')).length <= 2);
});

test('hundreds of healthy Fusion dealers do not consume the budget before overdue Zoho and Fusion work', async (t) => {
  const { db, writes } = setup(t, 200);
  process.env.FUSION_INBOUND_V2 = 'true';
  db.tables.dealer_integrations.forEach((row) => { row.inbound_enabled = true; });
  const proof = require('../services/integrations/fusionReturnChannelProof');
  let clock = 0;
  const checks = t.mock.method(proof, 'getReturnChannelGap', async () => { clock += 100; return null; });
  const result = await sla.runSlaSweep(db.app, new Date(), { clock: () => clock, timeBudgetMs: 20000 });
  assert.equal(result.breached, 2);
  assert.equal(checks.mock.callCount(), 1, 'only the candidate Fusion integration needs proof');
  assert.equal(writes.mock.callCount(), 2);
  assert.equal(result.elapsedMs, 100);
});

test('a failed candidate proof is fail-closed and does not prevent another dealer from being checked', async (t) => {
  const { db, writes } = setup(t, 200);
  process.env.FUSION_INBOUND_V2 = 'true';
  db.tables.dealer_integrations.forEach((row) => { row.inbound_enabled = true; });
  const proof = require('../services/integrations/fusionReturnChannelProof');
  t.mock.method(proof, 'getReturnChannelGap', async () => { throw new Error('proof read unavailable'); });
  const result = await sweep(db);
  assert.equal(result.skippedNoReturnChannel, 1);
  assert.equal(db.tables.lead_integrations[0].sync_status, 'SYNCED');
  assert.equal(writes.mock.callCount(), 1);
});

test('dealer scope avoids both out-of-scope candidates and their channel proofs', async (t) => {
  const { db } = setup(t);
  process.env.DEALER_ACTION_SLA_DEALERS = 'Z1';
  const result = await sweep(db);
  assert.equal(result.candidates, 1);
  assert.deepEqual(result.exemptNoReturnChannel, []);
  // Batch 2 (cost): one screen read of the candidates' integrations by ROWID,
  // plus the in-claim read; never a read of out-of-scope integrations.
  const integrationReads = db.queries.filter((sql) => sql.includes('FROM dealer_integrations'));
  assert.equal(integrationReads.length, 2);
  const id = db.tables.lead_integrations.find((m) => m.dealer_code === 'Z1').integration_id;
  assert.ok(integrationReads.every((sql) => sql.includes(`WHERE ROWID IN ('${id}')`) || sql.includes(`WHERE ROWID = ${id} `)), integrationReads.join('\n'));
});

for (const state of ['Removed lead', 'Reassigned lead', 'Removed dealer', 'Missing dealer', 'Consent withdrawn', 'Consent unknown', 'Disabled integration', 'Outbound disabled', 'Inbound disabled']) {
  test(`SLA does not write through a ${state}`, async (t) => {
    const { db, writes } = setup(t, 1);
    if (state === 'Removed lead') db.tables.leads[1].sync_status = 'Removed';
    if (state === 'Reassigned lead') db.tables.leads[1].dealer_code = 'NEW-DEALER';
    if (state === 'Removed dealer') db.tables.dealers[1].sync_status = 'Removed';
    if (state === 'Missing dealer') db.tables.dealers[1].__deleted = true;
    if (state === 'Consent withdrawn') db.tables.leads[1].accept_privacy_policy = false;
    if (state === 'Consent unknown') db.tables.leads[1].accept_privacy_policy = null;
    if (state === 'Disabled integration') db.tables.dealer_integrations[1].status = 'DISABLED';
    if (state === 'Outbound disabled') db.tables.dealer_integrations[1].outbound_enabled = false;
    if (state === 'Inbound disabled') db.tables.dealer_integrations[1].inbound_enabled = false;
    await sweep(db);
    assert.equal(writes.mock.callCount(), 0);
    assert.equal(db.tables.lead_integrations[1].sync_status, 'SYNCED');
  });
}

test('a dealer removed during an earlier SLA batch cannot remain eligible from a sweep cache', async (t) => {
  const { db, writes } = setup(t, 1);
  const first = db.tables.lead_integrations[1];
  for (let i = 0; i < 7; i += 1) {
    db.tables.lead_integrations.push({ ...first, ROWID: String(3000 + i), zoho_lead_id: `later-${i}` });
    db.tables.leads.push({ crm_record_id: `later-${i}`, dealer_code: 'Z1', accept_privacy_policy: true, lead_status: 'Not Contacted' });
  }
  writes.mock.mockImplementation(async () => { db.tables.dealers[1].sync_status = 'Removed'; return {}; });
  const result = await sweep(db);
  assert.ok(writes.mock.callCount() <= sla._test.SLA_CONCURRENCY, 'later batches must freshly observe removal');
  assert.ok(result.skippedUnhealthy >= 5);
  assert.equal(db.tables.lead_integrations.at(-1).sync_status, 'SYNCED');
});
