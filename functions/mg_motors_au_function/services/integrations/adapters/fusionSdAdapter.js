'use strict';

const axios = require('axios');
const logger = require('../../../utils/logger');
const { assertSafeUrl } = require('./genericRestAdapter');
const { getAccessTokenForFusionSd, invalidateToken } = require('./fusionSdOAuthHelper');
const { RESERVED_TARGET_SEGMENTS } = require('../leadMappingService');
const { isFusionInboundV2Enabled } = require('../../../config/env');

/**
 * fusionSdAdapter.js
 * -----------------------------------------------------------------------
 * Dedicated adapter for dealers whose external CRM is Fusion SD
 * (crm_type = 'FUSION_SD'). Implements the same adapter contract every
 * other adapter implements (createLead/updateLead/getLead/testConnection),
 * resolved via crmAdapterFactory.getAdapter('FUSION_SD') — nothing in
 * crmIntegrationService, leadSyncService, the retry scheduler, or
 * reconciliation needed to change to support this; they only ever call
 * through the factory.
 *
 * Reuses genericRestAdapter's assertSafeUrl (SSRF guard: HTTPS-only,
 * rejects private/loopback/link-local resolved addresses) rather than
 * duplicating it — everything else here is Fusion-specific and lives only
 * in this file, per the "keep provider logic inside adapters" requirement.
 *
 * capabilities is new (no other adapter exposes this yet) — a plain,
 * static description of what this integration can actually do, so callers
 * can check `fusionSdAdapter.capabilities.updateLead` instead of finding
 * out by calling it and getting an UNSUPPORTED_OPERATION error. Nothing
 * reads this yet (it's additive), but it's the natural place to record
 * capability as adapters for less REST-standard CRMs get added.
 *
 * ================================================================
 * CONTRACT — Fusion's Lead API OpenAPI file (D3 in FUSION_SD_AUDIT.md)
 * ================================================================
 * Documented, and implemented here: create (POST /v1/leads, a nested JSON
 * body, answered 201 { lead_id, status, received_at }), update
 * (PATCH /v1/leads/{lead_id}, RFC 7396 merge patch) and RFC 9457
 * problem+json errors whose `instance` is a correlation id. Token exchange
 * is in fusionSdOAuthHelper.js.
 *
 * Field names are still not hardcoded: the adapter nests whatever payload
 * crmIntegrationService builds from the dealer's configured Field Mappings,
 * so a field-name change is a mapping change, not a code change.
 *
 * Errors are classified by HTTP status (401/403 -> AUTHENTICATION_FAILED,
 * 400/422 -> FIELD_MAPPING_INVALID, 404 -> NOT_FOUND, anything else or no
 * response -> EXTERNAL_CRM_ERROR). Only the problem title and correlation
 * id (`instance`, or `correlation_id` as the QA host sends it) reach thrown
 * errors and logs.
 *
 * Not supported: getLead (Fusion documents no read endpoint). Fusion's
 * signed webhooks (Standard Webhooks) are verified and translated only with
 * FUSION_INBOUND_V2 on (Batch 5: webhookVerificationService.js and
 * fusionSdInbound.js), so `webhook` follows that flag. Callers check
 * `capabilities` via crmAdapterFactory.supports() before using either.
 */

const capabilities = Object.freeze({
  createLead: true,
  updateLead: true, // PATCH /v1/leads/{lead_id}, RFC 7396 merge patch (needs the leads:update scope)
  getLead: false,
  statusUpdate: false,
  get webhook() { return isFusionInboundV2Enabled(); }, // Standard Webhooks receiver, FUSION_INBOUND_V2 (audit H5)
  duplicateSearch: false,
});

function unsupported(operation) {
  const err = new Error(`Fusion SD adapter does not support ${operation} (capability not confirmed by Fusion's API docs)`);
  err.code = 'UNSUPPORTED_OPERATION';
  throw err;
}

function classifyFusionError(err) {
  const status = err.response?.status;
  if (status === 401 || status === 403) return 'AUTHENTICATION_FAILED';
  if (status === 400 || status === 422) return 'FIELD_MAPPING_INVALID';
  if (status === 404) return 'NOT_FOUND';
  if (!err.response) return 'EXTERNAL_CRM_ERROR'; // network/timeout — retryable, same as genericRestAdapter's isRetryableError
  return 'EXTERNAL_CRM_ERROR';
}

/**
 * Never includes the request/response body in logs or thrown error
 * messages — lead data and the access token must not reach logs per the
 * project's existing "no PII, no secrets in logs" rule.
 */
