'use strict';

const axios = require('axios');
const { getZohoConfig } = require('../config/env');
const { getAccessToken } = require('./zohoAuthService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');
const integrationAuthService = require('./integrations/integrationAuthService');
const { deriveZohoWatchToken } = require('./integrations/webhookVerificationService');
const { guardSweep } = require('./integrations/sweepOverlapGuard');

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

async function registerWatchChannelsInternal(catalystApp) {
  const { apiDomain, webhookToken } = getZohoConfig();
  const accessToken = await getAccessToken();

  // FIX: deregister the previous OEM channel before creating a new one —
  // same reasoning, and now the same helper, as registerDealerWatchChannel's
  // existing fix below: Zoho's watch API always ADDS a channel on POST
  // rather than replacing an existing one, so without this every OEM
  // renewal (manual or cron) piled up another duplicate channel, and
  // Zoho would eventually send multiple notifications per Dealer_Master/
  // Leads change. `null` scopes this to the shared OEM channel, never a
  // dealer's.
  await deregisterExistingChannel(catalystApp, null, accessToken, apiDomain);

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
        events: ['Dealers.all', 'Leads.all'],
        notify_url: buildNotifyUrl(),
        token: deriveZohoWatchToken(webhookToken),
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
    module_name: 'Dealers,Leads',
    registered_at: toCatalystDateTime(new Date()),
    expires_at: toCatalystDateTime(expiryDate),
  });

  logger.info('zohoWebhookService', `Registered watch channel ${channelId}, expires ${channelExpiryStr}`);
  return { channelId, expiresAt: channelExpiryStr };
}

// Guarded against two overlapping OEM renewal runs (e.g. a manual trigger
// racing a scheduled one) — same sweepOverlapGuard.js mechanism already
// used by outboundRetryScheduler.js/inboundReplayScheduler.js/
// dealerReconciliationService.js/slaMonitorService.js. A single static
// key is correct here: there is exactly one OEM channel, so this function
// is never legitimately expected to run more than once at a time.
// Exported name/signature unchanged for cronRoutes.js.
const registerWatchChannels = guardSweep('oemWebhookRenewal', registerWatchChannelsInternal);

const { getAccessTokenForDealerZoho } = require('./integrations/adapters/zohoCrmOAuthHelper');

function buildDealerNotifyUrl(dealerCode) {
  const baseUrl = String(
    process.env.PUBLIC_FUNCTION_BASE_URL ||
    'https://mg-motors-au-60069659585.development.catalystserverless.in/server/mg_motors_au_function'
  ).replace(/\/$/, '');
  return `${baseUrl}/webhooks/dealers/${encodeURIComponent(dealerCode)}`;
}

/**
 * Deregisters the most recently registered watch channel for the given
 * scope (per our own webhook_channels record of it) before a new one is
 * created. Zoho's watch API always creates an ADDITIONAL channel on POST
 * — it does not replace an existing one for the same module/notify_url —
 * so without this, every renewal (manual or cron-driven) leaves the
 * previous channel active, and Zoho ends up sending duplicate
 * notifications for every future update. Safe to no-op if there's no
 * prior record, or if the old channel already expired naturally on
 * Zoho's side (DELETE on an already-gone channel_id just fails
 * harmlessly and is logged, not thrown).
 *
 * `dealerCode`: a dealer's code to scope to that dealer's own channel
 * (identical behavior to before this was generalized), or null/undefined
 * for the single shared OEM channel. OEM rows are matched via
 * module_name = 'Dealers,Leads' — the fixed value only
 * registerWatchChannels ever writes — rather than an empty/absent
 * dealer_code, since every dealer row's module_name is always the
 * different fixed value 'Leads' (written only by
 * registerDealerWatchChannel). This can never accidentally match a
 * dealer channel, keeping the OEM and dealer scopes correctly separated
 * regardless of how an unset dealer_code column happens to be stored.
 */
