'use strict';

/**
 * fusionSdInbound.js
 * -----------------------------------------------------------------------
 * Translates a Fusion SD (AMS-Pro) webhook into the record the shared inbound
 * path (crmIntegrationService.processResolvedInboundLead) expects
 * (FUSION_REMEDIATION_PLAN.md, Batch 5; used only with FUSION_INBOUND_V2).
 *
 * Fusion posts the flat PushedLead body (lead-api-mg-motors-openapi 3.yaml,
 * `webhooks`): no envelope, `lead_id` always present, every other field
 * possibly narrowed away, and null meaning "no value / unknown".
 *
 * Only the status comes back to MG (Q16, 13 Oct 2026). Fusion's other fields
 * either have no MG home (names, origin, enquiry type), would overwrite what
 * MG sent with the dealer's own vocabulary (lead_source -> Nature of Enquiry,
 * model), differ only in formatting (phone, which would raise Unhappy 6), or
 * are consent, which MG owns. The status is keyed by the dealer's status
 * mapping target (enquiryStatus in the Fusion preset), so the existing status
 * map, holds and logging apply unchanged. A null or blank status is left out:
 * it is unknown, not a change.
 */

const DEFAULT_STATUS_TARGET = 'enquiryStatus';

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * @param {object} payload - the parsed webhook body
 * @param {object[]} fieldMappings - the dealer's integration_field_mappings rows
 * @returns {{ externalLeadId: string|null, dealerId: string|null, record: object }}
 */
function translateFusionWebhook(payload, fieldMappings = []) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const statusTarget = fieldMappings.find((m) => m.source_field === 'lead_status')?.target_field || DEFAULT_STATUS_TARGET;

  const record = {};
  const status = text(body.status);
  if (status !== null) record[statusTarget] = status;
  // When Fusion sent it; shown with the status change on the lead timeline.
  const pushedAt = text(body.pushed_at);
  if (pushedAt !== null && Object.keys(record).length > 0) record.modified_at = pushedAt;

  return {
    externalLeadId: text(body.lead_id),
    dealerId: text(body.dealer_id),
    record,
    statusTarget,
  };
}

module.exports = { translateFusionWebhook, DEFAULT_STATUS_TARGET };
