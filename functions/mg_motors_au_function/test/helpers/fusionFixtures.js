'use strict';

const http = require('http');
const { AxiosError, AxiosHeaders } = require('axios');

/**
 * Synthetic Fusion SD (AMS-Pro Lead API) responses and webhook bodies for
 * tests. Shapes follow the vendor's OpenAPI file for the MG Motors sandbox (D3
 * in FUSION_SD_AUDIT.md): LeadAccepted, LeadUpdated, Problem (RFC 9457),
 * RateLimited and PushedLead. Every value is made up.
 *
 * Responses look like axios responses ({ status, statusText, headers, data }),
 * so a test can return one from a mocked axios.request. 4xx/5xx responses come
 * as real AxiosErrors carrying the response, so a mock can throw them the way
 * axios does. Every call builds new objects; a test may change what it gets.
 */

const FUSION_TEST_LEAD_ID = 'lead_01JTEST0000000000000000001';
const FUSION_TEST_DEALER_ID = 'AU999';
const PROBLEM_TYPE_BASE = 'https://docs.fusionamspro.com/lead-api/errors/';

// Every problem type D3 documents for POST and PATCH /v1/leads.
const FUSION_PROBLEM_TYPES = Object.freeze(Object.fromEntries([
  ['invalid_payload', 400, 'Invalid payload'],
  ['credential_revoked', 401, 'Credential no longer valid'],
  ['updates_not_enabled', 403, 'Updates not enabled'],
  ['provider_unavailable', 404, 'Provider not available'],
  ['lead_not_found', 404, 'Lead not found'],
  ['idempotency_conflict', 409, 'Idempotency key reused'],
  ['lead_not_ready', 409, 'Lead not ready for update'],
  ['unmapped_payload', 422, 'Payload produced no lead'],
  ['missing_contact', 422, 'Lead has no usable contact'],
  ['mapping_target_rejected', 422, 'Mapping target not permitted'],
  ['rate_limited', 429, 'Too many requests'],
  ['internal', 500, 'Request could not be completed'],
  ['dealer_unavailable', 503, 'Dealer configuration unavailable'],
].map(([slug, status, title]) => [slug, Object.freeze({ status, title })])));

function axiosResponse(status, data, headers) {
  return {
    status,
    statusText: http.STATUS_CODES[status],
    headers: new AxiosHeaders({ 'content-type': 'application/json', ...headers }),
    data,
  };
}

/** 201 from POST /v1/leads. */
function leadAcceptedResponse(overrides = {}) {
  return axiosResponse(201, {
    lead_id: FUSION_TEST_LEAD_ID,
    status: 'received',
    received_at: '2026-10-12T09:30:12.418Z',
    ...overrides,
  });
}

/**
 * 200 from PATCH /v1/leads/{lead_id} for an update applied to the enquiry.
 * Override with `{ update_mode: 'manual' }` for an update parked for a person
 * to accept, `{ ignored_fields: [...] }` for keys the dealer has not mapped
 * (Fusion sends that key only when it ignored something), or
 * `{ enquiry_linked: false }` for a lead not yet accepted into the pipeline.
 */
function leadUpdatedResponse(overrides = {}) {
  return axiosResponse(200, {
    lead_id: FUSION_TEST_LEAD_ID,
    status: 'updated',
    enquiry_id: 'enq_test_0001',
    updated_fields: ['status'],
    update_mode: 'auto',
    enquiry_linked: true,
    ...overrides,
  });
}

/** An RFC 9457 problem response for one of FUSION_PROBLEM_TYPES, as axios throws it. */
function fusionProblemError(slug, { detail, instance = 'lreq_test00000001', headers } = {}) {
  const problemType = FUSION_PROBLEM_TYPES[slug];
  if (!problemType) throw new Error(`Unknown Fusion problem type: ${slug}`);
  const { status, title } = problemType;
  const data = { type: `${PROBLEM_TYPE_BASE}${slug}`, title, status, ...(detail ? { detail } : {}), instance };
  const response = axiosResponse(status, data, { 'content-type': 'application/problem+json', ...headers });
  const code = status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST;
  return new AxiosError(`Request failed with status code ${status}`, code, undefined, undefined, response);
}

/** 403 from PATCH when the dealer has switched lead updates off for MG. */
function updatesNotEnabledError(options = {}) {
  return fusionProblemError('updates_not_enabled', {
    detail: 'This dealer has not enabled lead updates for this provider.',
    ...options,
  });
}

/** 429 once a credential is over 300 requests per 60 s. Retry-After is in seconds. */
function rateLimitedError({ retryAfter = 60, ...options } = {}) {
  return fusionProblemError('rate_limited', {
    detail: 'Retry after the period given in the Retry-After header.',
    ...options,
    headers: { 'retry-after': String(retryAfter), ...options.headers },
  });
}

/**
 * A webhook body as Fusion posts it: flat, with no envelope. This is the
 * narrowed shape of a status update; add other PushedLead keys (first_name,
 * email, model, ...) through `overrides`.
 */
function inboundFlatWebhookPayload(overrides = {}) {
  return {
    lead_id: FUSION_TEST_LEAD_ID,
    dealer_id: FUSION_TEST_DEALER_ID,
    status: 'Open',
    pushed_at: '2026-10-12T10:00:00Z',
    ...overrides,
  };
}

module.exports = {
  FUSION_TEST_LEAD_ID,
  FUSION_TEST_DEALER_ID,
  FUSION_PROBLEM_TYPES,
  leadAcceptedResponse,
  leadUpdatedResponse,
  fusionProblemError,
  updatesNotEnabledError,
  rateLimitedError,
  inboundFlatWebhookPayload,
};
