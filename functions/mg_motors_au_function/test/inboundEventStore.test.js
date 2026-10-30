'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 6 (FUSION_REMEDIATION_PLAN.md), store before processing: with
// INBOUND_EVENT_STORE on, a Fusion SD webhook is stored, encrypted, with the
// dealer lead id it is about, before it is processed (Q22: Fusion only). The
// new columns (payload_encrypted, external_lead_id, attempt_count,
// lease_until) are added in the Catalyst console first; until they exist the
// event is recorded exactly as today.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const integrationAuthService = require('../services/integrations/integrationAuthService');
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const { isInboundEventStoreEnabled } = require('../config/env');

const FUSION = { ROWID: '37148000001003095', dealer_code: '725001', crm_type: 'FUSION_SD' };
const ZOHO = { ROWID: '37148000000735999', dealer_code: 'AU008', crm_type: 'ZOHO_CRM' };
const BODY = Buffer.from(JSON.stringify({ lead_id: 'lead_01ABC', status: 'Lost', email: 'jane@example.com' }));

function withEnv(t, vars) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.entries(vars).forEach(([k, v]) => { if (v === null) delete process.env[k]; else process.env[k] = v; });
  t.after(() => Object.entries(before).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }));
}

function setup(t, { store = 'true', key = crypto.randomBytes(32).toString('base64') } = {}) {
  withEnv(t, { INBOUND_EVENT_STORE: store, INTEGRATION_CREDENTIALS_KEY: key });
  return createInMemoryZcql({ webhook_events: [] }, { enforceUnique: true });
}

const record = (db, integration, eventId, externalLeadId = 'lead_01ABC') =>
  crmIntegrationService.checkAndRecordWebhookEvent(db.app, integration, BODY, eventId, { externalLeadId });

test('INBOUND_EVENT_STORE is off unless set to true', (t) => {
  withEnv(t, { INBOUND_EVENT_STORE: null });
  assert.equal(isInboundEventStoreEnabled(), false);
  process.env.INBOUND_EVENT_STORE = 'TRUE';
  assert.equal(isInboundEventStoreEnabled(), true);
});

test('flag on, Fusion: the event is stored encrypted with its dealer lead id, one attempt and a lease', async (t) => {
  const db = setup(t);
  const before = Date.now();
  const result = await record(db, FUSION, 'msg_1');
  assert.equal(result.isDuplicate, false);
  const row = db.tables.webhook_events[0];
  assert.equal(row.event_id, 'msg_1');
  assert.equal(row.dedupe_key, `${FUSION.ROWID}:msg_1`);
  assert.equal(row.external_lead_id, 'lead_01ABC');
  assert.equal(row.attempt_count, 1);
  assert.equal(row.processing_status, 'RECEIVED');
  assert.equal(integrationAuthService.decrypt(row.payload_encrypted), BODY.toString('utf8'));
  assert.equal(row.payload_encrypted.includes('jane'), false, 'no plaintext PII');
  const leaseUntil = Date.parse(`${row.lease_until.replace(' ', 'T')}Z`);
  assert.ok(leaseUntil >= before + 110 * 1000 && leaseUntil <= Date.now() + 130 * 1000, row.lease_until);
});

test('flag off, Fusion: recorded exactly as today (no payload, no lead id, no lease)', async (t) => {
  const db = setup(t, { store: null });
  await record(db, FUSION, 'msg_1');
  const row = db.tables.webhook_events[0];
  for (const column of ['payload_encrypted', 'external_lead_id', 'attempt_count', 'lease_until']) {
    assert.equal(Object.prototype.hasOwnProperty.call(row, column), false, column);
  }
});

test('flag on: a ZOHO_CRM dealer is recorded exactly as today (Q22: Fusion only)', async (t) => {
  const db = setup(t);
  await record(db, ZOHO, null);
  const row = db.tables.webhook_events[0];
  assert.equal(Object.prototype.hasOwnProperty.call(row, 'payload_encrypted'), false);
  assert.equal(row.event_id, null);
});

test('flag on but the new columns are not created yet: the event is recorded as today', async (t) => {
  const db = setup(t);
  const table = db.app.datastore().table('webhook_events');
  const original = db.app.datastore;
  db.app.datastore = () => ({
    table: (name) => {
      const real = original().table(name);
      return {
        ...real,
        insertRow: async (fields) => {
          if ('payload_encrypted' in fields) throw new Error('Invalid input value for column payload_encrypted');
          return real.insertRow(fields);
        },
      };
    },
  });
  assert.ok(table);
  const result = await record(db, FUSION, 'msg_1');
  assert.equal(result.isDuplicate, false);
  assert.equal(db.tables.webhook_events.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(db.tables.webhook_events[0], 'payload_encrypted'), false);
});

test('flag on but the payload cannot be encrypted (no key): the event is recorded as today, not refused', async (t) => {
  const db = setup(t, { key: null });
  const result = await record(db, FUSION, 'msg_1');
  assert.equal(result.isDuplicate, false);
  assert.equal(Object.prototype.hasOwnProperty.call(db.tables.webhook_events[0], 'payload_encrypted'), false);
});

