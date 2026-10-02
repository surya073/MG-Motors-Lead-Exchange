'use strict';

const axios = require('axios');
const integrationAuthService = require('../integrationAuthService');
const logger = require('../../../utils/logger');

/**
 * fusionSdOAuthHelper.js
 * -----------------------------------------------------------------------
 * OAuth2 access-token handling for a dealer's Fusion SD integration.
 * Mirrors zohoCrmOAuthHelper.js's shape (in-memory cache keyed by
 * integration ROWID, 5-minute refresh safety margin), but adds
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
 *     "leads:write leads:update" — the "leads:update" scope suggests an
 *     update endpoint exists on Fusion's side, but we have not been given
 *     its URL/payload shape, so updateLead stays unsupported in the
 *     adapter (see fusionSdAdapter.js) until that's confirmed too.
 */

const tokenCache = new Map(); // integrationId -> { accessToken, expiresAt }
const inFlightRefreshes = new Map(); // integrationId -> Promise<string> (single-flight)
const SAFETY_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry
const TOKEN_ENDPOINT_PATH = '/oauth2/token';

async function requestNewToken(catalystApp, integration) {
  const [accessKey, secretKey] = await Promise.all([
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'FUSION_ACCESS_KEY'),
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'FUSION_SECRET_KEY'),
  ]);

  if (!accessKey || !secretKey) {
    const err = new Error('Fusion SD credentials (access key / secret key) are not fully configured');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  const tokenUrl = `${integration.base_url}${TOKEN_ENDPOINT_PATH}`;

  let response;
  try {
    response = await axios.post(
      tokenUrl,
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
    throw wrapped;
  }

  const { access_token, expires_in } = response.data || {};
  if (!access_token) {
    const err = new Error('Fusion SD token response did not include an access_token');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  tokenCache.set(integration.ROWID, {
    accessToken: access_token,
    expiresAt: Date.now() + (Number(expires_in) || 3600) * 1000,
  });

  return access_token;
}

async function getAccessTokenForFusionSd(catalystApp, integration) {
  const cached = tokenCache.get(integration.ROWID);
  if (cached && cached.expiresAt > Date.now() + SAFETY_MARGIN_MS) {
    return cached.accessToken;
  }

  // Single-flight: if a refresh for this exact integration is already in
  // progress, reuse it instead of starting a second concurrent request.
  const existingRefresh = inFlightRefreshes.get(integration.ROWID);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = requestNewToken(catalystApp, integration).finally(() => {
    inFlightRefreshes.delete(integration.ROWID);
  });
  inFlightRefreshes.set(integration.ROWID, refreshPromise);

  return refreshPromise;
}

/** Test-only: clears module-level caches between test runs. */
function _resetForTests() {
  tokenCache.clear();
  inFlightRefreshes.clear();
}

module.exports = { getAccessTokenForFusionSd, _resetForTests };
