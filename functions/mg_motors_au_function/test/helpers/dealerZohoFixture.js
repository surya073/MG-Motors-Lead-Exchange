'use strict';
const crypto = require('crypto');
const auth = require('../../services/integrations/integrationAuthService');
const baseIntegration = { crm_type: 'ZOHO_CRM', base_url: 'https://www.zohoapis.in' };
const oauthApp = (integration) => ({
  datastore: () => ({ table: () => ({ getRow: async () => integration }) }),
});
// Existing tests stub individual secrets. Adapt that fixture to the new batched
// persisted snapshot; generation/race regressions use the real encrypted store.
function mockCredentialSnapshot(t) {
  t.mock.method(auth, 'getCredentialSnapshot', async (app, id, types) => {
    const credentials = Object.fromEntries(await Promise.all(types.map(async (type) =>
      [type, await auth.getDecryptedCredential(app, id, type)])));
    return { credentials, generation: crypto.createHash('sha256').update(JSON.stringify(credentials)).digest('hex') };
  });
}
module.exports = { baseIntegration, oauthApp, mockCredentialSnapshot };