test('an event id too long for dedupe_key (varchar 100) or event_id (150) still records, and repeats are still caught', async (t) => {
  const db = setup(t, { store: null });
  const longId = `msg_${'x'.repeat(200)}`;
  const first = await record(db, ZOHO, longId);
  assert.equal(first.isDuplicate, false);
  const row = db.tables.webhook_events[0];
  assert.ok(row.dedupe_key.length <= 100, row.dedupe_key);
  assert.ok(row.event_id.length <= 150);
  const again = await record(db, ZOHO, longId);
  assert.equal(again.isDuplicate, true);
  const other = await record(db, ZOHO, `${longId}y`);
  assert.equal(other.isDuplicate, false, 'a different long id is a different event');
});

test('a normal-length event id keeps today\'s dedupe key', async (t) => {
  const db = setup(t, { store: null });
  await record(db, ZOHO, 'evt-42');
  assert.equal(db.tables.webhook_events[0].dedupe_key, `${ZOHO.ROWID}:evt-42`);
});

// Batch 6, C4: a repeated event id is no longer always "duplicate". Never
// answer 200 for work that was not done: only a SUCCESS event is a true
// duplicate; one still being processed (RECEIVED, live lease) is "in
// progress"; a FAILED, PENDING or abandoned (RECEIVED, lease expired) one is
// processed again, under a new lease.
const { toCatalystDateTime } = require('../utils/dateFormat');

function seeded(t, existing, options) {
  const db = setup(t, options);
  db.tables.webhook_events.push({
    integration_id: FUSION.ROWID, dealer_code: '725001', event_id: 'msg_1', dedupe_key: `${FUSION.ROWID}:msg_1`,
    attempt_count: 1, ...existing,
  });
  return db;
}
const inSeconds = (s) => toCatalystDateTime(new Date(Date.now() + s * 1000));

test('C4: a repeat of a SUCCESS event is a duplicate', async (t) => {
  const db = seeded(t, { processing_status: 'SUCCESS', lease_until: inSeconds(-500) });
  assert.deepEqual(await record(db, FUSION, 'msg_1'), { isDuplicate: true });
  assert.equal(db.tables.webhook_events[0].attempt_count, 1);
});

test('C4: a repeat while the first delivery is still being processed is "in progress", not processed twice', async (t) => {
  const db = seeded(t, { processing_status: 'RECEIVED', lease_until: inSeconds(60) });
  assert.deepEqual(await record(db, FUSION, 'msg_1'), { isDuplicate: true, inProgress: true });
  assert.equal(db.tables.webhook_events[0].attempt_count, 1);
});

for (const [label, existing] of [
  ['abandoned (RECEIVED, lease expired: the instance died)', { processing_status: 'RECEIVED', lease_until: inSeconds(-1) }],
  ['FAILED', { processing_status: 'FAILED', lease_until: inSeconds(-300) }],
  ['PENDING (held)', { processing_status: 'PENDING', lease_until: inSeconds(-300) }],
  ['FAILED that finished inside its lease', { processing_status: 'FAILED', lease_until: inSeconds(90) }],
]) {
  test(`C4: a repeat of a ${label} event is processed again under a new lease`, async (t) => {
    const db = seeded(t, existing);
    const result = await record(db, FUSION, 'msg_1');
    assert.deepEqual(result, { isDuplicate: false, eventRowId: '1000', reprocessed: true });
    const row = db.tables.webhook_events[0];
    assert.equal(db.tables.webhook_events.length, 1);
    assert.equal(row.processing_status, 'RECEIVED');
    assert.equal(row.attempt_count, 2);
    assert.ok(Date.parse(`${row.lease_until.replace(' ', 'T')}Z`) > Date.now() + 100 * 1000);
  });
}

test('C4: an old row without the Batch 6 columns is processed again too', async (t) => {
  const db = setup(t);
  db.tables.webhook_events.push({ integration_id: FUSION.ROWID, event_id: 'msg_1', dedupe_key: `${FUSION.ROWID}:msg_1`, processing_status: 'FAILED' });
  const result = await record(db, FUSION, 'msg_1');
  assert.equal(result.reprocessed, true);
  assert.equal(db.tables.webhook_events[0].attempt_count, 2);
});

test('flag off, or another CRM type: a FAILED event is retried using baseline columns', async (t) => {
  const off = seeded(t, { processing_status: 'FAILED' }, { store: null });
  assert.deepEqual(await record(off, FUSION, 'msg_1'), { isDuplicate: false, eventRowId: '1000', reprocessed: true });
  assert.equal(off.tables.webhook_events[0].processing_status, 'RECEIVED');
  assert.ok(off.tables.webhook_events[0].received_at);
  assert.equal(off.tables.webhook_events[0].lease_until, undefined);

  const zoho = setup(t);
  zoho.tables.webhook_events.push({ integration_id: ZOHO.ROWID, event_id: 'e1', dedupe_key: `${ZOHO.ROWID}:e1`, processing_status: 'FAILED' });
  assert.deepEqual(await record(zoho, ZOHO, 'e1'), { isDuplicate: false, eventRowId: '1000', reprocessed: true });
  assert.equal(zoho.tables.webhook_events[0].processing_status, 'RECEIVED');
  assert.ok(zoho.tables.webhook_events[0].received_at);
  assert.equal(zoho.tables.webhook_events[0].attempt_count, undefined);
  assert.equal(zoho.tables.webhook_events[0].lease_until, undefined);
});

