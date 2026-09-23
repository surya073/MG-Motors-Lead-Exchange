'use strict';

const axios = require('axios');
const { getZohoConfig } = require('../config/env');
const { getAccessToken } = require('./zohoAuthService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');
const integrationAuthService = require('./integrations/integrationAuthService');

const ZOHO_REQUEST_TIMEOUT_MS = 10000;

function toZohoDateTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}+00:00`;
}

function buildNotifyUrl() {
  const baseUrl = String(
    process.env.PUBLIC_FUNCTION_BASE_URL ||
    'https://mg-motors-au-60069659585.development.catalystserverless.in/server/mg_motors_au_function'
  ).replace(/\/$/, '');
  return `${baseUrl}/webhooks/crm-notify`;
}

async function registerWatchChannels(catalystApp) {
  const { apiDomain, webhookToken } = getZohoConfig();
  const accessToken = await getAccessToken();

  const channelId = Date.now();
  const expiryDate = new Date(Date.now() + 23 * 60 * 60 * 1000);
  const channelExpiryStr = toZohoDateTime(expiryDate);

  const payload = {
    watch: [
      {
        channel_id: channelId,
        // FIX: the real CRM module API name is "Leads" — zohoCrmService.js
        // fetches from /crm/v8/Leads. "OEM_Leads" is not an actual module,
        // so Zoho never had anything to fire notifications for, which is
        // why lead changes only ever showed up via manual sync while
        // Dealer_Master (a real module name) synced live via webhook.
        events: ['Dealer_Master.all', 'Leads.all'],
        notify_url: buildNotifyUrl(),
        token: webhookToken,
        channel_expiry: channelExpiryStr,
      },
    ],
  };

  let response;
  try {
    logger.info('zohoWebhookService', `Calling watch API at ${apiDomain}/crm/v8/actions/watch (OEM)`);
    response = await axios.post(`${apiDomain}/crm/v8/actions/watch`, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: ZOHO_REQUEST_TIMEOUT_MS,
    });
    logger.info('zohoWebhookService', 'Watch API call returned (OEM)');
  } catch (err) {
    const zohoError = err.response?.data;
    logger.error('zohoWebhookService', 'Failed to register watch channel', zohoError || err.message || err);
    throw new Error(`Watch channel registration failed: ${JSON.stringify(zohoError) || err.message}`);
  }

  const result = response.data?.watch?.[0];
  if (result?.status !== 'success' && result?.code !== 'SUCCESS') {
    throw new Error(`Zoho rejected watch registration: ${JSON.stringify(result)}`);
  }

  const table = catalystApp.datastore().table('webhook_channels');
  await table.insertRow({
    channel_id: channelId,
    module_name: 'Dealer_Master,Leads',
    registered_at: toCatalystDateTime(new Date()),
    expires_at: toCatalystDateTime(expiryDate),
  });

  logger.info('zohoWebhookService', `Registered watch channel ${channelId}, expires ${channelExpiryStr}`);
  return { channelId, expiresAt: channelExpiryStr };
}

const { getAccessTokenForDealerZoho } = require('./integrations/adapters/zohoCrmOAuthHelper');

function buildDealerNotifyUrl(dealerCode) {
  const baseUrl = String(
    process.env.PUBLIC_FUNCTION_BASE_URL ||
    'https://mg-motors-au-60069659585.development.catalystserverless.in/server/mg_motors_au_function'
  ).replace(/\/$/, '');
  return `${baseUrl}/webhooks/dealers/${encodeURIComponent(dealerCode)}`;
}

/**
 * Deregisters this dealer's most recently registered watch channel (per
 * our own webhook_channels record of it) before a new one is created.
 * Zoho's watch API always creates an ADDITIONAL channel on POST — it
 * does not replace an existing one for the same module/notify_url — so
 * without this, every renewal (manual or cron-driven) leaves the
 * previous channel active, and Zoho ends up sending duplicate
 * notifications for every future update. Safe to no-op if there's no
 * prior record, or if the old channel already expired naturally on
 * Zoho's side (DELETE on an already-gone channel_id just fails
 * harmlessly and is logged, not thrown).
 */
async function deregisterExistingChannel(catalystApp, integration, accessToken, apiDomain) {
  const existing = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM webhook_channels WHERE dealer_code = '${integration.dealer_code}' ORDER BY CREATEDTIME DESC LIMIT 1`
  );
  if (existing.length === 0) return;

  const oldChannelId = existing[0].webhook_channels.channel_id;
  try {
    await axios.delete(`${apiDomain}/crm/v8/actions/watch`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      params: { channel_ids: String(oldChannelId) },
      timeout: ZOHO_REQUEST_TIMEOUT_MS,
    });
    logger.info('zohoWebhookService', `Deregistered old channel ${oldChannelId} for ${integration.dealer_code}`);
  } catch (err) {
    logger.error(
      'zohoWebhookService',
      `Failed to deregister old channel ${oldChannelId} for ${integration.dealer_code} (may have already expired)`,
      err.response?.data || err.message
    );
  }
}

