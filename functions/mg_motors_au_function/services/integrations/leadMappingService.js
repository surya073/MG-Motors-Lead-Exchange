'use strict';

const logger = require('../../utils/logger');

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
function mapZohoLeadToExternal(zohoLead, fieldMappings) {
  const payload = {};
  const missingRequired = [];

  fieldMappings.forEach((mapping) => {
    const value = zohoLead[mapping.source_field];
    if ((value === undefined || value === null || value === '') && mapping.required) {
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
function mapExternalLeadToZoho(externalPayload, fieldMappings) {
  const update = {};
  fieldMappings.forEach((mapping) => {
    const value = externalPayload[mapping.target_field];
    if (value !== undefined) {
      update[mapping.source_field] = value;
    }
  });
  return update;
}

function mapStatus(status, statusMappings, direction) {
  const match = statusMappings.find((m) => m.direction === direction && m.source_status === status);
  if (!match) {
    const err = new Error(`No status mapping found for "${status}" (${direction})`);
    err.code = 'STATUS_MAPPING_NOT_FOUND';
    throw err;
  }
  return match.target_status;
}

module.exports = { mapZohoLeadToExternal, mapExternalLeadToZoho, mapStatus };