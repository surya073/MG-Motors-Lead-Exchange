'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const catalyst = require('zcatalyst-sdk-node');
const { setupOutbound, withEnv } = require('./helpers/outboundHarness');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const factory = require('../services/integrations/crmAdapterFactory');
const auth = require('../services/integrations/integrationAuthService');
const router = require('../routes/webhookRoutes');

const handler = router.stack.find((entry) => entry.route?.path === '/webhooks/dealers/:dealerCode').route.stack.at(-1).handle;
const IDS = ['dealer-good', 'dealer-retry'];
const timeout = () => Object.assign(new Error('Synthetic dealer fetch timeout'), { code: 'ETIMEDOUT' });
const rateLimit = () => Object.assign(new Error('Synthetic dealer throttling'), { response: { status: 429 } });

function harness(t) {
  withEnv(t, { SYNC_CLAIM_FAIL_CLOSED: 'true', FUSION_INBOUND_V2: undefined, INBOUND_EVENT_STORE: undefined });
  const h = setupOutbound(t, {
    integration: { crm_type: 'ZOHO_CRM', inbound_enabled: true, webhook_enabled: true },
    mapping: { external_crm_lead_id: IDS[0] },
  });
  h.db.tables.dealers[0].sync_status = 'Synced';
  h.db.tables.leads.push({ ...h.db.tables.leads[0], crm_record_id: 'ZL2', enquiry_id: 'ENQ-2' });
  h.db.tables.lead_integrations.push({ ...h.db.tables.lead_integrations[0], zoho_lead_id: 'ZL2', external_crm_lead_id: IDS[1] });
  h.db.tables.webhook_events = [];
  // Exercise real event deduplication, including a retry of an unsuccessful
  // provider event, against the production unique-key invariant.
  h.db = createInMemoryZcql(h.db.tables, { enforceUnique: true });
  const failures = new Map();
  const fetched = [];
  t.mock.method(factory, 'getAdapter', () => ({
    getLead: async (_app, _integration, id) => {
      fetched.push(id);
      if (failures.has(id)) throw failures.get(id);
      return { raw: { data: [{ enquiryStatus: 'Won' }] } };
    },
  }));
  const credentials = t.mock.method(auth, 'getDecryptedCredential', async (_app, _id, type) => type === 'WEBHOOK_SECRET' ? 'synthetic-webhook-token' : null);
  t.mock.method(catalyst, 'initialize', () => h.db.app);

  async function deliver({ ids = IDS, eventId = 'provider-event-1' } = {}) {
    const req = {
      params: { dealerCode: 'AU999' },
      headers: { 'x-webhook-token': 'synthetic-webhook-token' },
      body: Buffer.from(JSON.stringify({ module: 'Leads', event_id: eventId, ids })),
    };
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    await handler(req, res);
    return res;
  }
  return { h, failures, fetched, credentials, deliver };
}

function failedLogs(h) {
  return h.db.tables.integration_logs.filter((row) => row.status === 'FAILED' && row.error_message?.startsWith('DEALER_FETCH_FAILED:'));
}

for (const [name, makeError, code] of [['timeout', timeout, 'ETIMEDOUT'], ['429', rateLimit, '429']]) {
  test(`a mixed Zoho batch durably retains its ${name} item and stays PENDING`, async (t) => {
    const { h, failures, deliver } = harness(t);
    failures.set(IDS[1], makeError());
    const res = await deliver();
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.result.held, true);
    assert.equal(h.db.tables.webhook_events[0].processing_status, 'PENDING');
    assert.deepEqual(h.oemWrites.map((entry) => entry.zohoLeadId), ['ZL1']);
    const logs = failedLogs(h);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].external_lead_id, IDS[1]);
    assert.equal(logs[0].integration_id, '1000');
    assert.equal(logs[0].happy_unhappy_path_name, 'Unhappy 4');
    assert.equal(logs[0].error_message, `DEALER_FETCH_FAILED:${code}`);
  });
}

