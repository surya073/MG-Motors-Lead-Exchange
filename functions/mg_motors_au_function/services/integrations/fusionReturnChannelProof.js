'use strict';

const crypto = require('crypto');
const integrationAuthService = require('./integrationAuthService');
const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');

const TABLE = 'outbound_sync_claims';
const METHOD = 'STANDARD_WEBHOOKS';
const PREFIX = 'proof:fusion-return-channel:';

function signingSecretFingerprint(secret) {
  return crypto.createHash('sha256')
    .update('mg-lead-exchange:fusion-return-channel:v1:')
    .update(String(secret || '').trim())
    .digest('hex');
}

function quote(value) { return String(value).replace(/'/g, "''"); }
function dealerCode(integration) { return String(integration?.dealer_code || '').trim().toLowerCase(); }
function proofKey(integration) { return `${PREFIX}${integration.ROWID}`; }

async function findProof(catalystApp, integration) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${TABLE} WHERE claim_key = '${quote(proofKey(integration))}' LIMIT 1`
  );
  return rows[0]?.[TABLE] || null;
}

function matches(row, integration, fingerprint) {
  if (row?.claim_key !== proofKey(integration)) return false;
  try {
    const proof = JSON.parse(row.request_reference);
    return proof.signingSecretFingerprint === fingerprint &&
      String(proof.dealerCode || '').trim().toLowerCase() === dealerCode(integration) &&
      typeof proof.verifiedAt === 'string' && Number.isFinite(Date.parse(proof.verifiedAt));
  } catch { return false; }
}

function isSignedSuccess(integration, authResult) {
  return integration?.crm_type === 'FUSION_SD' && integration.ROWID && dealerCode(integration) &&
    authResult?.ok === true && authResult.method === METHOD &&
    /^[a-f0-9]{64}$/.test(String(authResult.signingSecretFingerprint || ''));
}

/** A durable receipt in an existing table, not an operation lease. No
 * acquire/release/TTL applies to this namespaced key. Keep one row per
 * integration and signing-secret version; steady traffic reads without
 * rewriting it. A rotated secret or reassigned dealer invalidates it. */
async function recordVerifiedSuccess(catalystApp, integration, authResult) {
  if (!isSignedSuccess(integration, authResult)) return false;
  const fingerprint = authResult.signingSecretFingerprint;
  try {
    const existing = await findProof(catalystApp, integration);
    if (matches(existing, integration, fingerprint)) return true;
    const fields = {
      claim_key: proofKey(integration),
      claimed_at: toCatalystDateTime(),
      request_reference: JSON.stringify({
        signingSecretFingerprint: fingerprint,
        verifiedAt: new Date().toISOString(),
        dealerCode: dealerCode(integration),
      }),
    };
    const table = catalystApp.datastore().table(TABLE);
    if (existing) {
      await table.updateRow({ ROWID: existing.ROWID, ...fields });
    } else {
      try { await table.insertRow(fields); } catch (err) {
        // The existing UNIQUE claim_key also arbitrates concurrent first
        // receipts. Re-read rather than assuming an undocumented error code.
        const concurrent = await findProof(catalystApp, integration);
        if (!concurrent) throw err;
        if (!matches(concurrent, integration, fingerprint)) {
          await table.updateRow({ ROWID: concurrent.ROWID, ...fields });
        }
      }
    }
    return true;
  } catch (err) {
    // Delivery already succeeded. A missing proof only exempts this dealer
    // from action-based SLA decisions; it must not make Fusion retry a lead.
    logger.error('fusionReturnChannelProof', `Could not store signed return-channel proof for integration ${integration.ROWID}`);
    return false;
  }
}

/** Legacy dedupe can report a FAILED or absent event as a duplicate. Only
 * a freshly signed copy of the exact body of a stored SUCCESS proves the
 * channel; do not infer signed provenance from event_id alone. */
async function recordVerifiedDuplicate(catalystApp, integration, authResult, eventId, rawBody) {
  if (!isSignedSuccess(integration, authResult) || !eventId) return false;
  try {
    const payloadHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT ROWID, error_message FROM webhook_events WHERE integration_id = '${quote(integration.ROWID)}' ` +
      `AND event_id = '${quote(String(eventId).slice(0, 150))}' AND processing_status = 'SUCCESS' ` +
      `AND payload_hash = '${payloadHash}' LIMIT 1`
    );
    if (!rows.length) return false;
    if (String(rows[0].webhook_events?.error_message || '').startsWith('TERMINAL:')) return false;
    return recordVerifiedSuccess(catalystApp, integration, authResult);
  } catch {
    logger.error('fusionReturnChannelProof', `Could not verify successful duplicate for integration ${integration.ROWID}`);
    return false;
  }
}

/** Used by the SLA gate. Read failures propagate so the caller fails
 * closed for this dealer. Successful-event retention cannot erase proof. */
async function getReturnChannelGap(catalystApp, integration) {
  const secret = await integrationAuthService.getDecryptedCredential(
    catalystApp, integration.ROWID, 'WEBHOOK_SIGNING_SECRET'
  );
  if (!String(secret || '').trim()) return 'NO_SIGNING_SECRET';
  const row = await findProof(catalystApp, integration);
  return matches(row, integration, signingSecretFingerprint(secret)) ? null : 'NO_VERIFIED_WEBHOOK';
}

module.exports = {
  signingSecretFingerprint,
  recordVerifiedSuccess,
  recordVerifiedDuplicate,
  getReturnChannelGap,
};
