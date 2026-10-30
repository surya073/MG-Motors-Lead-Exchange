'use strict';

const axios = require('axios');
const logger = require('../../../utils/logger');
const usageContext = require('../../usageContext');
const integrationAuthService = require('../integrationAuthService');
const { assertSafeUrl, safeRequestOptions } = require('./safeHttp');

/**
 * dealerStudioAdapter.js
 * -----------------------------------------------------------------------
 * Dedicated adapter for dealers whose external CRM is Dealer Studio
 * (crm_type = 'DEALER_STUDIO'). Same contract as every other adapter
 * (createLead/updateLead/getLead/testConnection), resolved through
 * crmAdapterFactory.getAdapter().
 *
 * CONTRACT — Dealer Studio's developer docs (https://dev.dealerstudio.com.au,
 * "Creating and Updating Leads") and the Two-Way Lead Integration Guide PDF,
 * summarised in data/dealerStudioDocs/DEALER_STUDIO_INTEGRATION.md.
 * Documented, and implemented here:
 *   - Base URL https://dashboard.dealerstudio.com.au (paths below carry /api/v1).
 *   - Bearer API key (Authorization: Bearer <key>), stored as the dealer's
 *     BEARER_TOKEN credential. No token exchange.
 *   - Create: POST /api/v1/leads. Update: PUT /api/v1/leads/{id}. Both bodies
 *     are wrapped in a top-level `lead` object: { "lead": { ... } }.
 *   - Create answers 201 { id, lead_cluster_id }.
 *   - A 422 means a category/source (or other) value did not match exactly.
 *
 * Field names are not hardcoded: the object inside `lead` is whatever
 * crmIntegrationService builds from the dealer's Field Mappings, sent flat.
 * Dealer Studio requires email, phone, category, source and one dealership
 * identifier (dealership_id, dealership_slug or dealer_code) on create, and
 * the dealership identifier again on every update.
 *
 * Not documented, so not guessed at: any idempotency support (the
 * Idempotency-Key header below is sent but Dealer Studio does not say it
 * honours it).
 * An update to a lead older than 3 days is answered 200 with a message and
 * is NOT applied; that body is returned in `raw` for the caller's log.
 *
 * Not supported: getLead (no read endpoint documented), so reconciliation
 * and replay skip these dealers. Status updates come back through the Lead
 * Cluster Webhook (POST /webhooks/dealers/{dealerCode}): X-Signature is
 * verified in webhookVerificationService.verifyDealerStudioWebhook and the
 * body is read by dealerStudioInbound.js.
 */

const DEFAULT_CREATE_PATH = '/api/v1/leads';
const MAX_BODY_BYTES = 32000;

const capabilities = Object.freeze({
  createLead: true,
  updateLead: true,
  getLead: false,
  statusUpdate: false,
  webhook: true, // Lead Cluster Webhook receiver: webhookVerificationService + dealerStudioInbound
  duplicateSearch: false,
});

function unsupported(operation) {
  const err = new Error(`Dealer Studio adapter does not support ${operation} (not documented in Dealer Studio's guide)`);
  err.code = 'UNSUPPORTED_OPERATION';
  throw err;
}

function classifyDealerStudioError(err) {
  const status = err.response?.status;
  if (status === 401 || status === 403) return 'AUTHENTICATION_FAILED';
  if (status === 400 || status === 422) return 'FIELD_MAPPING_INVALID';
  if (status === 404) return 'NOT_FOUND';
  return 'EXTERNAL_CRM_ERROR'; // 5xx, 429, network/timeout: retryable by the retry scheduler
}

/**
 * Never includes the request body, the API key or the response body in a
 * thrown message: lead data and secrets must not reach logs. Only the HTTP
 * status and a short top-level message/title from the error body.
 */
function wrapError(err, contextMessage) {
  const body = err.response?.data;
  const text = [body?.title, body?.message, body?.error].find((v) => typeof v === 'string' && v.trim());
  const detail = text ? text.trim().slice(0, 120) : null;
  const wrapped = new Error(
    `${contextMessage} (HTTP ${err.response?.status || 'network error'}${detail ? `: ${detail}` : ''})`
  );
  wrapped.code = classifyDealerStudioError(err);
  wrapped.response = err.response ? { status: err.response.status } : undefined;
  return wrapped;
}

async function getApiKey(catalystApp, integration) {
  const key = await integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'BEARER_TOKEN');
  if (!key) {
    const err = new Error('No Dealer Studio API key configured for this integration');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }
  return key;
}

function createPath(integration) {
  return String(integration.create_lead_endpoint || DEFAULT_CREATE_PATH).replace(/\/+$/, '');
}

// PUT /api/v1/leads/{id}, derived from the create path so there is one
// configured source of truth.
function updatePath(integration, externalLeadId) {
  return `${createPath(integration)}/${encodeURIComponent(externalLeadId)}`;
}

function serializeBody(payload) {
  let serialized;
  try { serialized = JSON.stringify(payload ?? {}); } catch {
    const err = new Error('Dealer Studio payload cannot be serialized as JSON');
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }
  if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
    const err = new Error(`Dealer Studio payload exceeds ${MAX_BODY_BYTES} bytes`);
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }
  return serialized;
}

