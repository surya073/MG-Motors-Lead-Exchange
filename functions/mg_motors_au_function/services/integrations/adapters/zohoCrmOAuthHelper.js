'use strict';

const axios = require('axios');
const crypto = require('crypto');
const integrationAuthService = require('../integrationAuthService');
const logger = require('../../../utils/logger');
const usageContext = require('../../usageContext');
const { assertSafeUrl, safeRequestOptions } = require('./safeHttp');
const { assertZohoEndpoint } = require('./zohoEndpointPolicy');

// Cached tokens and single-flight refreshes are tied to the persisted credential
// snapshot and authoritative API/accounts configuration, not just the row ID.
// Two bounded datastore reads on a warm hit make rotations visible across
// function instances. A completed refresh rechecks that generation before use.
const tokenCache = new Map();
const inFlightRefreshes = new Map();
const invalidationEpochs = new Map();
const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const CREDENTIAL_TYPES = ['OAUTH2_CLIENT_ID', 'OAUTH2_CLIENT_SECRET', 'OAUTH2_REFRESH_TOKEN'];

function changedConfiguration() {
  return Object.assign(new Error('Dealer Zoho configuration changed; reload the integration before retrying'), {
    code: 'INVALID_CRM_CONFIGURATION',
  });
}

function configIdentity(integration) {
  const api = assertZohoEndpoint(integration.base_url, 'api');
  const accounts = assertZohoEndpoint(integration.oauth_accounts_domain || 'https://accounts.zoho.in', 'accounts');
  return JSON.stringify([integration.crm_type || 'ZOHO_CRM', api.toString(), accounts.toString()]);
}

async function readGeneration(catalystApp, integration) {
  // Reject unsafe caller config before accessing any stored credential.
  const expected = configIdentity(integration);
  const current = await catalystApp.datastore().table('dealer_integrations').getRow(integration.ROWID);
  if (!current || configIdentity(current) !== expected) throw changedConfiguration();
  const snapshot = await integrationAuthService.getCredentialSnapshot(catalystApp, integration.ROWID, CREDENTIAL_TYPES);
  if (CREDENTIAL_TYPES.some((type) => !snapshot.credentials[type])) {
    throw Object.assign(new Error('Dealer Zoho CRM OAuth credentials not fully configured'), { code: 'AUTHENTICATION_FAILED' });
  }
  return {
    ...snapshot,
    generation: crypto.createHash('sha256').update(expected).update(snapshot.generation).digest('hex'),
  };
}

async function getAccessTokenForDealerZoho(catalystApp, integration) {
  const id = String(integration.ROWID);
  const epoch = invalidationEpochs.get(id) || 0;
  configIdentity(integration);
  const tokenUrl = await assertSafeUrl(new URL('/oauth/v2/token',
    integration.oauth_accounts_domain || 'https://accounts.zoho.in').toString());
  const snapshot = await readGeneration(catalystApp, integration);
  if ((invalidationEpochs.get(id) || 0) !== epoch) throw changedConfiguration();
  const cached = tokenCache.get(id);
  if (cached?.generation === snapshot.generation && cached.expiresAt > Date.now() + SAFETY_MARGIN_MS) {
    usageContext.countToken('hit');
    return cached.accessToken;
  }
  const existing = inFlightRefreshes.get(id);
  if (existing?.generation === snapshot.generation) {
    usageContext.countToken('hit');
    return existing.promise;
  }

  const flight = { generation: snapshot.generation };
  flight.promise = refreshDealerZohoToken(integration, snapshot.credentials, tokenUrl).then(async (token) => {
    const current = await readGeneration(catalystApp, integration);
    if (current.generation !== snapshot.generation || (invalidationEpochs.get(id) || 0) !== epoch) {
      throw changedConfiguration();
    }
    // An older refresh cannot overwrite (or clear) a newer generation.
    if (inFlightRefreshes.get(id) === flight) tokenCache.set(id, { ...token, generation: snapshot.generation });
    return token.accessToken;
  }).finally(() => {
    if (inFlightRefreshes.get(id) === flight) inFlightRefreshes.delete(id);
  });
  inFlightRefreshes.set(id, flight);
  return flight.promise;
}

async function refreshDealerZohoToken(integration, credentials, tokenUrl) {
  const clientId = credentials.OAUTH2_CLIENT_ID;
  const clientSecret = credentials.OAUTH2_CLIENT_SECRET;
  const refreshToken = credentials.OAUTH2_REFRESH_TOKEN;

  let response;
  try {
    usageContext.countToken('refresh');
    response = await axios.post(tokenUrl.toString(), new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }).toString(), {
      ...safeRequestOptions(tokenUrl),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
  } catch (err) {
    logger.error('zohoCrmOAuthHelper', `Token refresh failed for integration ${integration.ROWID} (HTTP ${err.response?.status || 'network error'})`);
    const status = err.response?.status;
    const transient = !status || status === 408 || status === 429 || status >= 500;
    const wrapped = new Error(transient
      ? 'Dealer Zoho CRM token endpoint is temporarily unavailable'
      : 'Failed to refresh dealer Zoho CRM access token');
    wrapped.code = transient ? 'EXTERNAL_CRM_ERROR' : 'AUTHENTICATION_FAILED';
    if (status) {
      wrapped.response = { status };
      const value = err.response.headers?.['retry-after'] ?? err.response.headers?.['Retry-After'];
      const text = String(value ?? '').trim();
      if (text) {
        const seconds = /^\d+$/.test(text) ? Number(text) : Math.ceil((Date.parse(text) - Date.now()) / 1000);
        if (Number.isFinite(seconds)) wrapped.vendor = { status, retryAfter: Math.max(0, seconds) };
      }
    }
    throw wrapped;
  }

  const { access_token, expires_in } = response.data;
  if (!access_token) {
    const err = new Error('Zoho token refresh did not return an access token');
    err.code = 'AUTHENTICATION_FAILED';
    throw err;
  }

  return {
    accessToken: access_token,
    expiresAt: Date.now() + (expires_in || 3600) * 1000,
  };
}

function invalidateToken(integrationId) {
  const id = String(integrationId);
  invalidationEpochs.set(id, (invalidationEpochs.get(id) || 0) + 1);
  tokenCache.delete(id);
  inFlightRefreshes.delete(id);
}

/** Test-only: clears module-level caches between test runs. */
function _resetForTests() {
  tokenCache.clear();
  inFlightRefreshes.clear();
  invalidationEpochs.clear();
}

module.exports = { getAccessTokenForDealerZoho, invalidateToken, _resetForTests };
