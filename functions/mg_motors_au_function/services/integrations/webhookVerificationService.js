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
 */

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
  if (!integration.webhook_enabled) {
    return { ok: false, reason: 'WEBHOOK_DISABLED' };
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

  return { ok: false, reason: 'MISSING_AUTH' };
}

module.exports = { verifyWebhook, computeHmac };