// A value that can be a record id at all: not prose, markup, paths or empty.
const LEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function asLeadId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && LEAD_ID_PATTERN.test(value) ? value : undefined;
}

/**
 * Dealer Studio's 201 is { id, lead_cluster_id } (documented), so `id` is the
 * lead id. The other shapes are kept as a fallback only; if none match, no id
 * is returned and the orchestrator holds the lead as ACK_UNRESOLVED instead of
 * re-creating it. `lead_cluster_id` is not stored yet (it is needed later to
 * set a lead's status and to match cluster webhooks); it stays in `raw`.
 */
function extractExternalLeadId(response) {
  let body = response.data;
  if (typeof body === 'string' && body.trim()) {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (body && typeof body === 'object') {
    const candidates = [body.id, body.lead_id, body.leadId, body.data?.id, body.lead?.id];
    for (const candidate of candidates) {
      const id = asLeadId(candidate);
      if (id) return id;
    }
  }
  const location = response.headers?.location || response.headers?.Location;
  const match = typeof location === 'string' ? /\/leads\/([^/?#]+)\/?(?:[?#].*)?$/.exec(location) : null;
  if (match) {
    try { return asLeadId(decodeURIComponent(match[1])); } catch { return undefined; }
  }
  return undefined;
}

async function request(catalystApp, integration, { method, path, payload, idempotencyKey }) {
  const url = await assertSafeUrl(`${integration.base_url}${path}`);
  // Dealer Studio wants { "lead": { ... } } on both create and update.
  const data = payload === undefined ? undefined : serializeBody({ lead: payload });
  const apiKey = await getApiKey(catalystApp, integration);
  return usageContext.trackApiCall(integration.dealer_code, () => axios.request({
    method,
    url: url.toString(),
    ...safeRequestOptions(url),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
    },
    data,
    maxBodyLength: MAX_BODY_BYTES,
    timeout: 10000,
  }));
}

async function createLead(catalystApp, integration, payload, { idempotencyKey } = {}) {
  let response;
  try {
    response = await request(catalystApp, integration, {
      method: integration.http_method || 'POST',
      path: createPath(integration),
      payload,
      idempotencyKey,
    });
  } catch (err) {
    if (!err.response && err.code) throw err; // config/credential errors already carry a code
    logger.error('dealerStudioAdapter', `createLead failed for integration ${integration.ROWID} (HTTP ${err.response?.status || 'network error'})`);
    throw wrapError(err, 'Dealer Studio rejected the lead create request');
  }
  return { externalLeadId: extractExternalLeadId(response), httpStatus: response.status, raw: response.data };
}

async function updateLead(catalystApp, integration, externalLeadId, payload) {
  if (!externalLeadId) {
    const err = new Error('Dealer Studio updateLead needs the dealer lead id');
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }
  let response;
  try {
    response = await request(catalystApp, integration, {
      method: integration.update_http_method || 'PUT',
      path: updatePath(integration, externalLeadId),
      payload,
    });
  } catch (err) {
    if (!err.response && err.code) throw err;
    logger.error('dealerStudioAdapter', `updateLead failed for integration ${integration.ROWID} (HTTP ${err.response?.status || 'network error'})`);
    throw wrapError(err, 'Dealer Studio rejected the lead update request');
  }
  return { externalLeadId, httpStatus: response.status, raw: response.data };
}

async function getLead() {
  unsupported('getLead');
}

// Documented by Dealer Studio ("Creating and Updating Leads", Related endpoints):
// returns the API key's locations and users, and answers 401 for a bad key.
const KEY_CHECK_PATH = '/api/v1/apikeys/apikey_details.json';

/**
 * Checks the API key against GET /api/v1/apikeys/apikey_details.json. Only a
 * 2xx is ok: 401/403 means the key was rejected, 404 means the base URL is
 * wrong, 5xx or no answer means unreachable. The response body (locations and
 * users) is never read or logged. A missing key or an unsafe URL is a
 * configuration error, thrown like the other adapters do.
 */
async function testConnection(catalystApp, integration) {
  const url = await assertSafeUrl(`${integration.base_url}${KEY_CHECK_PATH}`);
  const apiKey = await getApiKey(catalystApp, integration);
  const start = Date.now();
  try {
    const response = await usageContext.trackApiCall(integration.dealer_code, () => axios.request({
      method: 'GET',
      url: url.toString(),
      ...safeRequestOptions(url),
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      timeout: 8000,
      validateStatus: () => true,
    }));
    return {
      httpStatus: response.status,
      responseTimeMs: Date.now() - start,
      ok: response.status >= 200 && response.status < 300,
    };
  } catch {
    return { httpStatus: 0, responseTimeMs: Date.now() - start, ok: false };
  }
}

module.exports = {
  createLead,
  updateLead,
  getLead,
  testConnection,
  capabilities,
  _test: { classifyDealerStudioError, updatePath, extractExternalLeadId },
};
