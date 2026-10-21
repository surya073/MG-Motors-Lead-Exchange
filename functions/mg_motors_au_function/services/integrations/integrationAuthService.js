'use strict';

const crypto = require('crypto');
const logger = require('../../utils/logger');

/**
 * integrationAuthService.js
 * -----------------------------------------------------------------------
 * Encrypts/decrypts external-CRM credentials before they touch
 * integration_credentials. Never logs plaintext or ciphertext values.
 *
 * Uses AES-256-GCM with a key sourced from env (INTEGRATION_CREDENTIALS_KEY,
 * 32 raw bytes, base64-encoded in Catalyst's environment config — see
 * config/env.js). Do NOT fall back to a hardcoded key in any environment.
 *
 * ASSUMPTION (flag for review): config/env.js was not provided to me, so
 * I'm reading process.env directly here. If env.js centralizes config
 * access elsewhere in this codebase, move this read into env.js instead
 * for consistency and re-export it from there.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey() {
  const keyB64 = process.env.INTEGRATION_CREDENTIALS_KEY;
  if (!keyB64) {
    throw new Error('INTEGRATION_CREDENTIALS_KEY is not configured');
  }
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error('INTEGRATION_CREDENTIALS_KEY must decode to 32 bytes');
  }
  return key;
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack iv + authTag + ciphertext, base64 the whole thing.
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

function decrypt(packedB64) {
  const key = getKey();
  const packed = Buffer.from(packedB64, 'base64');
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = packed.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Stores/updates a single credential for an integration. Upserts by
 * (integration_id, credential_type) — never duplicates rows.
 */
async function saveCredential(catalystApp, integrationId, credentialType, plaintextValue) {
  const table = catalystApp.datastore().table('integration_credentials');
  const encrypted_value = encrypt(plaintextValue);

  const existingRows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID FROM integration_credentials WHERE integration_id = ${integrationId} AND credential_type = '${credentialType}'`
  );

  if (existingRows.length > 0) {
    const rowId = existingRows[0].integration_credentials.ROWID;
    await table.updateRow({ ROWID: rowId, encrypted_value });
    return rowId;
  }

  const inserted = await table.insertRow({ integration_id: integrationId, credential_type: credentialType, encrypted_value });
  return inserted.ROWID;
}

async function getDecryptedCredential(catalystApp, integrationId, credentialType) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT encrypted_value FROM integration_credentials WHERE integration_id = ${integrationId} AND credential_type = '${credentialType}'`
  );
  if (rows.length === 0) return null;
  try {
    return decrypt(rows[0].integration_credentials.encrypted_value);
  } catch (err) {
    logger.error('integrationAuthService', `Failed to decrypt credential for integration ${integrationId}`, err);
    throw Object.assign(new Error('CREDENTIAL_DECRYPT_FAILED'), { code: 'CREDENTIAL_DECRYPT_FAILED' });
  }
}

async function hasCredential(catalystApp, integrationId, credentialType) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID FROM integration_credentials WHERE integration_id = ${integrationId} AND credential_type = '${credentialType}'`
  );
  return rows.length > 0;
}

// One persisted snapshot makes credential generation changes visible to every
// warm function instance. Hash ciphertext, never put credential values in a
// cache key or log. No new datastore columns are required.
async function getCredentialSnapshot(catalystApp, integrationId, credentialTypes) {
  if (!/^\d+$/.test(String(integrationId)) ||
      !credentialTypes.every((type) => /^[A-Z0-9_]+$/.test(type))) {
    throw Object.assign(new Error('Invalid credential snapshot scope'), { code: 'INVALID_CRM_CONFIGURATION' });
  }
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT credential_type, encrypted_value FROM integration_credentials WHERE integration_id = ${integrationId} AND credential_type IN (${credentialTypes.map((type) => `'${type}'`).join(', ')})`
  );
  const entries = new Map();
  for (const result of rows) {
    const row = result.integration_credentials;
    if (!row || !credentialTypes.includes(row.credential_type)) continue;
    if (entries.has(row.credential_type)) {
      throw Object.assign(new Error('Duplicate OAuth credential rows require repair'), { code: 'INVALID_CRM_CONFIGURATION' });
    }
    entries.set(row.credential_type, row.encrypted_value);
  }
  const serialized = credentialTypes.slice().sort().map((type) => [type, entries.get(type) || null]);
  const generation = crypto.createHash('sha256').update(JSON.stringify(serialized)).digest('hex');
  const credentials = {};
  try {
    for (const type of credentialTypes) credentials[type] = entries.has(type) ? decrypt(entries.get(type)) : null;
  } catch {
    throw Object.assign(new Error('CREDENTIAL_DECRYPT_FAILED'), { code: 'CREDENTIAL_DECRYPT_FAILED' });
  }
  return { generation, credentials };
}

/**
 * Maps an auth_type to the credential_type it stores, so callers don't
 * need to know the mapping.
 */
const AUTH_TYPE_TO_CREDENTIAL_TYPE = {
  API_KEY: 'API_KEY',
  BEARER_TOKEN: 'BEARER_TOKEN',
  BASIC_AUTH: 'BASIC_AUTH_PASSWORD',
  OAUTH2: 'OAUTH2_CLIENT_SECRET',
  CUSTOM_HEADER: 'CUSTOM_HEADER_VALUE',
};

module.exports = {
  encrypt,
  decrypt,
  saveCredential,
  getDecryptedCredential,
  hasCredential,
  getCredentialSnapshot,
  AUTH_TYPE_TO_CREDENTIAL_TYPE,
};
