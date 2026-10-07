'use strict';

const axios = require('axios');
const logger = require('../../../utils/logger');
const { assertSafeUrl } = require('./genericRestAdapter');
const { getAccessTokenForFusionSd } = require('./fusionSdOAuthHelper');

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
 * STATUS (2026-10-02) — token auth confirmed; lead payload still unknown
 * ================================================================
 * Token exchange (fusionSdOAuthHelper.js) is CONFIRMED against Fusion's
 * real QA endpoint — see that file's header comment.
 *
 * The create-lead request/response body is still NOT documented by Fusion
 * and is still a best-effort guess, not a confirmed fact:
 *   - Request body: the MG-side mapped lead fields sent as a flat JSON
 *     object (no wrapper envelope like Zoho's `{ data: [...] }`). Live
 *     testing against Fusion's QA create-lead endpoint confirms it
 *     validates contact fields server-side (RFC7807 `problem+json`,
 *     `missing_contact` error: "A lead needs a first or last name, and a
 *     phone number or an email address.") but every flat/nested,
 *     snake_case/camelCase field-name combination tried was rejected as
 *     still missing a usable contact — the actual expected field names
 *     remain unknown. This is NOT a code defect: this adapter deliberately
 *     does not hardcode Fusion field names — it forwards whatever payload
 *     crmIntegrationService builds from that dealer's configured Field
 *     Mappings (Dealer CRM Config UI), so once Fusion confirms the real
 *     field names, fixing this is a field-mapping config change, not an
 *     adapter code change.
 *   - Success response: the created record's ID is assumed to be at
 *     response.data.id, response.data.lead_id, or response.data.data.id —
 *     checked in that order, falling back to undefined (which surfaces as
 *     a DEALER_ACK_MISSING_ID error upstream in crmIntegrationService,
 *     the same existing handling a misbehaving generic REST CRM gets).
 *     Not yet verified against a successful (2xx) create-lead response
 *     since no payload has succeeded yet.
 *   - Error response: confirmed RFC7807 `problem+json` shape
 *     (`{type, title, status, detail, correlation_id}`) on validation
 *     failures, but errors are still classified by HTTP status only
 *     (401/403 -> AUTHENTICATION_FAILED, 400/422 -> FIELD_MAPPING_INVALID,
 *     404 -> NOT_FOUND, 429/5xx -> EXTERNAL_CRM_ERROR, treated as
 *     retryable the same way any other transient external error is). The
 *     `detail`/`correlation_id` fields are not yet surfaced in thrown
 *     errors or logs — worth adding once the payload shape is confirmed,
 *     to give admins/Fusion support a concrete correlation_id to trace.
 */

const capabilities = Object.freeze({
  createLead: true,
  updateLead: false, // not confirmed supported by Fusion's documented API surface
  getLead: false,
  statusUpdate: false,
  webhook: false,
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
  return wrapped;
}

/**
 * Fusion's Lead API expects a nested body ({ contact: { firstName }, requirement:
 * { model } }), but field mappings produce flat keys. A mapping whose
 * target_field is a dotted path ("contact.firstName") is expanded here, so
 * the mapping table stays the single place field names are configured.
 * Keys without a dot pass through untouched.
 */
function nestDottedKeys(flat) {
  const out = {};
  Object.entries(flat || {}).forEach(([key, value]) => {
    const parts = key.split('.').filter(Boolean);
    if (parts.length <= 1) {
      out[key] = value;
      return;
    }
    let node = out;
    parts.slice(0, -1).forEach((part) => {
      if (typeof node[part] !== 'object' || node[part] === null) node[part] = {};
      node = node[part];
    });
    node[parts[parts.length - 1]] = value;
  });
  return out;
}

async function createLead(catalystApp, integration, payload, { idempotencyKey } = {}) {
  const url = await assertSafeUrl(`${integration.base_url}${integration.create_lead_endpoint}`);
  const accessToken = await getAccessTokenForFusionSd(catalystApp, integration);

  let response;
  try {
    response = await axios.request({
      method: integration.http_method || 'POST',
      url: url.toString(),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        // Fusion: "always send Idempotency-Key" — a retry after a timeout then
        // returns the original lead instead of creating a duplicate.
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
      },
      data: nestDottedKeys(payload),
      timeout: 10000,
    });
  } catch (err) {
    logger.error(
      'fusionSdAdapter',
      `createLead failed for integration ${integration.ROWID} (HTTP ${err.response?.status || 'network error'})`
    );
    throw wrapFusionError(err, 'Fusion SD rejected the lead create request');
  }

  const externalLeadId = extractExternalLeadId(response);
  return { externalLeadId, httpStatus: response.status, raw: response.data };
}

/**
 * Live production evidence (AU004/QA, 2026-10-05): Fusion's create-lead
 * response body comes back empty/non-JSON — none of the guessed body
 * field names (id/lead_id/data.id) were ever going to match, because
 * there's no body to match against. Rather than guess more body field
 * names, this checks the one place a created resource's ID is
 * UNIVERSALLY expected to live on a REST API when the body doesn't carry
 * it: the standard HTTP `Location` response header for a 201 Created
 * (RFC 7231 §7.1.2) — e.g. `Location: /v1/leads/abc-123` -> `abc-123`.
 * This is a documented HTTP convention, not a Fusion-specific guess.
 * Also defensively parses a string body as JSON, in case Fusion sends a
 * correct JSON payload under the wrong Content-Type (axios then leaves
 * response.data as an unparsed string instead of an object).
 */
function extractExternalLeadId(response) {
  let body = response.data;
  let bareStringCandidate = null;
  if (typeof body === 'string' && body.trim()) {
    const trimmed = body.trim();
    try {
      body = JSON.parse(trimmed);
    } catch (_) {
      // Not JSON. A short, plain-text response with no braces/brackets/
      // markup is a known (if less common) lightweight-API convention:
      // the bare created-record ID as the ENTIRE response body. Guarded
      // narrowly (short, no markup, no multi-space prose) so an HTML
      // error page or informational text with a 2xx status is never
      // mistaken for an ID. Held as a last-resort candidate rather than
      // returned immediately — a body.id-style match or a Location
      // header, if either is also present, is more explicit evidence and
      // takes priority.
      const looksLikeBareId = trimmed.length > 0 && trimmed.length <= 128
        && !/^[<{[]/.test(trimmed) && !/\s{2,}/.test(trimmed);
      if (looksLikeBareId) bareStringCandidate = trimmed;
      body = null;
    }
  }
  if (body && typeof body === 'object') {
    const fromBody = body.id || body.lead_id || body.data?.id || body.record?.id || body.record?.uuid;
    if (fromBody) return fromBody;
  }

  const location = response.headers?.location || response.headers?.Location;
  if (typeof location === 'string' && location.trim()) {
    const segments = location.split('/').filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    if (lastSegment) return decodeURIComponent(lastSegment);
  }

  return bareStringCandidate || undefined;
}

async function updateLead() {
  unsupported('updateLead');
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
    await getAccessTokenForFusionSd(catalystApp, integration);
    return { httpStatus: 200, responseTimeMs: Date.now() - start, ok: true };
  } catch (err) {
    return {
      httpStatus: err.response?.status || 0,
      responseTimeMs: Date.now() - start,
      ok: false,
    };
  }
}

module.exports = {
  createLead,
  updateLead,
  getLead,
  testConnection,
  capabilities,
  _test: { classifyFusionError, nestDottedKeys },
};
