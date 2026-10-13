'use strict';

const axios = require('axios');
const integrationAuthService = require('../integrationAuthService');
const logger = require('../../../utils/logger');
const { assertSafeUrl } = require('./genericRestAdapter');

/**
 * fusionSdOAuthHelper.js
 * -----------------------------------------------------------------------
 * OAuth2 access-token handling for a dealer's Fusion SD integration.
 * Mirrors zohoCrmOAuthHelper.js's shape (in-memory cache keyed by
 * integration ROWID, refreshed up to 5 minutes before expiry), but adds
 * single-flight de-duplication that helper does not have: if N concurrent
 * requests for the SAME dealer all see an expired/missing token, only the
 * FIRST triggers a real refresh call — the rest await that same in-flight
 * promise instead of each firing their own request. This was called out
 * explicitly for this new integration; zohoCrmOAuthHelper.js is left
 * exactly as-is (not touched here — changing a working, already-deployed
 * adapter is out of scope for this change).
 *
 * CONFIRMED against Fusion's real QA endpoint (2026-10-02), not guessed:
 *   - The access key / secret key are sent as HTTP Basic Auth
 *     (access key = username, secret key = password) — confirmed by the
 *     server's own `WWW-Authenticate: Basic realm="ams-pro:lead-api"`
 *     challenge header on a request that sent them in a JSON body instead
 *     (which failed with the standard OAuth2 `invalid_client` error).
 *   - Body is `application/x-www-form-urlencoded`, just `grant_type=
 *     client_credentials` — no key material in the body at all.
 *   - Response is `{ access_token, token_type: "Bearer", expires_in,
 *     scope }`. In QA, expires_in was 600 (10 minutes) and scope was
 *     "leads:write leads:update": leads:write for createLead, leads:update
 *     for updateLead (PATCH /v1/leads/{lead_id}, see fusionSdAdapter.js).
 */

const tokenCache = new Map(); // integrationId -> { accessToken, refreshAt }
const inFlightRefreshes = new Map(); // integrationId -> Promise<string> (single-flight)
// Fusion documents 600 s tokens; used when a response omits expires_in.
const DEFAULT_TOKEN_LIFETIME_SEC = 600;
// Refresh 5 min before expiry, but never more than half the lifetime, so a
// short-lived token is still reused.
const MAX_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const TOKEN_ENDPOINT_PATH = '/oauth2/token';

async function requestNewToken(catalystApp, integration) {
  // Checked before the keys are even read: they must never be sent to a
  // non-HTTPS or internal address (the same SSRF guard createLead uses).
  const tokenUrl = await assertSafeUrl(`${integration.base_url}${TOKEN_ENDPOINT_PATH}`);

  const [accessKey, secretKey] = await Promise.all([
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'FUSION_ACCESS_KEY'),
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'FUSION_SECRET_KEY'),
  ]);

  if (!accessKey || !secretKey) {
    const err = new Error('Fusion SD credentials (access key / secret key) are not fully configured');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  let response;
  try {
    response = await axios.post(
      tokenUrl.toString(),
      'grant_type=client_credentials',
      {
        auth: { username: accessKey, password: secretKey },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );
  } catch (err) {
    // Never log the request body (contains the secret key) or the raw
    // error's config — only the status, matching this codebase's existing
    // "never log credentials" convention.
    logger.error(
      'fusionSdOAuthHelper',
      `Token request failed for integration ${integration.ROWID} (HTTP ${err.response?.status || 'network error'})`
    );
    const wrapped = new Error('Failed to obtain Fusion SD access token');
    wrapped.code = 'AUTHENTICATION_FAILED';
    // Only the HTTP status is kept, so Test Connection can show it. A network
    // error has no response and therefore no status.
    if (err.response) wrapped.response = { status: err.response.status };
    throw wrapped;
  }

  const { access_token, expires_in } = response.data || {};
  if (!access_token) {
    const err = new Error('Fusion SD token response did not include an access_token');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  const lifetimeSec = Number(expires_in);
  const lifetimeMs = (Number.isFinite(lifetimeSec) && lifetimeSec > 0 ? lifetimeSec : DEFAULT_TOKEN_LIFETIME_SEC) * 1000;
  return {
    accessToken: access_token,
    refreshAt: Date.now() + lifetimeMs - Math.min(MAX_REFRESH_MARGIN_MS, lifetimeMs / 2),
  };
}

/**
 * Returns the cached token while it is fresh. `forceRefresh` (Test
 * Connection) always asks Fusion for a new one.
 */
async function getAccessTokenForFusionSd(catalystApp, integration, { forceRefresh = false } = {}) {
  const integrationId = integration.ROWID;
  const cached = tokenCache.get(integrationId);
  if (!forceRefresh && cached && cached.refreshAt > Date.now()) {
    return cached.accessToken;
  }

  // Single-flight: if a refresh for this exact integration is already in
  // progress, reuse it instead of starting a second concurrent request.
  const existingRefresh = inFlightRefreshes.get(integrationId);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = requestNewToken(catalystApp, integration)
    .then((token) => {
      // Not cached if invalidateToken ran meanwhile: this request may have
      // used the keys that were just replaced.
      if (inFlightRefreshes.get(integrationId) === refreshPromise) tokenCache.set(integrationId, token);
      return token.accessToken;
    })
    .finally(() => {
      if (inFlightRefreshes.get(integrationId) === refreshPromise) inFlightRefreshes.delete(integrationId);
    });
  inFlightRefreshes.set(integrationId, refreshPromise);

  return refreshPromise;
}

/**
 * Drops an integration's cached token so the next caller fetches a new one.
 * After its keys or URL are saved, everything goes, including a refresh in
 * flight that may still use the old keys. After a 401, pass the token that
 * failed: only that one is dropped, so concurrent callers that got the same
 * 401 share one refresh. The cache is per process; other instances recover
 * through their own 401 handling.
 */
function invalidateToken(integrationId, failedToken) {
  if (failedToken !== undefined) {
    if (tokenCache.get(integrationId)?.accessToken === failedToken) tokenCache.delete(integrationId);
    return;
  }
  tokenCache.delete(integrationId);
  inFlightRefreshes.delete(integrationId);
}

/** Test-only: clears module-level caches between test runs. */
function _resetForTests() {
  tokenCache.clear();
  inFlightRefreshes.clear();
}

module.exports = { getAccessTokenForFusionSd, invalidateToken, _resetForTests };