async function deregisterExistingChannel(catalystApp, dealerCode, accessToken, apiDomain) {
  const whereClause = dealerCode
    ? `dealer_code = '${dealerCode}'`
    : `module_name = 'Dealers,Leads'`;
  const existing = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM webhook_channels WHERE ${whereClause} ORDER BY CREATEDTIME DESC LIMIT 1`
  );
  if (existing.length === 0) return;

  const oldChannelId = existing[0].webhook_channels.channel_id;
  const scopeLabel = dealerCode || 'OEM';
  try {
    await axios.delete(`${apiDomain}/crm/v8/actions/watch`, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
      },
      params: { channel_ids: String(oldChannelId) },
      timeout: ZOHO_REQUEST_TIMEOUT_MS,
    });
    logger.info('zohoWebhookService', `Deregistered old channel ${oldChannelId} for ${scopeLabel}`);
  } catch (err) {
    logger.error(
      'zohoWebhookService',
      `Failed to deregister old channel ${oldChannelId} for ${scopeLabel} (may have already expired)`,
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
async function registerDealerWatchChannelInternal(catalystApp, integration) {
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

  // Use the same explicitly configured API origin as outbound lead calls.
  // Deriving it from the OAuth accounts hostname is unsafe across Zoho data
  // centres and can silently register the watch in the wrong regional API.
  let apiDomain;
  try {
    apiDomain = new URL(integration.base_url).origin;
  } catch {
    const err = new Error('Dealer Zoho API base URL is invalid');
    err.code = 'INVALID_CRM_CONFIGURATION';
    throw err;
  }

  // FIX: deregister the previous channel for this dealer before creating
  // a new one — Zoho's watch API always ADDS a channel on POST rather
  // than replacing an existing one, so without this every renewal
  // (manual or cron) piles up another duplicate channel, and Zoho starts
  // sending multiple notifications per lead update.
  await deregisterExistingChannel(catalystApp, integration.dealer_code, accessToken, apiDomain);

  const channelId = Date.now();
  const expiryDate = new Date(Date.now() + 23 * 60 * 60 * 1000);
  const channelExpiryStr = toZohoDateTime(expiryDate);

  const payload = {
    watch: [
      {
        channel_id: channelId,
        // Only edits can update an already-linked dealer lead. Listening to
        // create/delete generated false Unhappy 7/4 events because those
        // records cannot be resolved through lead_integrations.
        events: ['Leads.edit'],
        notify_url: buildDealerNotifyUrl(integration.dealer_code),
        channel_expiry: channelExpiryStr,
        token: deriveZohoWatchToken(webhookSecret),
        return_affected_field_values: true,
        notify_on_related_action: false,
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

/**
 * Guarded per-dealer against two overlapping renewal runs for the SAME
 * dealer (e.g. two /cron/renew-dealer-webhooks invocations overlapping,
 * or a manual retry racing the cron). Deliberately NOT one shared key
 * for every dealer: routes/cronRoutes.js now renews up to
 * DEALER_WEBHOOK_RENEWAL_CONCURRENCY dealers concurrently in the same
 * sweep (unchanged by this fix) — a single shared guard key would treat
 * every dealer after the first concurrent call as "already running" and
 * skip it, silently collapsing that concurrency down to 1. guardSweep()
 * is called fresh per call with a dealer-specific key
 * (`dealerWebhookRenewal:<dealer_code>`) rather than once at module load
 * like the single-key schedulers — this is still the exact same
 * sweepOverlapGuard.js mechanism and its one shared tracking map, just
 * keyed dynamically; different dealers' keys never collide, so they stay
 * fully concurrent, while the SAME dealer's key is correctly exclusive
 * across overlapping invocations. Exported name/signature unchanged for
 * cronRoutes.js.
 */
async function registerDealerWatchChannel(catalystApp, integration) {
  return guardSweep(`dealerWebhookRenewal:${integration.dealer_code}`, registerDealerWatchChannelInternal)(catalystApp, integration);
}

module.exports = { registerWatchChannels, registerDealerWatchChannel };
