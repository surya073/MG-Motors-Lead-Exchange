'use strict';

const axios = require('axios');
const { getZohoConfig } = require('../config/env');
const { getAccessToken } = require('./zohoAuthService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');

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
    response = await axios.post(`${apiDomain}/crm/v8/actions/watch`, payload, {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    const zohoError = err.response?.data;
    logger.error('zohoWebhookService', 'Failed to register watch channel', zohoError || err);
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

module.exports = { registerWatchChannels };