// Review of Batch 6: the Text column holds 10,000 characters, and a Fusion
// "whole lead" body with notes can exceed it once encrypted; the insert then
// fell back to no payload, silently losing replay and C4. With
// FUSION_INBOUND_V2, replay needs only lead_id, dealer_id, status and
// pushed_at, so only those are kept: it fits, and no customer details are
// stored. A body that still cannot fit is kept without its payload, with its
// lease, so a repeat is still handled.
const WHOLE_LEAD = {
  lead_id: 'lead_01ABC', dealer_id: '725001', status: 'Lost', pushed_at: '2026-10-13T10:00:00Z',
  first_name: 'Jane', email: 'jane@example.com', phone: '0412345678',
  notes: Array.from({ length: 40 }, (_, i) => ({ type: 'note', text: `call ${i} `.repeat(30) })),
};
const bodyOf = (payload) => Buffer.from(JSON.stringify(payload));

test('review: with FUSION_INBOUND_V2, only what replay needs is stored, so a long whole-lead body fits', async (t) => {
  const db = setup(t);
  withEnv(t, { FUSION_INBOUND_V2: 'true' });
  const body = bodyOf(WHOLE_LEAD);
  assert.ok(body.length > 10000, 'the raw body alone exceeds the column');
  await crmIntegrationService.checkAndRecordWebhookEvent(db.app, FUSION, body, 'msg_big', { externalLeadId: 'lead_01ABC' });
  const row = db.tables.webhook_events[0];
  assert.ok(row.payload_encrypted.length <= 10000);
  assert.deepEqual(JSON.parse(integrationAuthService.decrypt(row.payload_encrypted)), {
    lead_id: 'lead_01ABC', dealer_id: '725001', status: 'Lost', pushed_at: '2026-10-13T10:00:00Z',
  });
});

test('review: a body that cannot fit is stored without its payload but keeps its lease', async (t) => {
  const db = setup(t);
  withEnv(t, { FUSION_INBOUND_V2: null });
  await crmIntegrationService.checkAndRecordWebhookEvent(db.app, FUSION, bodyOf(WHOLE_LEAD), 'msg_big', { externalLeadId: 'lead_01ABC' });
  const row = db.tables.webhook_events[0];
  assert.equal(row.payload_encrypted, null);
  assert.equal(row.attempt_count, 1);
  assert.ok(row.lease_until);
  assert.equal(row.external_lead_id, 'lead_01ABC');
});

test('with FUSION_INBOUND_V2, Fusion\'s enquiryStatus and leadId are stored for replay too (28 Oct 2026 body)', async (t) => {
  const db = setup(t);
  withEnv(t, { FUSION_INBOUND_V2: 'true' });
  const body = bodyOf({
    event_id: 'e1', lead_id: 'lead_01ABC', leadId: 'lead_01ABC', dealer_id: '725001', dealer_name: 'Buckby Motors',
    pushed_at: '2026-10-28T00:29:44.838Z', enquiryStatus: 'Lost', lostReason: 'Bought-Another-Brand',
  });
  await crmIntegrationService.checkAndRecordWebhookEvent(db.app, FUSION, body, 'msg_e1', { externalLeadId: 'lead_01ABC' });
  assert.deepEqual(JSON.parse(integrationAuthService.decrypt(db.tables.webhook_events[0].payload_encrypted)), {
    lead_id: 'lead_01ABC', leadId: 'lead_01ABC', dealer_id: '725001', enquiryStatus: 'Lost', pushed_at: '2026-10-28T00:29:44.838Z',
    lostReason: 'Bought-Another-Brand',
  });
});

test('with FUSION_INBOUND_V2, a status under any other name is stored too, so it can be replayed once read (28 Oct 2026)', async (t) => {
  const db = setup(t);
  withEnv(t, { FUSION_INBOUND_V2: 'true' });
  const body = bodyOf({
    lead_id: 'lead_01ABC', dealer_id: '725001', first_name: 'Jane', enquiry_status: 'Lost', pushed_at: '2026-10-28T00:29:44.838Z',
  });
  await crmIntegrationService.checkAndRecordWebhookEvent(db.app, FUSION, body, 'msg_e2', { externalLeadId: 'lead_01ABC' });
  assert.deepEqual(JSON.parse(integrationAuthService.decrypt(db.tables.webhook_events[0].payload_encrypted)), {
    lead_id: 'lead_01ABC', dealer_id: '725001', enquiry_status: 'Lost', pushed_at: '2026-10-28T00:29:44.838Z',
  });
});
