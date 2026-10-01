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

/**
 * Not added to REQUIRED_VARS / not throwing when missing — the AI
 * assistant routes already degrade gracefully (a clear "not configured"
 * error response) when these are absent, unlike Zoho config which every
 * sync call depends on.
 *
 * Names/casing here MUST match catalyst-config.json exactly
 * (`gemini_api_key`, `Sarvam_api_key`) — process.env keys are
 * case-sensitive, and a mismatch here previously made the AI assistant
 * 500 on every request despite the keys being configured.
 */
function getAiAssistantConfig() {
  return {
    geminiApiKey: process.env.gemini_api_key,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    sarvamApiKey: process.env.Sarvam_api_key,
  };
}

module.exports = { getZohoConfig, getIntegrationCredentialsKey, getAiAssistantConfig };