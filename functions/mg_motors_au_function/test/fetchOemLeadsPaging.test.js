'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

process.env.ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || 'test-client-id';
process.env.ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || 'test-client-secret';
process.env.ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || 'test-refresh-token';
process.env.ZOHO_API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';
process.env.ZOHO_ACCOUNTS_DOMAIN = process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.in';
process.env.ZOHO_WEBHOOK_TOKEN = process.env.ZOHO_WEBHOOK_TOKEN || 'test-webhook-token';

function mockZoho(t, pages) {
  const zohoAuthService = require('../services/zohoAuthService');
  zohoAuthService._resetForTests();
  t.mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
  const calls = [];
  t.mock.method(axios, 'get', async (url, config) => {
    calls.push(config.params);
    const page = pages[calls.length - 1];
    return { data: { data: page.records, info: { more_records: Boolean(page.next), next_page_token: page.next } } };
  });
  return calls;
}

test('fetchOemLeads: follows next_page_token and never sends a page param (Zoho 2000-record limit)', async (t) => {
  delete process.env.LEAD_SYNC_SINCE;
  const calls = mockZoho(t, [
    { records: [{ id: '1' }, { id: '2' }], next: 'tok-2' },
    { records: [{ id: '3' }], next: null },
  ]);
  const { fetchOemLeads } = require('../services/zohoCrmService');

  const records = await fetchOemLeads();

  assert.deepEqual(records.map((r) => r.id), ['1', '2', '3']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].page, undefined);
  assert.equal(calls[0].page_token, undefined);
  assert.equal(calls[1].page_token, 'tok-2');
  assert.equal(calls[1].page, undefined);
});

test('fetchOemLeads: LEAD_SYNC_SINCE walks newest-first, stops at the cutoff and returns oldest-first', async (t) => {
  process.env.LEAD_SYNC_SINCE = '2026-10-08T00:00:00+11:00';
  t.after(() => { delete process.env.LEAD_SYNC_SINCE; });
  const calls = mockZoho(t, [
    {
      records: [
        { id: 'new2', Created_Time: '2026-10-08T15:00:00+11:00' },
        { id: 'new1', Created_Time: '2026-10-08T09:00:00+11:00' },
        { id: 'old1', Created_Time: '2026-10-07T23:59:00+11:00' },
      ],
      next: 'tok-2',
    },
    { records: [{ id: 'old0', Created_Time: '2026-10-01T00:00:00+11:00' }], next: null },
  ]);
  const { fetchOemLeads } = require('../services/zohoCrmService');

  const records = await fetchOemLeads();

  assert.deepEqual(records.map((r) => r.id), ['new1', 'new2']);
  assert.equal(calls.length, 1, 'must not fetch further pages once the cutoff is reached');
  assert.equal(calls[0].sort_order, 'desc');
});
