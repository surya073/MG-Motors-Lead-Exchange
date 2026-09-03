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
 */

let cachedToken = null;
let cachedTokenExpiryMs = 0;

// Refresh a little early (60s buffer) rather than exactly at expiry, to
// avoid a race where a CRM call starts just as the token turns invalid.
const EXPIRY_BUFFER_MS = 60 * 1000;

async function getAccessToken() {
  const now = Date.now();

  if (cachedToken && now < cachedTokenExpiryMs - EXPIRY_BUFFER_MS) {
    return cachedToken;
  }

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
      `Zoho OAuth response did not include an access_token. Response: ${JSON.stringify(response.data)}`
    );
  }

  cachedToken = access_token;
  cachedTokenExpiryMs = now + (Number(expires_in || 3600) * 1000);

  logger.info('zohoAuthService', 'Refreshed Zoho access token', { expiresInSec: expires_in });

  return cachedToken;
}

module.exports = { getAccessToken };