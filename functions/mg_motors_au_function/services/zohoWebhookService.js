'use strict';

const axios = require('axios');
const { getZohoConfig } = require('../config/env');
const { getAccessToken } = require('./zohoAuthService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');

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
  return 'https://mg-motors-au-60069659585.development.catalystserverless.in/server/mg_motors_au_function/webhooks/crm-notify';
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
    token: webhookToken,
    registered_at: toCatalystDateTime(new Date()),
    expires_at: toCatalystDateTime(expiryDate),
  });

  logger.info('zohoWebhookService', `Registered watch channel ${channelId}, expires ${channelExpiryStr}`);
  return { channelId, expiresAt: channelExpiryStr };
}

const { getAccessTokenForDealerZoho } = require('./integrations/adapters/zohoCrmOAuthHelper');

function buildDealerNotifyUrl(dealerCode) {
  return `https://mg-motors-au-60069659585.development.catalystserverless.in/server/mg_motors_au_function/webhooks/dealers/${dealerCode}`;
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

  // Dealer's Zoho org's own API domain — same field the outbound adapter
  // relies on for their token endpoint; assumed to also be their correct
  // API domain for the watch registration call itself.
  const apiDomain = integration.oauth_accounts_domain.replace('accounts.zoho', 'www.zohoapis');
  // NOTE: confirm this domain-derivation assumption is right for your
  // dealers' regions (e.g. accounts.zoho.in -> www.zohoapis.in) — if
  // their API domain doesn't follow this pattern, this needs a stored
  // field instead of a derived one.

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
        // NOTE: dealer-side watch omits `token` (unlike the OEM one) —
        // deliberately, since Zoho's watch API's own `token` field isn't
        // used for auth verification on our side; our route instead
        // relies on webhookVerificationService (currently bypassed via
        // SKIP_WEBHOOK_AUTH — flip that back on before this goes live).
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