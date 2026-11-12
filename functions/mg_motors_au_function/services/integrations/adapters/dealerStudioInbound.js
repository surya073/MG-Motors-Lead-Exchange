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
 *   - status_type: new, working, converted, delivered, lost, invalid. converted and
 *     delivered set Enquiry Outcome = Retail Order instead of a status. The guide
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
// Converted and Delivered (a sale agreed / the car handed over) both set MG
// Enquiry Outcome = Retail Order and leave Enquiry Status alone (MG decision,
// 3 Nov 2026). Zoho takes the picklist's stored value, which for the label
// "Retail Order" is "Purchase" (see FUSION_OUTCOME_STATUS in crmIntegrationService).
const RETAIL_ORDER_OUTCOME = 'Purchase';
const SALE_STATUS_TYPES = new Set(['converted', 'delivered']);
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

// Dealer Studio's default status NAMES (New, Contacted, Converted, Delivered, Lost,
// Spam) onto their status types. Used only when the post carries no status_type,
// so a name such as "Contacted" or "Spam" still reaches the type-keyed mapping rows.
// A renamed or custom status is not guessed at: it stays as sent.
const DEFAULT_NAME_TO_TYPE = Object.freeze({ contacted: 'working', spam: 'invalid' });

// MG's agreed pick-list values (Dealer Studio Integration Requirements.xlsx, Field Mapping
// tab). MG's Enquiry Model / Variant are Zoho pick-lists, so a value outside the list makes
// Zoho reject the WHOLE write, a status change in the same post included. Only an exact
// (case-insensitive) match is applied, written in MG's own spelling. The workbook's
// Powertrain list is a copy of the model list (a known error), so powertrain is not applied.
const MG_MODELS = ['MG3', 'MG4', 'New MG4 EV', 'New MG4 XPOWER', 'MG4 EV Urban', 'MG5', 'MG7', 'MGS5 EV', 'MGS6 EV',
  'MG ZS', 'MG ZST', 'MG HS', 'MG HS +EV', 'MG QS', 'MGU9', 'MGU9 EV', 'MGU9 Black Edition', 'Cyberster', 'IM5', 'IM6'];
const MG_VARIANTS = ['Core', 'Core +Nav', 'Vibe', 'Vibe Turbo', 'Excite', 'Excite X', 'Essence', 'Essence X', 'Essence Anfield',
  'Long Range', 'Short Range', 'XPOWER', 'HYBRID+ sup', 'SUPER HYBRID', 'HYBRID+', 'Petrol', 'Electric', 'Diesel', 'Premium',
  'Platinum', 'Performance', 'Explore', 'Explore X', 'Explore Pro', 'Excite 49', 'Excite 62', 'Essence 49', 'Essence 62', 'Black Edition'];
const canonical = (list) => new Map(list.map((value) => [value.toLowerCase(), value]));
const MODEL_BY_LOWER = canonical(MG_MODELS);
const VARIANT_BY_LOWER = canonical(MG_VARIANTS);

// MG outcomes a completed test drive may not replace: the lead has moved on.
const OUTCOMES_OPEN_TO_TEST_DRIVE = new Set(['', '-none-', '(required)', 'outcome pending', 'no outcome', 'test drive']);

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

/**
 * Dealer edits that come back to MG (Dealer Studio permissions tab: first and last name,
 * email, mobile, postcode, marketing opt-in, model, variant). Read from the cluster:
 *   contact.first_name / last_name / email / mobile_phone (or mobile, phone) / postcode
 *     (the contact block as the guide documents it for v1; confirm against a v3 payload)
 *   leads[].opt_in            (Dealer Studio email, 3 Nov 2026)
 *   cars[0].model / badge     (Dealer Studio email, 3 Nov 2026)
 * Each is { source, value } keyed by MG's internal field. A missing value is never an edit
 * (nothing is cleared), and a model or variant outside MG's lists is skipped and reported.
 * Whether a value actually differs from MG's is decided later, against MG's own record.
 */
