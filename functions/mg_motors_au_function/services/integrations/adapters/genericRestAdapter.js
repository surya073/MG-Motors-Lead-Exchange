'use strict';

const https = require('https');
const dns = require('dns').promises;
const { URL } = require('url');
const axios = require('axios');
const logger = require('../../../utils/logger');
const integrationAuthService = require('../integrationAuthService');
const { getAccessTokenForDealerZoho } = require('./zohoCrmOAuthHelper');

/**
 * genericRestAdapter.js
 * -----------------------------------------------------------------------
 * Implements the common adapter interface (createLead/updateLead/getLead/
 * testConnection) against a dealer-configured REST CRM. All requests go
 * through SSRF-guarded resolution and enforce HTTPS by default.
 *
 * Also doubles as the ZOHO_CRM adapter — a dealer whose external CRM
 * happens to be their own separate Zoho CRM org uses this same file
 * (same generic REST shape), just with:
 *   - OAuth2 access-token refresh instead of a static credential
 *     (buildAuthHeaders branches on crm_type === 'ZOHO_CRM')
 *   - request/response bodies wrapped in { data: [...] } per Zoho's
 *     CRM API convention (createLead/updateLead branch on the same flag)
 *
 * Retry policy lives here (not in crmIntegrationService) since "what
 * counts as transient" is an HTTP-layer concern specific to this adapter;
 * a future non-REST adapter (e.g. an SDK-based one) may have a completely
 * different retry model.
 */

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

const PRIVATE_IP_RANGES = [
  /^127\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,        // link-local, includes cloud metadata (169.254.169.254)
  /^::1$/, /^fc00:/, /^fe80:/,
];

function isPrivateIp(ip) {
  return PRIVATE_IP_RANGES.some((re) => re.test(ip));
}

/**
 * SSRF guard: resolves the hostname and rejects private/loopback/
 * link-local targets before any request is made. Re-checked on every
 * call (not cached) since DNS can change between config-save time and
 * 




 * request time (DNS rebinding).
 */
async function assertSafeUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    const err = new Error('Invalid URL');
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }

  if (parsed.protocol !== 'https:') {
    const err = new Error('Only HTTPS endpoints are allowed');
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === 'metadata.google.internal') {
    const err = new Error('URL resolves to a disallowed host');
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    const err = new Error('Could not resolve host');
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }

  if (addresses.some((a) => isPrivateIp(a.address))) {
    const err = new Error('URL resolves to a private/internal address');
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }

  return parsed;
}

async function buildAuthHeaders(catalystApp, integration) {
  // Dealer's external CRM is itself Zoho CRM — needs live OAuth2 token
  // refresh (access tokens expire ~1hr), not a static stored credential
  // like every other auth_type below. Checked first and returns early.
  if (integration.crm_type === 'ZOHO_CRM') {
    const accessToken = await getAccessTokenForDealerZoho(catalystApp, integration);
    return { Authorization: `Zoho-oauthtoken ${accessToken}` };
  }

  const credType = integrationAuthService.AUTH_TYPE_TO_CREDENTIAL_TYPE[integration.auth_type];
  const secret = credType
    ? await integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, credType)
    : null;

  if (!secret && integration.auth_type !== 'NONE') {
    const err = new Error('No credential configured for this integration');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  switch (integration.auth_type) {
    case 'API_KEY':
      return { 'X-API-Key': secret };
    case 'BEARER_TOKEN':
      return { Authorization: `Bearer ${secret}` };
    case 'BASIC_AUTH': {
      const username = integration.crm_name || 'dealer';
      return { Authorization: `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}` };
    }
    case 'CUSTOM_HEADER':
      return { 'X-Custom-Auth': secret };
    case 'OAUTH2':
      // V1 assumption: pre-obtained access token stored as the
      // credential, not a full OAuth2 flow. Flagging for review —
      // full client-credentials/token-refresh flow is a Phase 2 item
      // for any non-Zoho OAuth2 CRM. Zoho CRM specifically is handled
      // above via crm_type, not this branch.
      return { Authorization: `Bearer ${secret}` };
    default:
      return {};
  }
}

function isRetryableError(err) {
  if (!err.response) return true; // network/timeout error
  return RETRYABLE_STATUS_CODES.has(err.response.status);
}

