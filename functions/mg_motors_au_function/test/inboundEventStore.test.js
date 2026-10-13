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