/**
 * Registers a Zoho CRM watch channel on a DEALER's own Zoho org (not our
 * OEM one), so their Leads module changes notify OUR per-dealer webhook
 * route instead of the shared /webhooks/crm-notify used for OEM leads.
 * Mirrors registerWatchChannels() above but scoped to one dealer's
 * credentials, one dealer's notify URL, and its own webhook_channels row.
 */
async function registerDealerWatchChannel(catalystApp, integration) {
  logger.info('zohoWebhookService', `Starting dealer watch registration for ${integration.dealer_code}`);

  const accessToken = await getAccessTokenForDealerZoho(catalystApp, integration);
  logger.info('zohoWebhookService', `Got access token for ${integration.dealer_code}`);

  const webhookSecret = await integrationAuthService.getDecryptedCredential(
    catalystApp,
    integration.ROWID,
    'WEBHOOK_SECRET'
  );
  if (!webhookSecret) {
    const err = new Error('Generate a webhook secret before registering the dealer watch channel');
    err.code = 'WEBHOOK_AUTH_NOT_CONFIGURED';
    throw err;
  }

  // Dealer's Zoho org's own API domain — same field the outbound adapter
  // relies on for their token endpoint; assumed to also be their correct
  // API domain for the watch registration call itself.
  const apiDomain = integration.oauth_accounts_domain.replace('accounts.zoho', 'www.zohoapis');
  // NOTE: confirm this domain-derivation assumption is right for your
  // dealers' regions (e.g. accounts.zoho.in -> www.zohoapis.in) — if
  // their API domain doesn't follow this pattern, this needs a stored
  // field instead of a derived one.

  // FIX: deregister the previous channel for this dealer before creating
  // a new one — Zoho's watch API always ADDS a channel on POST rather
  // than replacing an existing one, so without this every renewal
  // (manual or cron) piles up another duplicate channel, and Zoho starts
  // sending multiple notifications per lead update.
  await deregisterExistingChannel(catalystApp, integration, accessToken, apiDomain);

  const channelId = Date.now();
  const expiryDate = new Date(Date.now() + 23 * 60 * 60 * 1000);
  const channelExpiryStr = toZohoDateTime(expiryDate);

  const payload = {
    watch: [
      {
        channel_id: channelId,
        events: ['Leads.all'], // confirm this matches the dealer's own Zoho module name for leads
        notify_url: buildDealerNotifyUrl(integration.dealer_code),
        channel_expiry: channelExpiryStr,
        token: webhookSecret,
      },
    ],
  };

  let response;
  try {
    logger.info('zohoWebhookService', `Calling watch API at ${apiDomain}/crm/v8/actions/watch for ${integration.dealer_code}`);
    response = await axios.post(`${apiDomain}/crm/v8/actions/watch`, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: ZOHO_REQUEST_TIMEOUT_MS,
    });
    logger.info('zohoWebhookService', `Watch API call returned for ${integration.dealer_code}`);
  } catch (err) {
    const zohoError = err.response?.data;
    logger.error(
      'zohoWebhookService',
      `Failed to register dealer watch channel for ${integration.dealer_code}`,
      zohoError || err.message || err
    );
    throw new Error(`Dealer watch channel registration failed: ${JSON.stringify(zohoError) || err.message}`);
  }

  const result = response.data?.watch?.[0];
  if (result?.status !== 'success' && result?.code !== 'SUCCESS') {
    throw new Error(`Zoho rejected dealer watch registration for ${integration.dealer_code}: ${JSON.stringify(result)}`);
  }

  const table = catalystApp.datastore().table('webhook_channels');
  await table.insertRow({
    channel_id: channelId,
    dealer_code: integration.dealer_code,
    integration_id: integration.ROWID,
    module_name: 'Leads',
    registered_at: toCatalystDateTime(new Date()),
    expires_at: toCatalystDateTime(expiryDate),
  });

  logger.info('zohoWebhookService', `Registered dealer watch channel ${channelId} for ${integration.dealer_code}, expires ${channelExpiryStr}`);
  return { dealerCode: integration.dealer_code, channelId, expiresAt: channelExpiryStr };
}

module.exports = { registerWatchChannels, registerDealerWatchChannel };
