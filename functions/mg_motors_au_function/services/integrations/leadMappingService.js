'use strict';

const { normalizeStatus } = require('./pathPolicyService');

/**
 * leadMappingService.js
 * -----------------------------------------------------------------------
 * Pure field/status transformation — no I/O beyond reading mapping config
 * rows already loaded by the caller. Keeps crmIntegrationService free of
 * transformation logic so it can focus on orchestration.
 */

/**
 * Transforms a Zoho lead object into the external CRM's payload shape
 * using the integration's field mappings. Throws FIELD_MAPPING_INVALID
 * if a required target field has no source value.
 */
function isTrue(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function mapZohoLeadToExternal(zohoLead, fieldMappings, { excludeSourceFields = [] } = {}) {
  const payload = {};
  const missingRequired = [];
  const excluded = new Set(excludeSourceFields);

  fieldMappings.forEach((mapping) => {
    if (excluded.has(mapping.source_field)) return;
    const value = zohoLead[mapping.source_field];
    if ((value === undefined || value === null || value === '') && isTrue(mapping.required)) {
      missingRequired.push(mapping.source_field);
      return;
    }
    if (value !== undefined) {
      payload[mapping.target_field] = value;
    }
  });

  if (missingRequired.length > 0) {
    const err = new Error(`Missing required fields: ${missingRequired.join(', ')}`);
    err.code = 'FIELD_MAPPING_INVALID';
    throw err;
  }

  return payload;
}

/**
 * Reverse direction: external CRM payload -> Zoho-shaped update object.
 * Unlike the outbound direction, missing fields are simply omitted
 * (a partial webhook update shouldn't fail validation) rather than
 * throwing, since dealers' CRMs may only send changed fields.
 */
function mapExternalLeadToZoho(externalPayload, fieldMappings, { excludeSourceFields = [] } = {}) {
  const update = {};
  const excluded = new Set(excludeSourceFields);
  fieldMappings.forEach((mapping) => {
    if (excluded.has(mapping.source_field)) return;
    const value = externalPayload[mapping.target_field];
    if (value !== undefined) {
      update[mapping.source_field] = value;
    }
  });
  return update;
}

const DIRECTION_ALIASES = Object.freeze({
  ZOHO_TO_EXTERNAL: 'ZOHO_TO_EXTERNAL',
  ZOHO_TO_EXTERNAL_CRM: 'ZOHO_TO_EXTERNAL',
  EXTERNAL_TO_ZOHO: 'EXTERNAL_TO_ZOHO',
  EXTERNAL_CRM_TO_ZOHO: 'EXTERNAL_TO_ZOHO',
});

function normalizedDirection(value) {
  return DIRECTION_ALIASES[String(value || '').trim().toUpperCase()] || '';
}

function mappedCandidates(status, statusMappings, direction) {
  const rows = (statusMappings || []).filter(Boolean);
  const needle = normalizeStatus(status);
  const explicit = rows.filter((row) => normalizedDirection(row.direction) === direction);
  const legacy = rows.filter((row) => !normalizedDirection(row.direction));

  // Directional rows store the source and target in their actual transport
  // direction. This is the shape written by the admin route:
  //   MG -> dealer: source=MG,     target=dealer
  //   dealer -> MG: source=dealer, target=MG
  const explicitMatches = explicit
    .filter((row) => normalizeStatus(row.source_status) === needle)
    .map((row) => ({ row, result: row.target_status }));
  if (explicitMatches.length > 0) return explicitMatches;

  // Backward compatibility for the early schema, where only a forward
  // pair existed and inbound mapping reversed that same pair implicitly.
  const legacyMatches = legacy
    .filter((row) => normalizeStatus(
      direction === 'ZOHO_TO_EXTERNAL' ? row.source_status : row.target_status
    ) === needle)
    .map((row) => ({
      row,
      result: direction === 'ZOHO_TO_EXTERNAL' ? row.target_status : row.source_status,
    }));
  if (legacyMatches.length > 0) return legacyMatches;

  // Some integrations were provisioned with forward rows only even after
  // the direction column was added. Derive the reverse as a final, safe
  // compatibility path, but never let it override an explicit inbound row.
  if (direction === 'EXTERNAL_TO_ZOHO') {
    return rows
      .filter((row) => normalizedDirection(row.direction) === 'ZOHO_TO_EXTERNAL')
      .filter((row) => normalizeStatus(row.target_status) === needle)
      .map((row) => ({ row, result: row.source_status }));
  }

  return [];
}

/**
 * Translates a status using the row's direction. The old implementation
 * ignored `direction` and searched both forward and reverse rows as though
 * every row were MG -> dealer. With duplicated/reversed AU008 rows, query
 * order then decided the answer and valid dealer values could be written
 * back to MG, where Zoho rejected them as INVALID_DATA.
 *
 * @param {Set<string>} [options.validDestinationValues] accepted destination
 *   values. Raw or normalized values are accepted by this function.
 */
function mapStatus(status, statusMappings, direction, options = {}) {
  const normalizedRequestedDirection = normalizedDirection(direction);
  if (!normalizedRequestedDirection) {
    const err = new Error(`Unknown mapping direction "${direction}"`);
    err.code = 'STATUS_MAPPING_NOT_FOUND';
    throw err;
  }

  let candidates = mappedCandidates(
    status,
    statusMappings,
    normalizedRequestedDirection
  );
  if (candidates.length === 0) {
    const err = new Error(`No status mapping found for "${status}" (${normalizedRequestedDirection})`);
    err.code = 'STATUS_MAPPING_NOT_FOUND';
    err.unmappedValue = status;
    throw err;
  }

  const accepted = options.validDestinationValues
    ? new Set(Array.from(options.validDestinationValues, normalizeStatus))
    : null;
  if (accepted && accepted.size > 0) {
    const usable = candidates.filter(({ result }) => accepted.has(normalizeStatus(result)));
    if (usable.length === 0) {
      const attempted = candidates.map(({ result }) => result).join(', ');
      const err = new Error(
        `Status "${status}" (${normalizedRequestedDirection}) maps to "${attempted}", which the destination CRM does not accept`
      );
      err.code = 'STATUS_MAPPING_INVALID_TARGET';
      err.unmappedValue = status;
      err.attemptedValue = attempted;
      throw err;
    }
    candidates = usable;
  }

  const uniqueResults = new Map();
  candidates.forEach(({ result }) => uniqueResults.set(normalizeStatus(result), result));
  if (uniqueResults.size > 1) {
    const attempted = Array.from(uniqueResults.values()).join(', ');
    const err = new Error(
      `Ambiguous status mapping for "${status}" (${normalizedRequestedDirection}): ${attempted}`
    );
    err.code = 'STATUS_MAPPING_AMBIGUOUS';
    err.unmappedValue = status;
    err.attemptedValue = attempted;
    throw err;
  }

  return candidates[0].result;
}

module.exports = { mapZohoLeadToExternal, mapExternalLeadToZoho, mapStatus };
