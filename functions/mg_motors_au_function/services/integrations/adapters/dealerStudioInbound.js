'use strict';

/**
 * dealerStudioInbound.js
 * -----------------------------------------------------------------------
 * Translates a Dealer Studio Lead Cluster Webhook body into what the shared
 * inbound path (crmIntegrationService.processResolvedInboundLead) expects.
 * Contract: https://dev.dealerstudio.com.au/guides/lms/lead-cluster-webhook/
 * and the Two-Way Lead Integration Guide (data/dealerStudioDocs).
 *
 * Dealer Studio posts the whole CLUSTER (the customer's leads at one
 * dealership) on every change: contact edits, events, assignee, status. So:
 *   - The root `id` is the cluster id, not the lead id MG stored from the
 *     create response. The lead ids are in `leads[].id`; those are matched
 *     first, and the root id only as a fallback.
 *   - Most posts carry no status change. Only the status comes back to MG
 *     (as for Fusion): names, contact details and vehicles would overwrite
 *     what MG sent with the dealer's own wording, or raise phone-format
 *     differences. A post without a status is acknowledged, not held.
 *
 * Status: the guide recommends mapping on the status TYPE (new, working,
 * converted, delivered, lost, invalid), since dealers rename statuses. It is
 * read from `status_type` (or `lead_status_option.status_type`) and lowercased;
 * the status name (`status`, e.g. "Contacted") is the fallback. The webhook
 * docs page does not list status_type, the PDF does: confirm against a real
 * payload from the test session.
 *
 * Not handled yet (no MG mapping decided): lost_reason / lost_reason_comment,
 * appointments and test_drives.
 */

const DEFAULT_STATUS_TARGET = 'status';
const MAX_CANDIDATE_IDS = 25;

function text(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function uniqueIds(values) {
  const seen = new Set();
  values.forEach((value) => {
    const id = text(value);
    if (id !== null) seen.add(id);
  });
  return [...seen].slice(0, MAX_CANDIDATE_IDS);
}

/**
 * @param {object} payload - the parsed webhook body
 * @param {object[]} fieldMappings - the dealer's integration_field_mappings rows
 * @returns {{ leadIds: string[], clusterId: string|null, statusTarget: string,
 *             record: object, hasStatus: boolean, statusType: string|null, statusName: string|null }}
 */
function translateDealerStudioWebhook(payload, fieldMappings = []) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const statusTarget = fieldMappings.find((m) => m.source_field === 'lead_status')?.target_field || DEFAULT_STATUS_TARGET;

  const option = body.lead_status_option && typeof body.lead_status_option === 'object' ? body.lead_status_option : {};
  const statusType = (text(body.status_type) ?? text(option.status_type))?.toLowerCase() ?? null;
  // v1 sends `status` as the name; allow an object { name } too.
  const statusName = text(typeof body.status === 'object' && body.status ? body.status.name : body.status) ?? text(option.name);
  const status = statusType ?? statusName;

  const record = {};
  if (status !== null) record[statusTarget] = status;
  const changedAt = text(body.updated_at) ?? text(body.modified);
  if (changedAt !== null && status !== null) record.modified_at = changedAt;

  const leads = Array.isArray(body.leads) ? body.leads : [];
  return {
    leadIds: uniqueIds(leads.map((lead) => (lead && typeof lead === 'object' ? lead.id : null))),
    clusterId: text(body.id),
    statusTarget,
    record,
    hasStatus: status !== null,
    statusType,
    statusName,
  };
}

module.exports = { translateDealerStudioWebhook, DEFAULT_STATUS_TARGET };