test('an all-failed Zoho batch acknowledges only after every ID is durably retained', async (t) => {
  const { h, failures, deliver } = harness(t);
  failures.set(IDS[0], timeout());
  failures.set(IDS[1], rateLimit());
  const res = await deliver();
  assert.equal(res.statusCode, 202);
  assert.deepEqual(failedLogs(h).map((row) => row.external_lead_id).sort(), [...IDS].sort());
  assert.equal(h.db.tables.webhook_events[0].processing_status, 'PENDING');
  assert.equal(h.oemWrites.length, 0);
});

test('failure to retain an item returns non-2xx and provider redelivery resumes it after storage recovers', async (t) => {
  const { h, failures, deliver } = harness(t);
  failures.set(IDS[1], timeout());
  let rejectLog = true;
  const datastore = h.db.app.datastore;
  h.db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    if (name !== 'integration_logs') return table;
    return { ...table, insertRow: async (row) => {
      if (rejectLog && row.external_lead_id === IDS[1] && row.status === 'FAILED') {
        throw new Error('Synthetic durable replay log store unavailable');
      }
      return table.insertRow(row);
    } };
  } });
  const first = await deliver();
  assert.ok(first.statusCode >= 500);
  assert.equal(h.db.tables.webhook_events[0].processing_status, 'FAILED');
  assert.equal(failedLogs(h).length, 0);
  assert.deepEqual(h.oemWrites.map((entry) => entry.zohoLeadId), ['ZL1']);

  rejectLog = false;
  failures.clear();
  const second = await deliver();
  assert.equal(second.statusCode, 200);
  assert.notEqual(second.body.status, 'DUPLICATE', 'FAILED provider events must be processed again');
  assert.deepEqual(h.oemWrites.map((entry) => entry.zohoLeadId), ['ZL1', 'ZL2']);
  assert.equal(h.db.tables.webhook_events.length, 1);
  assert.equal(h.db.tables.webhook_events[0].processing_status, 'SUCCESS');
});

test('a fresh replay sweep recovers only the failed ID from the persisted datastore snapshot', async (t) => {
  const { h, failures, fetched, deliver } = harness(t);
  failures.set(IDS[1], timeout());
  assert.equal((await deliver()).statusCode, 202);
  assert.equal(failedLogs(h).length, 1);

  // No request result/closure supplies replay work. Reconstruct the app from
  // stored rows and load a fresh scheduler, as after a function restart.
  h.db = createInMemoryZcql(JSON.parse(JSON.stringify(h.db.tables)), { enforceUnique: true });
  failures.clear();
  const schedulerPath = require.resolve('../services/integrations/inboundReplayScheduler');
  delete require.cache[schedulerPath];
  t.after(() => { delete require.cache[schedulerPath]; });
  const { runInboundReplaySweep } = require(schedulerPath);
  const result = await runInboundReplaySweep(h.db.app);
  assert.equal(result.recovered, 1);
  assert.equal(result.failed, 0);
  assert.equal(failedLogs(h).length, 0);
  assert.deepEqual(h.oemWrites.map((entry) => entry.zohoLeadId), ['ZL1', 'ZL2']);
  assert.deepEqual(fetched, [IDS[0], IDS[1], IDS[1]]);
  const next = await runInboundReplaySweep(h.db.app);
  assert.equal(next.attempted, 0);
  assert.equal(h.oemWrites.length, 2);
});

for (const state of ['removed dealer', 'disabled integration']) {
  test(`${state} is blocked by the actual dealer webhook route before authentication or mutations`, async (t) => {
    const { h, fetched, credentials, deliver } = harness(t);
    if (state === 'removed dealer') h.db.tables.dealers[0].sync_status = 'Removed';
    else h.db.tables.dealer_integrations[0].status = 'DISABLED';
    const res = await deliver();
    assert.equal(res.statusCode, 404);
    assert.equal(h.oemWrites.length, 0);
    assert.equal(fetched.length, 0);
    assert.equal(credentials.mock.callCount(), 0);
    assert.equal(h.db.tables.webhook_events.length, 0);
  });
}

