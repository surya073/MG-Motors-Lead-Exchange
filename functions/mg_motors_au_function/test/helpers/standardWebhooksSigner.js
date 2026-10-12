'use strict';

const crypto = require('crypto');

/**
 * Signs webhook deliveries the way a Standard Webhooks sender does, which is
 * how Fusion SD documents its webhooks (OpenAPI `webhooks`; FUSION_SD_AUDIT.md
 * §4):
 *   webhook-id         unique per event; a retry repeats it
 *   webhook-timestamp  Unix seconds
 *   webhook-signature  `v1,<base64 HMAC-SHA256 over "id.timestamp.body">`. With
 *                      several secrets there is one entry per secret,
 *                      space-separated, as a sender does while rotating keys.
 *
 * The HMAC key is the base64 part of a `whsec_<base64>` secret, as in the
 * Standard Webhooks libraries, or a Buffer of raw key bytes. Any other string is
 * refused rather than guessed at: how Fusion encodes its signing secret is
 * still open (Q3 in FUSION_REMEDIATION_PLAN.md).
 *
 * `body` is the raw string to sign, or an object to JSON.stringify. The returned
 * `body` is exactly what was signed; send it as-is rather than re-serialising.
 * Header names are lower-case, as Express presents them to the verifier.
 */

const SECRET_PREFIX = 'whsec_';

function signingKey(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  if (typeof secret === 'string' && secret.startsWith(SECRET_PREFIX)) {
    return Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  }
  throw new TypeError('A signing secret must be a whsec_<base64> string or a Buffer of raw key bytes');
}

function signStandardWebhook({
  secret,
  secrets = [secret],
  id = `msg_${crypto.randomBytes(12).toString('hex')}`,
  timestamp = Math.floor(Date.now() / 1000),
  body,
}) {
  if (body === undefined) throw new TypeError('body is required');
  const signedBody = typeof body === 'string' ? body : JSON.stringify(body);
  const signedTimestamp = String(timestamp);
  const signatures = secrets.map((key) => {
    const digest = crypto
      .createHmac('sha256', signingKey(key))
      .update(`${id}.${signedTimestamp}.${signedBody}`)
      .digest('base64');
    return `v1,${digest}`;
  });

  return {
    body: signedBody,
    headers: {
      'webhook-id': id,
      'webhook-timestamp': signedTimestamp,
      'webhook-signature': signatures.join(' '),
    },
  };
}

/** A fresh random secret in the Standard Webhooks `whsec_<base64>` form. */
function generateSigningSecret() {
  return `${SECRET_PREFIX}${crypto.randomBytes(24).toString('base64')}`;
}

module.exports = { signStandardWebhook, generateSigningSecret };
