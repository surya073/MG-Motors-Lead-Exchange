'use strict';

/**
 * dealerStudioInbound.js
 * -----------------------------------------------------------------------
 * Translates a Dealer Studio Lead Cluster Webhook body (schema v3) into what
 * the shared inbound path (crmIntegrationService.processResolvedInboundLead)
 * expects. Contract: https://dev.dealerstudio.com.au/guides/lms/lead-cluster-webhook/,
 * the Two-Way Lead Integration Guide and the Dealer Studio API mapping update
 * (data/dealerStudioDocs).
 *
 * Dealer Studio posts the whole CLUSTER (the customer's leads at one
 * dealership) on every change: contact edits, events, assignee, status. So:
 *   - The root `id` is the cluster id, not the lead id MG stored from the
 *     create response. The lead ids are in `leads[].id`; those are matched
 *     first, and the root id only as a fallback.
 *   - Most posts carry no status change. Only the status, the test-drive
 *     outcome and the lost reason come back to MG: names, contact details and
 *     vehicles would overwrite what MG sent with the dealer's own wording, or
 *     raise phone-format differences. A post with none of them is acknowledged,
 *     not held.
 *
 * Schema v3 (v2 plus a `provider` object) fields read here:
 *   - status_type: new, working, converted, delivered, lost, invalid. The guide
 *     recommends mapping on the TYPE since dealers rename statuses. Read from
 *     `status_type` (or `lead_status_option.status_type`) and lowercased; the
 *     status name (`status`) is the fallback.
 *   - lost_reason / lost_reason_comment.
 *   - test_drives[]: { status, checked_out_at, checked_in_at }. A `Completed`
 *     entry means MG Enquiry Outcome = "Test Drive".
 *   - appointments[]: { purpose, status, starts_at } (booked test drives).
 *     Parsed and validated; MG has no field to hold them, so they are logged only.
 *   - provider: { name, provider_id }, the provider name and the id MG sent
 *     (the MG Enquiry ID), used to find the lead when its ids do not match.
 * Malformed entries are skipped, never thrown on.
 */

const { PROVIDER_NAME } = require('./dealerStudioPayload');

const DEFAULT_STATUS_TARGET = 'status';
const DEFAULT_OUTCOME_TARGET = 'enquiry_outcome';
const TEST_DRIVE_OUTCOME = 'Test Drive';
const MAX_CANDIDATE_IDS = 25;
const MAX_LIST_ITEMS = 50;

// Dealer Studio lost reasons (webhook guide) onto MG's Reason_for_Lost
// picklist. Only "Bought elsewhere" has a matching MG value (also used for
// Fusion); every other reason is Other, and Dealer Studio's own wording always
// goes to Reason_For_Loss_Other so nothing is lost.
const LOST_REASONS = Object.freeze({
  bought_elsewhere: { label: 'Bought elsewhere', mg: 'Bought Elsewhere' },
  unable_to_contact: { label: 'Unable to contact despite several attempts', mg: 'Other' },
  failed_on_finance: { label: "Couldn't get finance", mg: 'Other' },
  too_expensive: { label: 'Car too expensive', mg: 'Other' },
  lost_on_location: { label: 'Lost on location', mg: 'Other' },
  vehicle_unavailable: { label: 'Vehicle unavailable', mg: 'Other' },
  change_in_circumstances: { label: 'Change in circumstances', mg: 'Other' },
  offer_price_too_low: { label: 'Offer price too low', mg: 'Other' },
  sold_elsewhere: { label: 'Sold elsewhere', mg: 'Other' },
  just_curious: { label: 'Just curious', mg: 'Other' },
  undesirable_item: { label: 'Undesirable item', mg: 'Other' },
  other: { label: 'Other', mg: 'Other' },
});

// MG outcomes a completed test drive may not replace: the lead has moved on.
const OUTCOMES_OPEN_TO_TEST_DRIVE = new Set(['', '-none-', 'outcome pending', 'no outcome', 'test drive']);

function text(value, max = 500) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
}

function uniqueIds(values) {
  const seen = new Set();
  values.forEach((value) => {
    const id = text(value, 128);
    if (id !== null) seen.add(id);
  });
  return [...seen].slice(0, MAX_CANDIDATE_IDS);
}

function objects(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .slice(0, MAX_LIST_ITEMS);
}

function parseAppointments(list) {
  return objects(list)
    .map((item) => ({ purpose: text(item.purpose), status: text(item.status), startsAt: text(item.starts_at) }))
    .filter((item) => item.purpose || item.status || item.startsAt);
}