function parseFieldEdits(body) {
  const edits = [];
  const skipped = [];
  const contact = body.contact && typeof body.contact === 'object' && !Array.isArray(body.contact) ? body.contact : {};
  const first = text(contact.first_name, 100);
  const last = text(contact.last_name, 100);
  if (first || last) edits.push({ source: 'customer_name', value: [first, last].filter(Boolean).join(' ') });
  const email = text(contact.email, 254);
  if (email) edits.push({ source: 'email_address', value: email });
  const mobile = text(contact.mobile_phone, 40) ?? text(contact.mobile, 40) ?? text(contact.phone, 40);
  if (mobile) edits.push({ source: 'mobile_number', value: mobile });
  const postcode = text(contact.postcode, 20) ?? text(contact.address && contact.address.postcode, 20);
  if (postcode) edits.push({ source: 'postcode', value: postcode });

  const lead = objects(body.leads).find((item) => typeof item.opt_in === 'boolean');
  if (lead) edits.push({ source: 'receive_marketing_updates', value: lead.opt_in });

  const car = objects(body.cars)[0];
  if (car) {
    const model = text(car.model, 100);
    if (model) {
      const mg = MODEL_BY_LOWER.get(model.toLowerCase());
      if (mg) edits.push({ source: 'enquiry_model', value: mg }); else skipped.push('model');
    }
    const badge = text(car.badge, 100);
    if (badge) {
      const mg = VARIANT_BY_LOWER.get(badge.toLowerCase());
      if (mg) edits.push({ source: 'enquiry_variant', value: mg }); else skipped.push('variant');
    }
  }
  return { edits, skipped };
}

// Whole phone as digits in Australian national form, so +61 400 000 000 equals 0400000000.
function phoneDigits(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('61') ? `0${digits.slice(2)}` : digits;
}

const asBoolean = (value) => ['true', '1', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase());
const squash = (value) => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

const SAME_VALUE = Object.freeze({
  customer_name: (a, b) => squash(a) === squash(b),
  email_address: (a, b) => squash(a) === squash(b),
  mobile_number: (a, b) => phoneDigits(a) !== '' && phoneDigits(a) === phoneDigits(b),
  postcode: (a, b) => squash(a) === squash(b),
  receive_marketing_updates: (a, b) => asBoolean(a) === asBoolean(b),
  enquiry_model: (a, b) => squash(a) === squash(b),
  enquiry_variant: (a, b) => squash(a) === squash(b),
});

/**
 * Dealer Studio posts the whole cluster on every change, and writes names, phone numbers and
 * flags in its own formatting. A value that only differs in formatting (spacing, case, +61 vs
 * 0) is not an edit: leaving it in would write to MG on every post, or raise a false
 * ownership conflict on a phone number. Removes those from `update` in place.
 * @returns {number} how many were dropped
 */
function dropFormattingOnlyChanges(update, existingLead) {
  let dropped = 0;
  Object.keys(SAME_VALUE).forEach((field) => {
    if (update[field] !== undefined && existingLead && SAME_VALUE[field](update[field], existingLead[field])) {
      delete update[field];
      dropped += 1;
    }
  });
  return dropped;
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
  // The type decides; the default name only when the post has no type.
  const isSale = SALE_STATUS_TYPES.has(statusType ?? statusName?.toLowerCase() ?? '');
  const status = isSale ? null : statusType ?? (statusName ? (DEFAULT_NAME_TO_TYPE[statusName.toLowerCase()] ?? statusName) : null);

  const changedAt = text(body.updated_at) ?? text(body.modified);
  const appointments = parseAppointments(body.appointments);
  const testDrives = parseTestDrives(body.test_drives);
  const outcome = isSale
    ? RETAIL_ORDER_OUTCOME
    : (testDrives.some((drive) => drive.status?.toLowerCase() === 'completed') ? TEST_DRIVE_OUTCOME : null);

  const { edits: fieldEdits, skipped: skippedVehicle } = parseFieldEdits(body);

  const record = {};
  if (status !== null) record[statusTarget] = status;
  if (changedAt !== null && status !== null) record.modified_at = changedAt;
  if (outcome !== null) record[outcomeTarget] = outcome;

  // Each edit travels under the target of the dealer's own mapping row for that MG field. With
  // no such row (a name, which the default map splits into first and last) it gets a private
  // key and a synthetic row, as the outcome does, so the shared path maps it to the MG field.
  const syntheticMappings = [];
  fieldEdits.forEach(({ source, value }) => {
    const mapped = fieldMappings.find((m) => m.source_field === source)?.target_field;
    const target = mapped || `__ds_${source}`;
    if (!mapped) syntheticMappings.push({ source_field: source, target_field: target, data_type: 'string', required: false });
    record[target] = value;
  });

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
    fieldEdits,
    skippedVehicle,
    syntheticMappings,
    hasUpdate: status !== null || outcome !== null || fieldEdits.length > 0,
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
  dropFormattingOnlyChanges,
  isOurProvider,
  DEFAULT_STATUS_TARGET,
  DEFAULT_OUTCOME_TARGET,
  TEST_DRIVE_OUTCOME,
  RETAIL_ORDER_OUTCOME,
  LOST_REASONS,
};