async function requestWithRetry(config, attempt = 1) {
  try {
    return await axios(config);
  } catch (err) {
    if (attempt < MAX_RETRIES && isRetryableError(err)) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return requestWithRetry(config, attempt + 1);
    }
    throw err;
  }
}

async function createLead(catalystApp, integration, payload, { idempotencyKey } = {}) {
  const url = await assertSafeUrl(`${integration.base_url}${integration.create_lead_endpoint}`);
  const headers = await buildAuthHeaders(catalystApp, integration);

  const isZohoCrm = integration.crm_type === 'ZOHO_CRM';
  const requestBody = isZohoCrm ? { data: [payload] } : payload;

  const response = await requestWithRetry({
    method: integration.http_method || 'POST',
    url: url.toString(),
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
    },
    data: requestBody,
    timeout: 10000,
  });

  if (isZohoCrm) {
    const recordResult = response.data?.data?.[0];
    if (!recordResult || recordResult.status === 'error') {
      const err = new Error(recordResult?.message || 'Zoho CRM rejected the create');
      err.code = 'EXTERNAL_CRM_ERROR';
      err.response = { status: response.status, data: response.data };
      throw err;
    }
    return { externalLeadId: recordResult.details?.id, httpStatus: response.status, raw: response.data };
  }
  const externalLeadId = response.data?.id || response.data?.leadId;
  return { externalLeadId, httpStatus: response.status, raw: response.data };
}

async function updateLead(catalystApp, integration, externalLeadId, payload) {
  const endpoint = integration.update_lead_endpoint.replace('{externalLeadId}', encodeURIComponent(externalLeadId));
  const url = await assertSafeUrl(`${integration.base_url}${endpoint}`);
  const headers = await buildAuthHeaders(catalystApp, integration);

  const isZohoCrm = integration.crm_type === 'ZOHO_CRM';
  const requestBody = isZohoCrm ? { data: [payload] } : payload;

  const response = await requestWithRetry({
    method: integration.update_http_method || 'PUT',
    url: url.toString(),
    headers: { 'Content-Type': 'application/json', ...headers },
    data: requestBody,
    timeout: 10000,
  });

  if (isZohoCrm) {
    const recordResult = response.data?.data?.[0];
    if (!recordResult || recordResult.status === 'error') {
      const err = new Error(recordResult?.message || 'Zoho CRM rejected the update');
      err.code = 'EXTERNAL_CRM_ERROR';
      err.response = { status: response.status, data: response.data };
      throw err;
    }
  }

  return { httpStatus: response.status, raw: response.data };
}

async function getLead(catalystApp, integration, externalLeadId) {
  const endpoint = integration.update_lead_endpoint.replace('{externalLeadId}', encodeURIComponent(externalLeadId));
  const url = await assertSafeUrl(`${integration.base_url}${endpoint}`);
  const headers = await buildAuthHeaders(catalystApp, integration);

  const response = await requestWithRetry({
    method: 'GET',
    url: url.toString(),
    headers,
    timeout: 10000,
  });

  return { httpStatus: response.status, raw: response.data };
}

/**
 * Safe test — hits the base URL itself (or create-lead endpoint with
 * HEAD/OPTIONS if the CRM supports it) rather than creating a real lead.
 * V1 assumption: GET on base_url is treated as the "reachability" check.
 * If the dealer's CRM requires a dedicated health-check path, extend
 * dealer_integrations with a `test_endpoint` field later.
 */
async function testConnection(catalystApp, integration) {
  // Zoho's GET /crm/v8/Leads requires an explicit `fields` param —
  // omitting it returns 400 REQUIRED_PARAM_MISSING regardless of auth
  // or scope. Last_Name is always present on every Lead record, so
  // it's a safe universal choice just for this connectivity check.
  const testPath = integration.crm_type === 'ZOHO_CRM'
    ? '/crm/v8/Leads?per_page=1&fields=Last_Name'
    : '';
  const url = await assertSafeUrl(`${integration.base_url}${testPath}`);
  const headers = await buildAuthHeaders(catalystApp, integration);
  const start = Date.now();

  const response = await axios({
    method: 'GET',
    url: url.toString(),
    headers,
    timeout: 8000,
    validateStatus: () => true,
  });

  return {
    httpStatus: response.status,
    responseTimeMs: Date.now() - start,
    ok: response.status >= 200 && response.status < 300,
  };
}

module.exports = { createLead, updateLead, getLead, testConnection, assertSafeUrl };