for (const hold of ['missing mapping', 'claim contention']) {
  test(`a ${hold} hold without a provider event ID requires durable replay storage before 202`, async (t) => {
    const { h, deliver } = harness(t);
    if (hold === 'missing mapping') {
      h.db.tables.lead_integrations = h.db.tables.lead_integrations.filter((row) => row.external_crm_lead_id !== IDS[1]);
    } else {
      h.db.tables.outbound_sync_claims.push({
        ROWID: 'held-claim', claim_key: 'lead:ZL2', claimed_at: new Date().toISOString(), request_reference: 'other-worker',
      });
    }
    let unavailable = true;
    const datastore = h.db.app.datastore;
    h.db.app.datastore = () => ({ table: (name) => {
      const table = datastore().table(name);
      if (name !== 'integration_logs') return table;
      return { ...table, insertRow: async (row) => {
        if (unavailable && row.external_lead_id === IDS[1] && row.status === 'FAILED') {
          throw new Error('Synthetic replay log unavailable');
        }
        return table.insertRow(row);
      } };
    } });

    const first = await deliver({ eventId: null });
    assert.ok(first.statusCode >= 500, `a lost ${hold} hold must not be acknowledged: ${first.statusCode}`);
    assert.equal(h.db.tables.webhook_events.length, 1);
    assert.equal(h.db.tables.webhook_events[0].event_id, null);
    assert.equal(h.db.tables.webhook_events[0].processing_status, 'FAILED');
    assert.ok(!h.db.tables.webhook_events[0].payload_json, 'the metadata-only event cannot supply a replay payload');
    assert.equal(h.db.tables.integration_logs.filter((row) => row.external_lead_id === IDS[1] && row.status === 'FAILED').length, 0);
    assert.deepEqual(h.oemWrites.map((entry) => entry.zohoLeadId), ['ZL1']);

    unavailable = false;
    const second = await deliver({ eventId: null });
    assert.equal(second.statusCode, 202, JSON.stringify(second.body));
    const persisted = h.db.tables.integration_logs.filter((row) => row.external_lead_id === IDS[1] && row.status === 'FAILED');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].error_message, hold === 'missing mapping' ? 'LEAD_MAPPING_NOT_FOUND' : 'CONCURRENT_UPDATE_IN_PROGRESS');
    assert.equal(h.db.tables.webhook_events.length, 2);
    assert.ok(h.db.tables.webhook_events.every((row) => row.event_id === null));
    assert.deepEqual(h.oemWrites.map((entry) => entry.zohoLeadId), ['ZL1'], 'redelivery does not duplicate the successful item');
  });
}

test('a later replayable mapping hold cannot mask an earlier unpersisted batch item', async (t) => {
  const { h, failures, deliver } = harness(t);
  failures.set(IDS[0], timeout());
  h.db.tables.lead_integrations = h.db.tables.lead_integrations.filter((row) => row.external_crm_lead_id !== IDS[1]);
  const datastore = h.db.app.datastore;
  h.db.app.datastore = () => ({ table: (name) => {
    const table = datastore().table(name);
    if (name !== 'integration_logs') return table;
    return { ...table, insertRow: async (row) => {
      if (row.external_lead_id === IDS[0] && row.status === 'FAILED') throw new Error('Synthetic first-item persistence failure');
      return table.insertRow(row);
    } };
  } });
  const response = await deliver({ eventId: null });
  assert.ok(response.statusCode >= 500, `last item's hold cannot acknowledge lost work: ${response.statusCode}`);
  assert.equal(response.body.error, 'INBOUND_WORK_NOT_PERSISTED');
  assert.equal(h.db.tables.webhook_events[0].processing_status, 'FAILED');
  assert.equal(h.db.tables.integration_logs.filter((row) => row.external_lead_id === IDS[0] && row.status === 'FAILED').length, 0);
  assert.equal(h.db.tables.integration_logs.filter((row) => row.external_lead_id === IDS[1] && row.status === 'FAILED').length, 1);
});
