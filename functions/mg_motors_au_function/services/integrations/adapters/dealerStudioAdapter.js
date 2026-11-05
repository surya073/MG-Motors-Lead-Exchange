'use strict';

const axios = require('axios');
const logger = require('../../../utils/logger');
const usageContext = require('../../usageContext');
const integrationAuthService = require('../integrationAuthService');
const { assertSafeUrl, safeRequestOptions } = require('./safeHttp');
const { nestDottedKeys } = require('./nestDottedKeys');

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
 * crmIntegrationService builds from the dealer's Field Mappings and
 * dealerStudioPayload.js (category, provider, source, consent, transcript),
 * with dotted targets ("address_attributes.postcode", "fields.make") nested
 * here. See dealerStudioMappings.js for the confirmed default mapping.
 * Dealer Studio requires email, a phone number, category, source and one
 * dealership identifier (dealership_id, dealership_slug or dealer_code) on
 * create, and the dealership identifier again on every update. No lead_state
 * and no subsource are ever sent.
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
 * Dealer Studio answers 422 with { field: ["message", ...] }. Field names and
 * their validation messages (e.g. "name: can't be blank") say what to fix and
 * carry no lead data; only string messages are kept, and the text is capped.
 */
function validationDetail(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const parts = Object.entries(body)
    .filter(([, messages]) => Array.isArray(messages) && messages.some((m) => typeof m === 'string'))
    .map(([field, messages]) => `${String(field).slice(0, 40)}: ${messages.filter((m) => typeof m === 'string').join(', ').slice(0, 60)}`);
  return parts.length ? parts.join('; ').slice(0, 200) : null;
}

/**
 * Never includes the request body, the API key or the response body in a
 * thrown message: lead data and secrets must not reach logs. Only the HTTP
 * status and a short top-level message/title from the error body.
 */
function wrapError(err, contextMessage) {
  const body = err.response?.data;
  const text = [body?.title, body?.message, body?.error].find((v) => typeof v === 'string' && v.trim());
  const detail = text ? text.trim().slice(0, 120) : validationDetail(body);
  const wrapped = new Error(
    `${contextMessage} (HTTP ${err.response?.status || 'network error'}${detail ? `: ${detail}` : ''})`
  );
  wrapped.code = classifyDealerStudioError(err);
  wrapped.response = err.response ? { status: err.response.status } : undefined;
  // Saved with the activity log row (field_changes) so the failing fields show
  // there, not only in the function logs. Status and validation text only.
  if (err.response?.status && detail) wrapped.vendor = { status: err.response.status, detail };
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

/**
 * When the dealer's config names a Dealer Studio dealership slug, that slug
 * identifies the dealership instead of MG's dealer_code (which Dealer Studio
 * answers with 401 "API key not authorised for this dealership" unless it
 * has been set up on their side). Dealer Studio takes one identifier, so
 * dealer_code is replaced, not sent alongside.
 */
function withDealershipSlug(integration, payload) {
  const slug = typeof integration.dealership_slug === 'string' ? integration.dealership_slug.trim() : '';
  if (!slug || payload === undefined) return payload;
  const { dealer_code: _mgDealerCode, dealership_id: _id, ...rest } = payload;
  return { ...rest, dealership_slug: slug };
}

/**
 * Several MG dealers can share one Dealer Studio dealership (same slug) while
 * each trading from its own location. When the dealer's config carries a
 * Dealer Studio location id, it is sent as the integer `location_id` so the lead
 * lands on that location. Dealer Studio answers 422 if the id does not belong to
 * the dealership ("must belong to dealership") or does not exist.
 * Blank / non-numeric config sends nothing.
 */
function withDealershipLocation(integration, payload) {
  if (payload === undefined) return payload;
  const raw = integration.dealership_location_id;
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!/^\d{1,15}$/.test(text)) return payload;
  return { ...payload, location_id: Number(text) };
}

/** Dealership slug + location id, applied to every outgoing lead body. */
function withDealershipTarget(integration, payload) {
  return withDealershipLocation(integration, withDealershipSlug(integration, payload));
}

/**
 * The names (never the values) of the fields in the lead body, so what MG sent
 * can be shown to Dealer Studio without logging customer data: top-level keys,
 * plus the keys inside the nested `fields` and `address_attributes` objects.
 */
function describeLeadFields(lead) {
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return [];
  const names = [];
  Object.keys(lead).forEach((key) => {
    const value = lead[key];
    if (['fields', 'address_attributes'].includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      Object.keys(value).forEach((inner) => names.push(`${key}.${inner}`));
    } else {
      names.push(key);
    }
  });
  return names.sort();
}

async function request(catalystApp, integration, { method, path, payload, idempotencyKey }) {
  const url = await assertSafeUrl(`${integration.base_url}${path}`);
  // Dealer Studio wants { "lead": { ... } } on both create and update.
  // Mapped targets such as "address_attributes.postcode" and "fields.make" become nested objects.
  const data = payload === undefined ? undefined : serializeBody({ lead: nestDottedKeys(withDealershipTarget(integration, payload), 'dealerStudioAdapter') });
  const apiKey = await getApiKey(catalystApp, integration);
  if (payload !== undefined) {
    const sent = describeLeadFields(nestDottedKeys(withDealershipTarget(integration, payload), 'dealerStudioAdapter'));
    logger.info('dealerStudioAdapter', `${method} lead for dealer ${integration.dealer_code} sends fields: ${sent.join(', ')}${sent.includes('lead_state') || sent.includes('status') ? ' (STATUS FIELD PRESENT)' : ' (no status field)'}`);
  }
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
  _test: { classifyDealerStudioError, updatePath, extractExternalLeadId, withDealershipSlug, withDealershipLocation, withDealershipTarget, describeLeadFields },
};
