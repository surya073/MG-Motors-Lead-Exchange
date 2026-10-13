'use strict';

/**
 * dealerErrorClassifier.js
 * -----------------------------------------------------------------------
 * Sorts an outbound delivery failure into one of four classes, for every
 * CRM type (the Fusion adapter, the generic/Zoho adapter and our own
 * limiter all raise their errors in the shapes handled here):
 *
 *   TRANSIENT  network error, timeout, unresolvable host, HTTP 408/429/5xx:
 *              the same request may succeed later.
 *   AUTH       HTTP 401. The Fusion adapter has already refreshed its token
 *              once, so the credentials themselves are rejected.
 *   PERMANENT  any other 4xx (400, 403, 404, 409, 422), a record the dealer
 *              CRM rejected with a 2xx (Zoho), a dealer that accepted a
 *              create without returning an id, or a configuration error:
 *              repeating the same request cannot succeed.
 *   LOCAL      raised on our side: the CRM API queue is full, our Fusion
 *              request budget is used up, a sync claim could not be
 *              stored, or the OEM write-back after a delivery failed.
 *
 * Only TRANSIENT and LOCAL failures are worth retrying automatically. A
 * request that got no response at all is TRANSIENT even when its code says
 * otherwise (e.g. a Fusion token request that never got an answer).
 */

const DEALER_ERROR_CLASS = Object.freeze({
  TRANSIENT: 'TRANSIENT',
  AUTH: 'AUTH',
  PERMANENT: 'PERMANENT',
  LOCAL: 'LOCAL',
});

// Batch 8: our own Fusion request budget refusing a request, and a sync
// claim that could not be stored, are ours too (a Fusion 429 cool-down,
// FUSION_COOLDOWN, is the dealer's and stays TRANSIENT).
const LOCAL_CODES = new Set([
  'CRM_API_QUEUE_FULL',
  'ZOHO_ACK_UPDATE_FAILED',
  'FUSION_RATE_BUDGET_EXHAUSTED',
  'CLAIM_UNAVAILABLE',
]);

const PERMANENT_CODES = new Set([
  'DEALER_ACK_MISSING_ID',
  'INVALID_CRM_CONFIGURATION',
  'FIELD_MAPPING_INVALID',
  'STATUS_MAPPING_NOT_FOUND',
  'STATUS_MAPPING_INVALID_TARGET',
  'STATUS_MAPPING_AMBIGUOUS',
  'UNSUPPORTED_OPERATION',
]);

function classifyDealerError(err) {
  const code = err?.code;
  if (LOCAL_CODES.has(code)) return DEALER_ERROR_CLASS.LOCAL;
  if (PERMANENT_CODES.has(code)) return DEALER_ERROR_CLASS.PERMANENT;

  const status = Number(err?.response?.status);
  if (!status) return DEALER_ERROR_CLASS.TRANSIENT;
  if (status === 408 || status === 429 || status >= 500) return DEALER_ERROR_CLASS.TRANSIENT;
  if (status === 401) return DEALER_ERROR_CLASS.AUTH;
  return DEALER_ERROR_CLASS.PERMANENT;
}

function isRetryableClass(errorClass) {
  return errorClass === DEALER_ERROR_CLASS.TRANSIENT || errorClass === DEALER_ERROR_CLASS.LOCAL;
}

module.exports = { classifyDealerError, isRetryableClass, DEALER_ERROR_CLASS };
