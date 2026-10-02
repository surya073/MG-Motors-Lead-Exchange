'use strict';

const axios = require('axios');
const { getZohoConfig } = require('../config/env');
const logger = require('../utils/logger');

/**
 * zohoAuthService.js
 * -----------------------------------------------------------------------
 * Exchanges the long-lived refresh token for a short-lived access token
 * on demand, using Zoho's OAuth v2 token endpoint. Caches the access
 * token in module-level memory for the lifetime of the function
 * instance, and only refreshes when it's actually expired — avoids an
 * unnecessary OAuth round-trip on every single CRM call.
 *
 * Cache is intentionally in-memory only, not in Catalyst Datastore or
 * Cache segment — Catalyst may spin up a fresh function instance at any
 * time, at which point this simply refreshes again. That's acceptable;
 * access tokens are cheap to regenerate and this avoids adding a second
 * moving part for what is a non-problem at this scale.
 *
 * Single-flight: if several concurrent calls all see a stale/missing
 * token at once (routine once there are enough dealers generating
 * concurrent MG-CRM calls), only the first triggers a real refresh;
 * the rest await that same in-flight promise instead of each firing
 * their own request against Zoho's token endpoint. Zoho's refresh-token
 * grant is not single-use/rotating, so a race here was never able to
 * invalidate a sibling call's token — this fix is about avoiding wasted
 * OAuth calls, not a correctness bug. Mirrors the per-dealer pattern in
 * zohoCrmOAuthHelper.js / fusionSdOAuthHelper.js, collapsed to a single
 * in-flight slot since there is only one OEM org/token here, not one per
 * dealer.
 */

let cachedToken = null;
let cachedTokenExpiryMs = 0;
let inFlightRefresh = null;

// Refresh a little early (60s buffer) rather than exactly at expiry, to
// avoid a race where a CRM call starts just as the token turns invalid.
const EXPIRY_BUFFER_MS = 60 * 1000;

async function getAccessToken() {
  const now = Date.now();

  if (cachedToken && now < cachedTokenExpiryMs - EXPIRY_BUFFER_MS) {
    return cachedToken;
  }

  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  inFlightRefresh = refreshAccessToken().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

async function refreshAccessToken() {
  const { clientId, clientSecret, refreshToken, accountsDomain } = getZohoConfig();

  let response;
  try {
    response = await axios.post(
      `${accountsDomain}/oauth/v2/token`,
      null,
      {
        params: {
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
        },
      }
    );
  } catch (err) {
    logger.error('zohoAuthService', 'OAuth token request failed', err);
    throw new Error(
      `Failed to obtain Zoho access token: ${err.response?.data?.error || err.message}`
    );
  }

  const { access_token, expires_in } = response.data || {};

  if (!access_token) {
    logger.error('zohoAuthService', 'OAuth response missing access_token', response.data);
    throw new Error(
      `Zoho OAuth response did not include an access_token (fields present: ${Object.keys(response.data || {}).join(', ') || 'none'})`
    );
  }

  cachedToken = access_token;
  cachedTokenExpiryMs = Date.now() + (Number(expires_in || 3600) * 1000);

  logger.info('zohoAuthService', 'Refreshed Zoho access token', { expiresInSec: expires_in });

  return cachedToken;
}

/** Test-only: clears module-level cache/in-flight state between test runs. */
function _resetForTests() {
  cachedToken = null;
  cachedTokenExpiryMs = 0;
  inFlightRefresh = null;
}

module.exports = { getAccessToken, _resetForTests };