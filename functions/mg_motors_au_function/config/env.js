'use strict';

/**
 * env.js
 * -----------------------------------------------------------------------
 * Single source of truth for reading Zoho CRM OAuth config from Catalyst
 * environment variables. Nothing else in the function should read
 * process.env directly for these — import from here instead, so a
 * missing variable fails loudly and in one place, not deep inside an
 * HTTP call with a confusing axios error.
 *
 * Values themselves are set in Catalyst Console → your function →
 * Environment Variables (or injected at deploy time) — never committed
 * to source.
 */

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
    apiDomain: process.env.ZOHO_API_DOMAIN,       // e.g. https://www.zohoapis.in
    accountsDomain: process.env.ZOHO_ACCOUNTS_DOMAIN, // e.g. https://accounts.zoho.in
    webhookToken: process.env.ZOHO_WEBHOOK_TOKEN,
  };
}

module.exports = { getZohoConfig };