function wrapFusionError(err, contextMessage) {
  const code = classifyFusionError(err);
  // RFC 7807 problem+json: only the generic title and the request
  // correlation id (`correlation_id`, e.g. "lreq_..."; the OpenAPI doc calls it `instance`) are surfaced — they carry
  // no lead data and give Fusion support something concrete to trace.
  const problem = err.response?.data;
  const title = typeof problem?.title === 'string' ? problem.title.slice(0, 80) : null;
  const ref = problem?.correlation_id || problem?.instance;
  const instance = typeof ref === 'string' ? ref.slice(0, 60) : null;
  const extra = [title, instance && `ref ${instance}`].filter(Boolean).join(', ');
  const wrapped = new Error(
    `${contextMessage} (HTTP ${err.response?.status || 'network error'}${extra ? `: ${extra}` : ''})`
  );
  wrapped.code = code;
  wrapped.response = err.response ? { status: err.response.status } : undefined;
  if (err.response) wrapped.vendor = vendorDiagnostics(err.response);
  return wrapped;
}

// Retry-After is either seconds or an HTTP date (RFC 9110); returned as seconds.
function retryAfterSeconds(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * A safe copy of Fusion's error for the failure log: the HTTP status, the
 * RFC 9457 problem fields (truncated) and Retry-After. Never the request,
 * the token or the lead payload.
 */
function vendorDiagnostics(response) {
  const problem = response.data && typeof response.data === 'object' ? response.data : {};
  const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : undefined);
  const vendor = {
    status: response.status,
    type: text(problem.type, 200),
    title: text(problem.title, 120),
    detail: text(problem.detail, 300),
    instance: text(problem.instance || problem.correlation_id, 80),
    retryAfter: retryAfterSeconds(response.headers?.['retry-after'] ?? response.headers?.['Retry-After']),
  };
  return Object.fromEntries(Object.entries(vendor).filter(([, value]) => value !== undefined));
}

function isNestedGroup(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fusion's Lead API expects a nested body ({ contact: { firstName }, requirement:
 * { model } }), but field mappings produce flat keys. A mapping whose
 * target_field is a dotted path ("contact.firstName") is expanded here, so
 * the mapping table stays the single place field names are configured.
 * Keys without a dot pass through untouched.
 *
 * The mapping save route refuses unsafe targets; this is the second line of
 * defence. A key with a __proto__/prototype/constructor segment is skipped,
 * only own properties are walked, and a value never replaces a nested group
 * or the reverse: the first one written is kept and the other is logged.
 */
function nestDottedKeys(flat) {
  const out = {};
  const skip = (key, reason) => {
    logger.error('fusionSdAdapter', `Skipped mapping target "${key}": ${reason}`);
  };
  Object.entries(flat || {}).forEach(([key, value]) => {
    const parts = key.split('.').filter(Boolean);
    if (parts.some((part) => RESERVED_TARGET_SEGMENTS.has(part))) {
      skip(key, 'reserved path segment');
      return;
    }
    if (parts.length <= 1) {
      if (Object.hasOwn(out, key) && isNestedGroup(out[key])) {
        skip(key, 'it would replace a nested group of fields');
        return;
      }
      out[key] = value;
      return;
    }
    let node = out;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(node, part)) {
        node[part] = {};
      } else if (!isNestedGroup(node[part])) {
        skip(key, `"${part}" already holds a value`);
        return;
      }
      node = node[part];
    }
    const leaf = parts[parts.length - 1];
    if (Object.hasOwn(node, leaf) && isNestedGroup(node[leaf])) {
      skip(key, 'it would replace a nested group of fields');
      return;
    }
    node[leaf] = value;
  });
  return out;
}

/**
 * Sends one Fusion request with a bearer token. A 401 can mean the cached
 * token is stale (the keys were rotated, or saved on another instance), so
 * the token is dropped and the request retried once with a fresh one. Token
 * endpoint errors propagate as they are; a request error is returned for the
 * caller to classify.
 */
async function sendWithTokenRetry(catalystApp, integration, send) {
  const accessToken = await getAccessTokenForFusionSd(catalystApp, integration);
  try {
    return { response: await send(accessToken) };
  } catch (err) {
    if (err.response?.status !== 401) return { error: err };
  }

  invalidateToken(integration.ROWID, accessToken);
  const freshToken = await getAccessTokenForFusionSd(catalystApp, integration);
  try {
    return { response: await send(freshToken) };
  } catch (err) {
    return { error: err };
  }
}

// Fusion refuses request bodies over 32 KB. A lead that large is carrying
// long free text (a customer message or chat transcript an admin mapped), so
// the longest text values are shortened, with a marker, until the body fits
// and the lead is still delivered (answer to Q2). The same input always gives
// the same body, so a retry repeats it under the same Idempotency-Key.
const MAX_BODY_BYTES = 32000;
const TRUNCATION_MARKER = ' [truncated]';