function parseTestDrives(list) {
  return objects(list)
    .map((item) => ({
      status: text(item.status),
      checkedOutAt: text(item.checked_out_at),
      checkedInAt: text(item.checked_in_at),
    }))
    .filter((item) => item.status || item.checkedOutAt || item.checkedInAt);
}

/** The lost reason as the shared path's lost-detail shape (see crmIntegrationService.lostReasonFields). */
function parseLost(body, changedAt) {
  const code = text(body.lost_reason, 100);
  const comment = text(body.lost_reason_comment, 1000);
  if (!code && !comment) return null;
  const known = code ? LOST_REASONS[code.toLowerCase()] : null;
  return {
    reason: known ? known.label : (code ? code.replace(/_/g, ' ') : 'No reason given'),
    subReason: comment,
    at: changedAt,
    mgReason: known ? known.mg : 'Other',
    dealerLabel: 'Dealer Studio',
    verbatim: true,
  };
}

function parseProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = text(value.name, 100);
  const providerId = text(value.provider_id, 128);
  return name || providerId ? { name, providerId } : null;
}

/** Whether the provider on the webhook is MG's exchange (or unnamed, so not someone else's). */
function isOurProvider(provider) {
  return Boolean(provider) && (!provider.name || provider.name.toLowerCase() === PROVIDER_NAME.toLowerCase());
}

/**
 * @param {object} payload - the parsed webhook body
 * @param {object[]} fieldMappings - the dealer's integration_field_mappings rows
 * @returns {{ leadIds: string[], clusterId: string|null, statusTarget: string, outcomeTarget: string,
 *             record: object, hasStatus: boolean, statusType: string|null, statusName: string|null,
 *             outcome: string|null, lost: object|null, appointments: object[], testDrives: object[],
 *             provider: object|null, hasUpdate: boolean }}
 */
function translateDealerStudioWebhook(payload, fieldMappings = []) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const statusTarget = fieldMappings.find((m) => m.source_field === 'lead_status')?.target_field || DEFAULT_STATUS_TARGET;
  const outcomeTarget = fieldMappings.find((m) => m.source_field === 'enquiry_outcome')?.target_field || DEFAULT_OUTCOME_TARGET;

  const option = body.lead_status_option && typeof body.lead_status_option === 'object' ? body.lead_status_option : {};
  const statusType = (text(body.status_type, 50) ?? text(option.status_type, 50))?.toLowerCase() ?? null;
  // v1 sends `status` as the name; allow an object { name } too.
  const statusName = text(typeof body.status === 'object' && body.status ? body.status.name : body.status) ?? text(option.name);
  const status = statusType ?? statusName;

  const changedAt = text(body.updated_at) ?? text(body.modified);
  const appointments = parseAppointments(body.appointments);
  const testDrives = parseTestDrives(body.test_drives);
  const outcome = testDrives.some((drive) => drive.status?.toLowerCase() === 'completed') ? TEST_DRIVE_OUTCOME : null;

  const record = {};
  if (status !== null) record[statusTarget] = status;
  if (changedAt !== null && status !== null) record.modified_at = changedAt;
  if (outcome !== null) record[outcomeTarget] = outcome;

  const leads = Array.isArray(body.leads) ? body.leads : [];
  return {
    leadIds: uniqueIds(leads.map((lead) => (lead && typeof lead === 'object' ? lead.id : null))),
    clusterId: text(body.id, 128),
    statusTarget,
    outcomeTarget,
    record,
    hasStatus: status !== null,
    statusType,
    statusName,
    outcome,
    lost: parseLost(body, changedAt),
    appointments,
    testDrives,
    provider: parseProvider(body.provider),
    hasUpdate: status !== null || outcome !== null,
  };
}

/**
 * A completed test drive never replaces an outcome the lead has already moved
 * past (Retail Order, Fleet Order, On-Sold Demo, Lost): clusters repeat on every
 * change, so the same Completed drive is posted again after the sale.
 * @returns {boolean} whether the MG outcome may be set to Test Drive
 */
function mayApplyTestDriveOutcome(existingOutcome) {
  return OUTCOMES_OPEN_TO_TEST_DRIVE.has(String(existingOutcome ?? '').trim().toLowerCase());
}

module.exports = {
  translateDealerStudioWebhook,
  mayApplyTestDriveOutcome,
  isOurProvider,
  DEFAULT_STATUS_TARGET,
  DEFAULT_OUTCOME_TARGET,
  TEST_DRIVE_OUTCOME,
  LOST_REASONS,
};
