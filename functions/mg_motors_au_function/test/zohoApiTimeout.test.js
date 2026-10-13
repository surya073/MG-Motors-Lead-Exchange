'use strict';

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

// Batch 8 (FUSION_REMEDIATION_PLAN.md), Q30: MG's own Zoho calls had no
// timeout, so one slow call could hold a request until Catalyst ended the
// function. ZOHO_API_TIMEOUT_MS (unset = no timeout, as before) bounds every
// call zohoCrmService and zohoAuthService make.

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const zohoAuthService = require('../services/zohoAuthService');
const zohoCrmService = require('../services/zohoCrmService');
const { getZohoApiTimeoutMs } = require('../config/env');

function withTimeout(t, value) {
  const before = process.env.ZOHO_API_TIMEOUT_MS;
  if (value === null) delete process.env.ZOHO_API_TIMEOUT_MS; else process.env.ZOHO_API_TIMEOUT_MS = value;
  t.after(() => { if (before === undefined) delete process.env.ZOHO_API_TIMEOUT_MS; else process.env.ZOHO_API_TIMEOUT_MS = before; });
}

function recordCalls(t) {
  zohoAuthService._resetForTests();
  const calls = [];
  t.mock.method(axios, 'post', async (url, body, config) => {
    calls.push({ kind: 'token', config });
    return { data: { access_token: 'tok', expires_in: 3600 } };
  });
  t.mock.method(axios, 'get', async (url, config) => {
    calls.push({ kind: `get ${url.split('/crm/v8/')[1]}`, config });
    if (url.includes('settings/fields')) {
      return { data: { fields: [{ api_name: 'Lead_Status', pick_list_values: [{ actual_value: 'Open', display_value: 'Open' }] }] } };
    }
    return { data: { data: [], info: { more_records: false } } };
  });
  t.mock.method(axios, 'put', async (url, body, config) => {
    calls.push({ kind: 'put', config });
    return { data: { data: [{ code: 'SUCCESS', status: 'success' }] } };
  });
  return calls;
}

async function everyCall() {
  await zohoCrmService.updateOemLead('1', { Lead_Status: 'Contacted' });
  await zohoCrmService.fetchOemLeadsByIds(['1']);
  await zohoCrmService.fetchFieldPicklistValues('Leads', 'Lead_Status');
  await zohoCrmService.fetchDealerMaster();
  await zohoCrmService.fetchOemLeads();
  await zohoCrmService.fetchOemLeadsModifiedSince(new Date('2026-10-13T00:00:00Z'));
}

test('ZOHO_API_TIMEOUT_MS: unset, blank, zero or not a whole number means no timeout', (t) => {
  for (const value of [null, '', '0', '-1', 'fast', '1.5']) {
    withTimeout(t, value);
    assert.equal(getZohoApiTimeoutMs(), undefined, String(value));
  }
  process.env.ZOHO_API_TIMEOUT_MS = ' 15000 ';
  assert.equal(getZohoApiTimeoutMs(), 15000);
});

test('set: every Zoho call (token, reads, the lead write) carries the timeout', async (t) => {
  withTimeout(t, '15000');
  const calls = recordCalls(t);
  await everyCall();
  assert.ok(calls.length >= 7, `${calls.length} calls`);
  for (const call of calls) assert.equal(call.config?.timeout, 15000, call.kind);
});

test('unset: no Zoho call carries a timeout, exactly as before', async (t) => {
  withTimeout(t, null);
  const calls = recordCalls(t);
  await everyCall();
  for (const call of calls) assert.equal(Object.prototype.hasOwnProperty.call(call.config || {}, 'timeout'), false, call.kind);
});
