'use strict';

const crypto = require('crypto');
const { DERIVED_SOURCE_FIELDS } = require('./leadMappingService');

/**
 * leadFingerprintService.js
 * -----------------------------------------------------------------------
 * ECHO SUPPRESSION — the fix for the OEM <-> dealer sync loop.
 *
 * THE BUG THIS REPLACES
 * ---------------------
 * crmIntegrationService used to store, on every outbound push:
 *     last_sync_source_hash = sha256(JSON.stringify(outboundPayload))
 * where outboundPayload is the MAPPED EXTERNAL payload (dealer CRM's
 * target_field names only), and then compare it on the way back in
 * against:
 *     sha256(JSON.stringify(externalRecord))
 * where externalRecord is the dealer CRM's WHOLE record (their field
 * names plus Zoho system fields: id, Created_Time, Modified_Time,
 * Owner, $approval, ...).
 *
 * Those are two structurally different objects, so the two hashes could
 * never be equal and the LOOP_PREVENTED branch was unreachable dead
 * code. Every write we made to a dealer CRM came straight back to us via
 * their watch channel, and every write we made to MG's CRM came straight
 * back via ours — visible in integration_logs as an outbound Happy 1
 * followed under a second later by an inbound Happy 5 / Happy 2, all day.
 *
 * THE FIX
 * -------
 * Fingerprint the lead's BUSINESS STATE in INTERNAL terms, so both
 * directions can compute the identical value:
 *
 *   outbound — project the leads row onto the integration's mapped
 *              source_fields (+ lead_status) and fingerprint that.
 *   inbound  — project the POST-UPDATE state (existing row overlaid
 *              with the mapped inbound update) onto the same key set
 *              and fingerprint that.
 *
 * If the dealer CRM is merely echoing back the values we just pushed,
 * the two projections are equal and we suppress. If the dealer genuinely
 * changed something, at least one value differs and it flows through.
 *
 * The key set is derived from the integration's own field mappings, so
 * it is identical in both directions by construction, and the result is
 * a 64-char hex digest which fits lead_integrations.last_sync_source_hash
 * (varchar 64) with no schema change.
 */

// Always part of the fingerprint even when no explicit field mapping row
// exists for it — status is mapped separately from the field mappings
// (see leadMappingService.mapStatus) but is absolutely part of the
// business state we're comparing.
const ALWAYS_INCLUDED_FIELDS = ['lead_status'];

/**
 * Normalises one value so that cosmetic differences between the two
 * systems don't register as a real change:
 *   - null / undefined collapse to '' (a cleared field and an absent
 *     field are the same thing for comparison purposes)
 *   - booleans become 'true' / 'false' so Catalyst's boolean columns and
 *     a dealer CRM's "true" string agree
 *   - everything else is trimmed
 */
function normalizeValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).trim();
}

/**
 * The ordered, de-duplicated list of internal field names that make up a
 * fingerprint for this integration. Sorted so key order can never differ
 * between the two call sites.
 */
function fingerprintKeys(fieldMappings) {
  const keys = new Set(ALWAYS_INCLUDED_FIELDS);
  (fieldMappings || []).forEach((m) => {
    if (m && m.source_field) keys.add(m.source_field);
    // A computed source (enquiry_channel) changes when the field it is
    // computed from changes, so that field is part of the fingerprint too.
    if (m && DERIVED_SOURCE_FIELDS[m.source_field]) keys.add(DERIVED_SOURCE_FIELDS[m.source_field]);
  });
  return Array.from(keys).sort();
}

/**
 * @param {object} internalState - any object keyed by INTERNAL field
 *   names (a leads row, or a merged post-update state). Missing keys are
 *   treated as empty rather than omitted, so a partial webhook and a
 *   full record produce the same fingerprint for the same business state.
 * @param {Array}  fieldMappings - the integration's field mapping rows.
 */
// MG's Lead_Status labels "Lost" and "Dropped" store Lost Lead and Junk Lead
// (Q26). We write the stored value, but MG's own notification brings back the
// label, so without this an applied dealer status never matched its echo and
// was pushed straight back to the dealer (28 Oct 2026: a Fusion Lost went
// back out mapped from "Lost", which most Fusion maps send as Prospect Lost).
const MG_STATUS_LABEL_VALUES = Object.freeze({ lost: 'Lost Lead', dropped: 'Junk Lead' });

function canonicalStatus(value) {
  const text = normalizeValue(value);
  return MG_STATUS_LABEL_VALUES[text.toLowerCase()] || text;
}

function computeFingerprint(internalState, fieldMappings) {
  const keys = fingerprintKeys(fieldMappings);
  const canonical = {};
  keys.forEach((key) => {
    const value = internalState ? internalState[key] : '';
    canonical[key] = key === 'lead_status' ? canonicalStatus(value) : normalizeValue(value);
  });
  // The lead outcome is sent to Fusion with the status, so an outcome change
  // is a real change. Left out when empty, so fingerprints of leads without
  // an outcome are unchanged.
  const outcome = normalizeValue(internalState ? internalState.enquiry_outcome : '');
  if (outcome !== '') canonical.enquiry_outcome = outcome;
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Inbound helper: the state the leads row WOULD have if this update were
 * applied. Compared against the fingerprint we stored on our last
 * outbound push — equal means the dealer CRM is echoing us back.
 */
function computeProjectedInboundFingerprint(existingLeadRow, internalUpdate, fieldMappings) {
  return computeFingerprint({ ...(existingLeadRow || {}), ...(internalUpdate || {}) }, fieldMappings);
}

module.exports = {
  computeFingerprint,
  computeProjectedInboundFingerprint,
  fingerprintKeys,
  normalizeValue,
};
