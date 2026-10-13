'use strict';

const logger = require('../../utils/logger');
const integrationAuthService = require('./integrationAuthService');
const { isFusionChangesOnlyPatchEnabled } = require('../../config/env');

/**
 * sentPayloadSnapshot.js
 * -----------------------------------------------------------------------
 * Batch 10 (FUSION_REMEDIATION_PLAN.md): with FUSION_CHANGES_ONLY_PATCH on,
 * the full payload last sent to a Fusion SD dealer is kept, encrypted (it
 * holds customer details), in lead_integrations.last_sent_payload, so the
 * next update sends only the fields that changed (merge-patch, as Fusion
 * asks).
 *
 * The snapshot is written on its own and never fails a sync: when the
 * column does not exist yet, the value is too large for it, or it cannot be
 * read back, there is no snapshot and the next update sends the full lead,
 * as before.
 */

const LEAD_INTEGRATIONS_TABLE = 'lead_integrations';
// Catalyst Text column limit (as on the other text columns of this table).
const MAX_STORED_LENGTH = 10000;

function usesChangesOnlyPatch(integration) {
  return integration?.crm_type === 'FUSION_SD' && isFusionChangesOnlyPatchEnabled();
}

function serialize(payload) {
  try {
    const sorted = Object.fromEntries(Object.keys(payload || {}).sort().map((k) => [k, payload[k]]));
    const encrypted = integrationAuthService.encrypt(JSON.stringify(sorted));
    return encrypted.length <= MAX_STORED_LENGTH ? encrypted : null;
  } catch (err) {
    logger.error('sentPayloadSnapshot', 'Could not encrypt the sent payload; no snapshot kept', err);
    return null;
  }
}

/** The payload last sent for this mapping row, or null when there is none. */
function read(mappingRow) {
  const stored = mappingRow?.last_sent_payload;
  if (!stored) return null;
  try {
    const parsed = JSON.parse(integrationAuthService.decrypt(stored));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Keeps `payload` as this mapping's snapshot; on any failure, clears it. */
async function store(catalystApp, mappingRowId, payload) {
  if (!mappingRowId) return;
  const table = catalystApp.datastore().table(LEAD_INTEGRATIONS_TABLE);
  const value = serialize(payload);
  try {
    await table.updateRow({ ROWID: mappingRowId, last_sent_payload: value || '' });
  } catch (err) {
    logger.error(
      'sentPayloadSnapshot',
      `Could not keep the sent payload of mapping ${mappingRowId} (does lead_integrations.last_sent_payload exist?); the next update sends the full lead`,
      err
    );
  }
}

/**
 * The fields of `current` that differ from `previous`, for a merge-patch.
 * A field MG emptied (empty, null or absent) is left out, so Fusion keeps its
 * value (Q32: nothing at the dealer is ever cleared by MG).
 */
function changedFields(previous, current) {
  const changes = {};
  Object.entries(current || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (JSON.stringify(previous?.[key]) !== JSON.stringify(value)) changes[key] = value;
  });
  return changes;
}

module.exports = { usesChangesOnlyPatch, serialize, read, store, changedFields, MAX_STORED_LENGTH };
