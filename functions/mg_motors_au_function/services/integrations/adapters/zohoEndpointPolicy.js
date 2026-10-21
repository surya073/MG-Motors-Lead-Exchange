'use strict';

// Exact Zoho datacenter hosts, not an arbitrary *.zoho.* suffix. Sources:
// https://www.zoho.com/crm/developer/docs/api/v8/multi-dc.html
// https://www.zoho.com/developer/oauth/multi-dc-support.html
const DATA_CENTERS = ['com', 'com.au', 'eu', 'in', 'com.cn', 'jp', 'ca', 'sa', 'uk'];
const ACCOUNTS_HOSTS = new Set([
  ...DATA_CENTERS.filter((dc) => dc !== 'ca').map((dc) => `accounts.zoho.${dc}`),
  'accounts.zohocloud.ca',
]);
const API_HOSTS = new Set(DATA_CENTERS.flatMap((dc) =>
  ['www', 'sandbox', 'developer'].map((environment) => `${environment}.zohoapis.${dc}`)
));

function assertZohoEndpoint(rawUrl, kind) {
  let url;
  try { url = new URL(rawUrl); } catch { url = null; }
  const hosts = kind === 'accounts' ? ACCOUNTS_HOSTS : API_HOSTS;
  if (!url || url.protocol !== 'https:' || url.username || url.password ||
      url.port || !hosts.has(url.hostname.toLowerCase())) {
    const err = new Error(`Dealer Zoho ${kind === 'accounts' ? 'OAuth' : 'CRM'} endpoint must use an official HTTPS Zoho host`);
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }
  return url;
}

module.exports = { assertZohoEndpoint };
