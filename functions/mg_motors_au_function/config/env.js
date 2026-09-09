'use strict';

const REQUIRED_VARS = [
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
  'ZOHO_API_DOMAIN',
  'ZOHO_ACCOUNTS_DOMAIN',
  'ZOHO_WEBHOOK_TOKEN'
];

function getZohoConfig() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `Set these in Catalyst Console → mg_motors_au_function → Environment Variables.`
    );
  }

  return {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    apiDomain: process.env.ZOHO_API_DOMAIN,
    accountsDomain: process.env.ZOHO_ACCOUNTS_DOMAIN,
    webhookToken: process.env.ZOHO_WEBHOOK_TOKEN,
  };
}

/**
 * Kept as a SEPARATE function from getZohoConfig() deliberately — this
 * key is only needed by integrationAuthService.js when a dealer's
 * EXTERNAL_CRM integration actually saves/reads a credential. Bundling
 * it into REQUIRED_VARS above would mean every existing Zoho sync call
 * (which has nothing to do with dealer CRM integrations) starts failing
 * for shops that haven't set this var yet.
 *
 * Must be 32 raw bytes, base64-encoded, e.g. generated once via:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * and stored in Catalyst Console → mg_motors_au_function → Environment
 * Variables as INTEGRATION_CREDENTIALS_KEY.
 */
function getIntegrationCredentialsKey() {
  const key = process.env.INTEGRATION_CREDENTIALS_KEY;
  if (!key) {
    throw new Error(
      'Missing required environment variable: INTEGRATION_CREDENTIALS_KEY. ' +
      'Set this in Catalyst Console → mg_motors_au_function → Environment Variables ' +
      '(32 random bytes, base64-encoded).'
    );
  }
  return key;
}

module.exports = { getZohoConfig, getIntegrationCredentialsKey };