function bodyWithinLimit(payload) {
  let body = nestDottedKeys(payload);
  let size = Buffer.byteLength(JSON.stringify(body));
  if (size <= MAX_BODY_BYTES) return body;

  const trimmed = { ...payload };
  const shortened = [];
  while (size > MAX_BODY_BYTES) {
    const [key, value] = Object.entries(trimmed)
      .filter(([, v]) => typeof v === 'string')
      .sort(([, a], [, b]) => Buffer.byteLength(b) - Buffer.byteLength(a))[0] || [];
    if (!key || value.length <= TRUNCATION_MARKER.length) break; // nothing left to shorten
    const keep = Math.max(0, value.length - (size - MAX_BODY_BYTES) - TRUNCATION_MARKER.length - 8);
    trimmed[key] = `${value.slice(0, keep)}${TRUNCATION_MARKER}`;
    if (!shortened.includes(key)) shortened.push(key);
    body = nestDottedKeys(trimmed);
    size = Buffer.byteLength(JSON.stringify(body));
  }
  logger.info('fusionSdAdapter', `Body over ${MAX_BODY_BYTES} bytes; shortened: ${shortened.join(', ')} (now ${size} bytes)`);
  return body;
}

async function createLead(catalystApp, integration, payload, { idempotencyKey } = {}) {
  const url = await assertSafeUrl(`${integration.base_url}${integration.create_lead_endpoint}`);
  const body = bodyWithinLimit(payload);

  const { response, error } = await sendWithTokenRetry(catalystApp, integration, (accessToken) => axios.request({
    method: integration.http_method || 'POST',
    url: url.toString(),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      // Fusion: "always send Idempotency-Key" — a retry after a timeout then
      // returns the original lead instead of creating a duplicate.
      ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
    },
    data: body,
    timeout: 10000,
  }));
  if (error) {
    logger.error(
      'fusionSdAdapter',
      `createLead failed for integration ${integration.ROWID} (HTTP ${error.response?.status || 'network error'})`
    );
    throw wrapFusionError(error, 'Fusion SD rejected the lead create request');
  }

  const externalLeadId = extractExternalLeadId(response);
  return { externalLeadId, httpStatus: response.status, raw: response.data };
}

// Fusion lead ids look like lead_01M4FPDJ89FCJ7WFZ17JYN5CP1. This only rules
// out values that cannot be an id at all: prose, markup, paths, empty strings.
const LEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function asLeadId(value) {
  return typeof value === 'string' && LEAD_ID_PATTERN.test(value) ? value : undefined;
}

function leadIdFromLocation(location) {
  if (typeof location !== 'string' || !location.trim()) return undefined;
  let pathname;
  try {
    // Resolves a relative Location too, and drops any query or fragment.
    pathname = new URL(location, 'https://location.invalid').pathname;
  } catch (_) {
    return undefined;
  }
  const match = /(?:^|\/)v1\/leads\/([^/]+)\/?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return asLeadId(decodeURIComponent(match[1]));
  } catch (_) {
    return undefined;
  }
}

/**
 * Fusion's 201 to POST /v1/leads is JSON `{ lead_id, status, received_at }`
 * (OpenAPI `LeadAccepted`), and every Fusion lead id stored so far has that
 * form. The id is therefore taken only from `lead_id`, or from a `Location`
 * header whose path is /v1/leads/{id}. A string body is parsed as JSON in
 * case it arrives under the wrong Content-Type. Anything else (an `id`
 * field, a plain-text body such as "OK", a malformed value) yields no id,
 * so the create surfaces as DEALER_ACK_MISSING_ID instead of storing a
 * wrong id.
 */
function extractExternalLeadId(response) {
  let body = response.data;
  if (typeof body === 'string' && body.trim()) {
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = null;
    }
  }
  const fromBody = body && typeof body === 'object' ? asLeadId(body.lead_id) : undefined;
  return fromBody || leadIdFromLocation(response.headers?.location || response.headers?.Location);
}

/**
 * Fusion Lead API: PATCH /v1/leads/{lead_id} with RFC 7396 merge-patch
 * semantics. The path is derived from the dealer's create endpoint
 * ("/v1/leads" -> "/v1/leads/{id}") so there is one configured source of
 * truth, rather than trusting an update-endpoint field that new dealers
 * carry the generic placeholder default for.
 *
 * Per Fusion's guide (OpenAPI LeadUpdated):
 *   - A 200 means the update was recorded. `update_mode: manual` means it is
 *     parked for a person to accept, and `ignored_fields` lists keys the
 *     dealer has not mapped, which were not applied. Neither is a failure or
 *     retried; both are summarised in `dealerResponse` for the log.
 *   - 403 `updates_not_enabled` means this dealer has switched updates off
 *     for MG. Retrying can never succeed, and it is not a credential
 *     problem, so it is returned as skipped (the orchestrator logs it as
 *     SKIPPED) instead of an error — otherwise the generic retry path would
 *     loop on it, escalate to Unhappy 3 and mark the lead "Dealer Unavailable".
 *   - 409 `lead_not_ready` is transient and stays retryable.
 */
