'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const { _resetForTests } = require('../services/integrations/sweepOverlapGuard');
const zohoAuthService = require('../services/zohoAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const oemCrmService = require('../services/zohoCrmService');
const slaMonitorService = require('../services/integrations/slaMonitorService');
const leadSyncService = require('../services/leadSyncService');

// sweepOverlapGuard and the webhook serialiser only protect ONE warm instance.
// Catalyst can run several at once, so the safety of overlapping jobs rests on
// the database: a unique-keyed claim per (integration, lead) and unique
// constraints on crm_record_id and dedupe_key. The in-memory engine enforces
// those same constraints here, and "two instances" are simulated by running
// the same job twice concurrently with the per-instance guards reset.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_NOW = Date.parse('2026-10-09T06:00:00Z');
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const DAY = 24 * 3600 * 1000;

function slaDb(count, extra = {}) {
  const mappings = [];
  const leads = [];
  for (let i = 0; i < count; i += 1) {
    const id = `lead-${i}`;
    mappings.push({
      zoho_lead_id: id, dealer_code: 'D1', integration_id: '1000', sync_status: 'SYNCED',
      last_synced_at: utc(BASE_NOW - 5 * DAY + i * 60000),
    });
    leads.push({ crm_record_id: id, lead_status: 'Not Contacted', sync_status: 'SYNCED' });
  }
  return createInMemoryZcql({
    lead_integrations: mappings, leads, dealer_integrations: [{ dealer_code: 'D1', status: 'ACTIVE' }],
    outbound_sync_claims: [], ...extra,
  }, { enforceUnique: true });
}

function slaMocks(t) {
  const oemWrites = [];
  const scenarios = [];
  t.mock.method(oemCrmService, 'updateOemLead', async (id) => { await delay(5); oemWrites.push(id); return { status: 'success' }; });
  t.mock.method(crmIntegrationService, 'recordScenario', async (_a, args) => { scenarios.push(args.leadRow.crm_record_id); });
  return { oemWrites, scenarios };
}

// An app whose claim-table calls are slow: models an instance that read its
// candidates early but only reaches the claim after another instance finished.
function slowClaimApp(db, ms) {
  const real = db.app;
  return {
    ...real,
    zcql: () => ({
      executeZCQLQuery: async (sql) => {
        if (sql.includes('outbound_sync_claims')) await delay(ms);
        return real.zcql().executeZCQLQuery(sql);
      },
    }),
    datastore: () => ({
      table: (name) => {
        const table = real.datastore().table(name);
        return name === 'outbound_sync_claims'
          ? { ...table, insertRow: async (fields) => { await delay(ms); return table.insertRow(fields); } }
          : table;
      },
    }),
  };
}

const sweepAt = (app) => {
  _resetForTests(); // a different instance has its own (empty) in-memory guard
  return slaMonitorService.runSlaSweep(app, new Date(BASE_NOW));
};

test('SLA: two instances sweeping at the same moment breach each lead once, not twice', async (t) => {
  const { oemWrites, scenarios } = slaMocks(t);
  const db = slaDb(30);

  const [a, b] = await Promise.all([sweepAt(db.app), sweepAt(db.app)]);

  assert.equal(a.breached + b.breached, 30, 'every overdue lead is breached');
  assert.equal(new Set(oemWrites).size, 30);
  assert.equal(oemWrites.length, 30, 'no lead was written to the OEM CRM twice');
  assert.equal(scenarios.length, 30, 'exactly one Unhappy 10 record (and alert) per lead');
  assert.ok(a.skippedConcurrent + b.skippedConcurrent + a.skippedAlreadyHandled + b.skippedAlreadyHandled > 0,
    'the loser noticed and stood down');
  assert.equal(db.tables.outbound_sync_claims.filter((c) => !c.__deleted).length, 0, 'all claims released');
});

test('SLA: an instance that read its candidates before another finished does not breach them again', async (t) => {
  const { oemWrites, scenarios } = slaMocks(t);
  const db = slaDb(12);
  const lateApp = slowClaimApp(db, 60); // reaches the claim only after the other instance is done

  const [fast, late] = await Promise.all([sweepAt(db.app), sweepAt(lateApp)]);

  assert.equal(fast.breached, 12);
  assert.equal(late.breached, 0, 'the late instance found every lead already handled');
  assert.equal(late.skippedAlreadyHandled + late.skippedConcurrent + late.skippedActioned, 12, "every lead was stood down on");
  assert.equal(oemWrites.length, 12);
  assert.equal(scenarios.length, 12);
});

test('SLA: a lead whose dealer update is being applied right now is left for the next sweep, untouched', async (t) => {
  const { oemWrites } = slaMocks(t);
  const db = slaDb(1);
  // The inbound-update path holds the same claim key (`<integration>:<lead>`).
  db.tables.outbound_sync_claims.push({ claim_key: '1000:lead-0', claimed_at: utc(Date.now()), request_reference: 'inbound' });
  const before = { ...db.tables.lead_integrations[0] };

  const result = await sweepAt(db.app);

  assert.equal(result.skippedConcurrent, 1);
  assert.equal(result.breached, 0);
  assert.equal(oemWrites.length, 0);
  assert.deepEqual(db.tables.lead_integrations[0], before, 'nothing rewritten, acknowledgement time intact');
  assert.equal(db.tables.leads[0].lead_status, 'Not Contacted');
});

test('SLA: a claim abandoned by a crashed instance expires, so the lead is not blocked forever', async (t) => {
  const { oemWrites } = slaMocks(t);
  const db = slaDb(1);
  db.tables.outbound_sync_claims.push({ claim_key: '1000:lead-0', claimed_at: utc(Date.now() - 60 * 60 * 1000), request_reference: 'crashed' });

  const result = await sweepAt(db.app);

  assert.equal(result.breached, 1);
  assert.equal(oemWrites.length, 1);
});

test('SLA: if the dealer acts while the sweep waits for the claim, the lead is not breached', async (t) => {
  const { oemWrites } = slaMocks(t);
  const db = slaDb(1);
  const app = slowClaimApp(db, 40);
  const sweep = sweepAt(app);
  await delay(10);
  db.tables.leads[0].lead_status = 'Contacted'; // the dealer's update lands before the claim is taken

  const result = await sweep;

  assert.equal(result.breached, 0);
  assert.equal(result.skippedActioned, 1);
  assert.equal(oemWrites.length, 0, 'no false Unattended Alert written to the OEM CRM');
});

// --- lead insert race ---------------------------------------------------------------------------

test('lead sync: two instances inserting the same new OEM lead produce one row and no false failure', async (t) => {
  zohoAuthService._resetForTests();
  const record = {
    id: '9001', First_Name: 'Alex', Last_Name: 'Morgan', Mobile: '0412345678', Email: 'a@example.com', Postcode: '3000',
    Enquiry_Model: 'MG3', Nature_of_enquiry: 'Test Drive', Lead_Source: 'Website', Lead_Status: 'Not Contacted',
    Franchise_Code: 'D1', Accept_Privacy_Polic: true, Created_Time: '2026-10-09T10:00:00+11:00',
  };
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  t.mock.method(axios, 'get', async () => ({ data: { data: [record], info: { more_records: false } } }));
  const dispatched = [];
  t.mock.method(crmIntegrationService, 'findDealerByCode', async () => { await delay(15); return { dealer_code: 'D1', sync_status: 'Active' }; });
  t.mock.method(crmIntegrationService, 'getIntegrationByDealerCode', async () => ({ ROWID: '900', integration_type: 'EXTERNAL_CRM' }));
  t.mock.method(crmIntegrationService, 'syncLeadToExternalCrm', async (_a, _i, leadRow) => { dispatched.push(leadRow.crm_record_id); return { ok: true, scenarioCode: 'Happy 1' }; });
  t.mock.method(crmIntegrationService, 'recordScenario', async () => {});
  const db = createInMemoryZcql({ leads: [], outbound_sync_claims: [], sync_logs: [], notifications: [] }, { enforceUnique: true });

  const [a, b] = await Promise.all([
    leadSyncService.syncLeads(db.app, { trigger: 'Webhook', triggeredBy: 'instance-A' }),
    leadSyncService.syncLeads(db.app, { trigger: 'Webhook', triggeredBy: 'instance-B' }),
  ]);

  assert.equal(db.tables.leads.filter((l) => l.crm_record_id === '9001').length, 1, 'exactly one lead row');
  assert.equal(a.recordsInserted + b.recordsInserted, 1);
  assert.equal(a.recordsFailed + b.recordsFailed, 0, 'the loser is not miscounted as a failed record');
  assert.deepEqual(dispatched, ['9001'], 'the dealer receives the lead once');
});

// --- dealer webhook de-duplication --------------------------------------------------------------------

test('dealer webhooks: a delivery repeated with the same event id is recognised as a duplicate across instances', async () => {
  const db = createInMemoryZcql({ webhook_events: [] }, { enforceUnique: true });
  const integration = { ROWID: '1000', dealer_code: 'D1' };

  const results = await Promise.all([
    crmIntegrationService.checkAndRecordWebhookEvent(db.app, integration, Buffer.from('{"a":1}'), 'evt-1'),
    crmIntegrationService.checkAndRecordWebhookEvent(db.app, integration, Buffer.from('{"a":1}'), 'evt-1'),
    crmIntegrationService.checkAndRecordWebhookEvent(db.app, integration, Buffer.from('{"a":1}'), 'evt-1'),
  ]);

  assert.equal(results.filter((r) => !r.isDuplicate).length, 1, 'only the first delivery is processed');
  assert.equal(results.filter((r) => r.isDuplicate).length, 2);
  assert.equal(db.tables.webhook_events.length, 1);

  // Without a provider event id there is nothing safe to dedupe on: every delivery is processed
  // (state fingerprints, not the event table, then provide idempotency).
  const noId = await Promise.all([
    crmIntegrationService.checkAndRecordWebhookEvent(db.app, integration, Buffer.from('{"b":2}'), undefined),
    crmIntegrationService.checkAndRecordWebhookEvent(db.app, integration, Buffer.from('{"b":2}'), undefined),
  ]);
  assert.equal(noId.filter((r) => !r.isDuplicate).length, 2);
});
