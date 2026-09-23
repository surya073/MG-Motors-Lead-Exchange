'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');
const integrationAuthService = require('./integrationAuthService');

/**
 * webhookVerificationService.js
 * -----------------------------------------------------------------------
 * Authenticates inbound dealer-CRM webhooks. Supports HMAC signature
 * (preferred) and static bearer/API-key fallback, per integration config.
 * Never logs the secret or the raw signature header value on failure —
 * only a boolean result and a safe error code.
 *
 * Local-only bypass is opt-in through ALLOW_INSECURE_WEBHOOKS=true. It is
 * deliberately rejected in production so a forgotten test flag cannot
 * expose customer webhooks.
 */

const ALLOW_INSECURE_WEBHOOKS =
  process.env.ALLOW_INSECURE_WEBHOOKS === 'true' && process.env.NODE_ENV !== 'production';

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function computeHmac(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * @param {object} integration - dealer_integrations row
 * @param {Buffer|string} rawBody - the raw, unparsed request body (must be
 *   captured before JSON parsing — HMAC verification requires exact bytes)
 * @param {object} headers - lowercased request headers
 */
async function verifyWebhook(catalystApp, integration, rawBody, headers) {
  const webhookEnabled = !(
    integration.webhook_enabled === false || integration.webhook_enabled === 0 ||
    String(integration.webhook_enabled).toLowerCase() === 'false' ||
    String(integration.webhook_enabled) === '0'
  );
  if (!webhookEnabled) {
    return { ok: false, reason: 'WEBHOOK_DISABLED' };
  }

  if (ALLOW_INSECURE_WEBHOOKS) {
    logger.error(
      'webhookVerificationService',
      `ALLOW_INSECURE_WEBHOOKS is enabled for integration ${integration.ROWID}; use only in a local test environment.`
    );
    return { ok: true };
  }

  const webhookSecret = await integrationAuthService.getDecryptedCredential(
    catalystApp,
    integration.ROWID,
    'WEBHOOK_SECRET'
  );

  if (!webhookSecret) {
    logger.error('webhookVerificationService', `No webhook secret configured for integration ${integration.ROWID}`);
    return { ok: false, reason: 'WEBHOOK_AUTH_NOT_CONFIGURED' };
  }

  // Preferred: HMAC signature in X-Signature / X-Webhook-Signature header.
  const signatureHeader = headers['x-webhook-signature'] || headers['x-signature'];
  if (signatureHeader) {
    const expected = computeHmac(webhookSecret, rawBody);
    const provided = signatureHeader.replace(/^sha256=/, '');
    const valid = timingSafeEqual(expected, provided);
    return valid ? { ok: true } : { ok: false, reason: 'INVALID_SIGNATURE' };
  }

  // Fallback: shared bearer token in Authorization header.
  const authHeader = headers['authorization'];
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const valid = timingSafeEqual(token, webhookSecret);
    return valid ? { ok: true } : { ok: false, reason: 'INVALID_TOKEN' };
  }

  // Zoho CRM Notification API echoes the configured watch token in the
  // JSON notification body rather than an HTTP auth header.
  try {
    const parsed = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    if (parsed?.token) {
      const valid = timingSafeEqual(String(parsed.token), webhookSecret);
      return valid ? { ok: true } : { ok: false, reason: 'INVALID_TOKEN' };
    }
  } catch {
    // Invalid JSON is reported by the route after authentication checks.
  }

  return { ok: false, reason: 'MISSING_AUTH' };
}

module.exports = { verifyWebhook, computeHmac };
