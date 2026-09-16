'use strict';

const axios = require('axios');
const integrationAuthService = require('../integrationAuthService');
const logger = require('../../../utils/logger');

/**
 * zohoCrmOAuthHelper.js
 * -----------------------------------------------------------------------
 * Handles OAuth2 access-token refresh for a DEALER'S OWN Zoho CRM org —
 * completely separate credentials/org from our own zohoAuthService.js
 * (which talks to MG Motor's Zoho org). A dealer using Zoho CRM as their
 * "external CRM" needs their own Client ID/Secret/Refresh Token, stored
 * as three separate integration_credentials rows.
 *
 * In-memory cache keyed by integration_id — access tokens are valid
 * ~1hr per Zoho's docs; refreshing every request would work but wastes
 * a call, so we cache with a safety margin and refresh proactively.
 */

const tokenCache = new Map(); // integrationId -> { accessToken, expiresAt }
const SAFETY_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before actual expiry

async function getAccessTokenForDealerZoho(catalystApp, integration) {
  const cached = tokenCache.get(integration.ROWID);
  if (cached && cached.expiresAt > Date.now() + SAFETY_MARGIN_MS) {
    return cached.accessToken;
  }

  const [clientId, clientSecret, refreshToken] = await Promise.all([
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'OAUTH2_CLIENT_ID'),
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'OAUTH2_CLIENT_SECRET'),
    integrationAuthService.getDecryptedCredential(catalystApp, integration.ROWID, 'OAUTH2_REFRESH_TOKEN'),
  ]);

  if (!clientId || !clientSecret || !refreshToken) {
    const err = new Error('Dealer Zoho CRM OAuth credentials not fully configured');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  // accounts_domain is dealer-specific too (.com / .in / .eu etc) — stored
  // as part of base_url's origin isn't right since base_url is the API
  // domain (www.zohoapis.in), not accounts domain (accounts.zoho.in).
  // We derive it from crm_name field's stored accounts domain, set at
  // config time — see route changes below.
  const accountsDomain = integration.oauth_accounts_domain || 'https://accounts.zoho.com';

  let response;
  try {
    response = await axios.post(`${accountsDomain}/oauth/v2/token`, null, {
      params: {
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
      },
      timeout: 10000,
    });
  } catch (err) {
    logger.error('zohoCrmOAuthHelper', `Token refresh failed for integration ${integration.ROWID}`, err);
    const wrapped = new Error('Failed to refresh dealer Zoho CRM access token');
    wrapped.code = 'AUTHENTICATION_FAILED';
    throw wrapped;
  }

  const { access_token, expires_in } = response.data;
  if (!access_token) {
    const err = new Error('Zoho token refresh did not return an access token');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  tokenCache.set(integration.ROWID, {
    accessToken: access_token,
    expiresAt: Date.now() + (expires_in || 3600) * 1000,
  });

  return access_token;
}

module.exports = { getAccessTokenForDealerZoho };