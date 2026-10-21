'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const dns = require('dns').promises;
const auth = require('../services/integrations/integrationAuthService');
const { createInMemoryZcql } = require('./helpers/inMemoryZcql');
const modulePath = require.resolve('../services/integrations/adapters/zohoCrmOAuthHelper');
const instanceA = require(modulePath);
delete require.cache[modulePath];
const instanceB = require(modulePath);

function fixture(t) {
  const oldKey = process.env.INTEGRATION_CREDENTIALS_KEY;
  process.env.INTEGRATION_CREDENTIALS_KEY = Buffer.alloc(32, 7).toString('base64');
  t.after(() => {
    if (oldKey === undefined) delete process.env.INTEGRATION_CREDENTIALS_KEY;
    else process.env.INTEGRATION_CREDENTIALS_KEY = oldKey;
  });
  instanceA._resetForTests();
  instanceB._resetForTests();
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const integration = {
    ROWID: '1000', crm_type: 'ZOHO_CRM', base_url: 'https://www.zohoapis.in',
    oauth_accounts_domain: 'https://accounts.zoho.in',
  };
  const db = createInMemoryZcql({
    dealer_integrations: [{ ...integration }],
    integration_credentials: ['CLIENT_ID', 'CLIENT_SECRET', 'REFRESH_TOKEN'].map((type, index) => ({
      ROWID: String(2000 + index), integration_id: '1000', credential_type: `OAUTH2_${type}`,
      encrypted_value: auth.encrypt(`old-${type}`),
    })),
  });
  const rotate = (type, value) => {
    db.tables.integration_credentials.find((row) => row.credential_type === `OAUTH2_${type}`).encrypted_value = auth.encrypt(value);
  };
  return { db, integration, rotate };
}

const response = (token) => ({ data: { access_token: token, expires_in: 3600 } });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('all warm instances detect a persisted credential rotation, while unchanged generations remain cached', async (t) => {
  const { db, integration, rotate } = fixture(t);
  let calls = 0;
  t.mock.method(axios, 'post', async (_url, body) => {
    calls += 1;
    return response(new URLSearchParams(body).get('refresh_token'));
  });
  for (const instance of [instanceA, instanceB]) {
    assert.equal(await instance.getAccessTokenForDealerZoho(db.app, integration), 'old-REFRESH_TOKEN');
    assert.equal(await instance.getAccessTokenForDealerZoho(db.app, integration), 'old-REFRESH_TOKEN');
  }
  assert.equal(calls, 2);
  rotate('REFRESH_TOKEN', 'new-refresh-token');
  // No local cache invalidation: this models a save in another function instance.
  for (const instance of [instanceA, instanceB]) {
    assert.equal(await instance.getAccessTokenForDealerZoho(db.app, integration), 'new-refresh-token');
  }
  assert.equal(calls, 4);
});

test('an old refresh cannot return or replace a token issued after a concurrent rotation', async (t) => {
  const { db, integration, rotate } = fixture(t);
  const started = deferred();
  const finishOld = deferred();
  t.mock.method(axios, 'post', async (_url, body) => {
    if (new URLSearchParams(body).get('refresh_token') === 'old-REFRESH_TOKEN') {
      started.resolve();
      await finishOld.promise;
      return response('old-token');
    }
    return response('new-token');
  });
  const oldRequest = instanceA.getAccessTokenForDealerZoho(db.app, integration);
  const rejected = assert.rejects(oldRequest, { code: 'INVALID_CRM_CONFIGURATION' });
  await started.promise;
  rotate('REFRESH_TOKEN', 'new-refresh-token');
  assert.equal(await instanceA.getAccessTokenForDealerZoho(db.app, integration), 'new-token');
  finishOld.resolve();
  await rejected;
  assert.equal(await instanceA.getAccessTokenForDealerZoho(db.app, integration), 'new-token');
});

test('a cross-instance datacenter change rejects stale callers and an already pending refresh', async (t) => {
  const { db, integration } = fixture(t);
  const started = deferred();
  const finishOld = deferred();
  t.mock.method(axios, 'post', async (url) => {
    if (new URL(url).hostname === 'accounts.zoho.in') {
      started.resolve(); await finishOld.promise;
      return response('old-region');
    }
    return response('new-region');
  });
  const oldRequest = instanceA.getAccessTokenForDealerZoho(db.app, integration);
  const rejected = assert.rejects(oldRequest, { code: 'INVALID_CRM_CONFIGURATION' });
  await started.promise;
  const changed = { ...integration, base_url: 'https://www.zohoapis.com.au', oauth_accounts_domain: 'https://accounts.zoho.com.au' };
  Object.assign(db.tables.dealer_integrations[0], changed);
  await assert.rejects(instanceB.getAccessTokenForDealerZoho(db.app, integration), { code: 'INVALID_CRM_CONFIGURATION' });
  assert.equal(await instanceB.getAccessTokenForDealerZoho(db.app, changed), 'new-region');
  finishOld.resolve();
  await rejected;
});

test('local invalidation prevents a pending refresh returning even before credential writes finish', async (t) => {
  const { db, integration } = fixture(t);
  const started = deferred(); const finish = deferred();
  t.mock.method(axios, 'post', async () => { started.resolve(); await finish.promise; return response('old-token'); });
  const request = instanceA.getAccessTokenForDealerZoho(db.app, integration);
  const rejected = assert.rejects(request, { code: 'INVALID_CRM_CONFIGURATION' });
  await started.promise;
  instanceA.invalidateToken(integration.ROWID);
  finish.resolve();
  await rejected;
});

test('credential reads fail closed on duplicates, missing values, corruption and datastore failure', async (t) => {
  const { db, integration } = fixture(t);
  const post = t.mock.method(axios, 'post', async () => response('must-not-issue'));
  const original = db.tables.integration_credentials.slice();
  db.tables.integration_credentials.push({ ...original[0], ROWID: '9999' });
  await assert.rejects(instanceA.getAccessTokenForDealerZoho(db.app, integration), { code: 'INVALID_CRM_CONFIGURATION' });
  db.tables.integration_credentials.splice(0, db.tables.integration_credentials.length, ...original.slice(0, 2));
  await assert.rejects(instanceA.getAccessTokenForDealerZoho(db.app, integration), { code: 'AUTHENTICATION_FAILED' });
  db.tables.integration_credentials.push({ ...original[2], encrypted_value: 'corrupt' });
  await assert.rejects(instanceA.getAccessTokenForDealerZoho(db.app, integration), { code: 'CREDENTIAL_DECRYPT_FAILED' });
  const unavailable = { datastore: () => ({ table: () => ({ getRow: async () => { throw new Error('unavailable'); } }) }) };
  await assert.rejects(instanceA.getAccessTokenForDealerZoho(unavailable, integration), /unavailable/);
  assert.equal(post.mock.callCount(), 0);
});