function updatePath(integration, externalLeadId) {
  const createPath = String(integration.create_lead_endpoint || '/v1/leads').replace(/\/+$/, '');
  return `${createPath}/${encodeURIComponent(externalLeadId)}`;
}

function isUpdatesNotEnabled(err) {
  const type = err.response?.data?.type;
  return err.response?.status === 403 && typeof type === 'string' && type.endsWith('/updates_not_enabled');
}

// What Fusion did with a PATCH (OpenAPI LeadUpdated), trimmed for the log.
// Undefined when the response carries none of these fields.
function summarizeLeadUpdated(body) {
  if (!body || typeof body !== 'object') return undefined;
  const names = (value) => (Array.isArray(value) ? value.slice(0, 25).map((name) => String(name).slice(0, 60)) : undefined);
  const summary = Object.fromEntries(Object.entries({
    update_mode: typeof body.update_mode === 'string' ? body.update_mode.slice(0, 20) : undefined,
    enquiry_linked: typeof body.enquiry_linked === 'boolean' ? body.enquiry_linked : undefined,
    updated_fields: names(body.updated_fields),
    ignored_fields: names(body.ignored_fields),
  }).filter(([, value]) => value !== undefined));
  return Object.keys(summary).length > 0 ? summary : undefined;
}

async function updateLead(catalystApp, integration, externalLeadId, payload) {
  if (!externalLeadId) {
    const err = new Error('Fusion SD updateLead needs the dealer lead id (lead_id)');
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }
  const url = await assertSafeUrl(`${integration.base_url}${updatePath(integration, externalLeadId)}`);
  const body = bodyWithinLimit(payload);

  const { response, error } = await sendWithTokenRetry(catalystApp, integration, (accessToken) => axios.request({
    method: 'PATCH',
    url: url.toString(),
    headers: {
      'Content-Type': 'application/merge-patch+json',
      Authorization: `Bearer ${accessToken}`,
    },
    data: body,
    timeout: 10000,
  }));
  if (error) {
    if (isUpdatesNotEnabled(error)) {
      logger.info(
        'fusionSdAdapter',
        `Dealer ${integration.dealer_code || integration.ROWID} has lead updates disabled for MG — update skipped (not an error)`
      );
      return {
        externalLeadId,
        httpStatus: 403,
        raw: error.response.data,
        skipped: true,
        vendor: vendorDiagnostics(error.response),
      };
    }
    logger.error(
      'fusionSdAdapter',
      `updateLead failed for integration ${integration.ROWID} (HTTP ${error.response?.status || 'network error'})`
    );
    throw wrapFusionError(error, 'Fusion SD rejected the lead update request');
  }

  const dealerResponse = summarizeLeadUpdated(response.data);
  if (dealerResponse?.ignored_fields?.length) {
    // Field-level warning: the dealer has no mapping for these keys.
    logger.info(
      'fusionSdAdapter',
      `Dealer ${integration.dealer_code || integration.ROWID} ignored ${dealerResponse.ignored_fields.length} field(s) of an update (not applied): ${dealerResponse.ignored_fields.join(', ')}`
    );
  }
  return { externalLeadId, httpStatus: response.status, raw: response.data, dealerResponse };
}

async function getLead() {
  unsupported('getLead');
}

/**
 * No dedicated health-check endpoint is documented. Obtaining a fresh
 * access token is used as the connectivity/credential check instead of
 * guessing a GET path on base_url — this at least confirms the Access
 * Key/Secret Key pair is valid and the token endpoint is reachable,
 * without requiring a real lead-list/read endpoint we don't know exists.
 */
async function testConnection(catalystApp, integration) {
  const start = Date.now();
  try {
    // Never the cached token: the check must reach Fusion with the saved keys.
    await getAccessTokenForFusionSd(catalystApp, integration, { forceRefresh: true });
    return { httpStatus: 200, responseTimeMs: Date.now() - start, ok: true };
  } catch (err) {
    // An unsafe URL is a configuration error, reported as one the way
    // genericRestAdapter.testConnection reports it.
    if (err.code === 'INVALID_CRM_CONFIGURATION') throw err;
    return {
      httpStatus: err.response?.status || 0,
      responseTimeMs: Date.now() - start,
      ok: false,
    };
  }
}

// Whether a value can be a Fusion lead id, e.g. one an admin types in to link
// an ACK_UNRESOLVED lead.
function isValidLeadId(value) {
  return asLeadId(value) !== undefined;
}

module.exports = {
  createLead,
  updateLead,
  getLead,
  testConnection,
  capabilities,
  isValidLeadId,
  _test: { classifyFusionError, nestDottedKeys, updatePath, extractExternalLeadId },
};
