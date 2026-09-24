'use strict';

/**
 * Lead Exchange policy shared by ingest, outbound delivery, inbound
 * reconciliation, schedulers and UI-facing classifications.
 *
 * The demo scope is the 15 concrete Pilot paths: Happy 1-5 and
 * Unhappy 1-10. Keeping their identifiers and rules in one place stops
 * each transport from inventing a different meaning for the same event.
 */

const SCENARIOS = Object.freeze({
  'Happy 1': { type: 'happy', message: 'New enquiry routed successfully', priority: '' },
  'Happy 2': { type: 'happy', message: 'Dealer progresses enquiry (status sync)', priority: '' },
  'Happy 3': { type: 'happy', message: 'Duplicate detected', priority: '' },
  'Happy 4': { type: 'happy', message: 'Integration recovery (replay)', priority: '' },
  'Happy 5': { type: 'happy', message: 'Data synchronisation (dealer → OEM)', priority: '' },
  'Unhappy 1': { type: 'unhappy', message: 'API / integration failure', priority: 'P2' },
  'Unhappy 2': { type: 'unhappy', message: 'Invalid / missing data', priority: 'P2' },
  'Unhappy 3': { type: 'unhappy', message: 'Dealer unavailable (after 24 hr retry)', priority: 'P1' },
  'Unhappy 4': { type: 'unhappy', message: 'Status update failure (dealer → OEM)', priority: 'P2' },
  'Unhappy 5': { type: 'unhappy', message: 'Wrong / rejected dealer mapping', priority: 'P2' },
  'Unhappy 6': { type: 'unhappy', message: 'Ownership conflict', priority: 'P3' },
  'Unhappy 7': { type: 'unhappy', message: 'Out-of-order events', priority: 'P3' },
  'Unhappy 8': { type: 'unhappy', message: 'Consent / privacy mismatch', priority: 'P1' },
  'Unhappy 9': { type: 'unhappy', message: 'Dealer rejects enquiry', priority: 'P2' },
  'Unhappy 10': { type: 'unhappy', message: 'SLA breach', priority: 'P2' },
  // Present in the supplied workbook but outside the requested 15-path
  // Pilot demo. Retained so partial acknowledgements and future offboarding
  // cannot be mislabeled as generic transport errors.
  'Unhappy 11': { type: 'unhappy', message: 'Partial transaction', priority: 'P2' },
  'Unhappy 12': { type: 'unhappy', message: 'Dealer CRM migration / offboarding', priority: 'P2' },
});

const REJECTION_STATUSES = new Set([
  'spam',
  'junk',
  'junk lead',
  'junk lead / spam',
]);

// Negative commercial outcomes are deliberately included. The register is
// explicit that a correctly synchronised Lost / Dropped / Not Qualified lead
// is Happy 2, not an integration failure.
const PROGRESS_STATUSES = new Set([
  // Verified against the LIVE picklists of both orgs rather than assumed:
  //   MG OEM  Lead_Status (16 values) — GET /settings/fields?module=Leads
  //   Dealer  Lead_Status (15 values) — same call on the dealer org
  // The dealer's values are compound ('Received / Acknowledged',
  // 'Nurture / Future', 'Lost (final)'), so listing only the bare words
  // left 6 of its 14 real statuses unclassified. Both the full compound
  // value and its parts are matched — see statusComponents().
  'received',
  'acknowledged',
  'received / acknowledged',
  'not contacted',
  'follow up 1',
  'follow up 1 / in progress',
  'in progress',
  'follow up 2',
  'contacted',
  'attempted to contact',
  'contact in future',
  'nurture',
  'future',
  'nurture / future',
  'pre qualified',
  'qualified',
  'not qualified',
  'dropped',
  'lost',
  'lost (final)',
  'lost lead',
  'converted',
  'won',
  'delivered',
]);

const DUPLICATE_WINDOW_MINUTES = (() => {
  const configured = Number(process.env.DUPLICATE_WINDOW_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? configured : 15;
})();

const DUPLICATE_FIELDS = Object.freeze([
  'dealer_code',
  'customer_name',
  'mobile_number',
  'email_address',
  'postcode',
  'vehicle_model',
  'enquiry_variant',
  'nature_of_enquiry',
  'lead_source',
  'accept_privacy_policy',
]);

const REQUIRED_DELIVERY_MAPPING_FIELDS = Object.freeze([
  'enquiry_id',
  'customer_name',
  'mobile_number',
  'email_address',
  'postcode',
  'vehicle_model',
  'nature_of_enquiry',
  'lead_source',
  'dealer_code',
  'accept_privacy_policy',
  'lead_status',
]);

// Verified from MG's live Leads.Lead_Status metadata on 2026-09-23.
// At the final dealer -> MG boundary, holding a newly-added value until
// review is safer than losing the event to Zoho's INVALID_DATA response.
const MG_LEAD_STATUS_VALUES = Object.freeze([
  '-None-',
  'Update Pending',
  'Not Contacted',
  'Follow-up 1',
  'Follow-up 2',
  'Contacted',
  'Contact in Future',
  'Not Qualified',
  'Dropped',
  'Lost',
  'Dealer Unavailable',
  'Unattended Alert',
  'Attempted to Contact',
  'Junk Lead',
  'Lost Lead',
  'Pre-Qualified',
]);

// These are MG/middleware workflow states, not dealer lifecycle values.
// Update Pending exists only before delivery; the other two are generated
// by the Unhappy 3 and Unhappy 10 schedulers.
const OEM_ONLY_STATUSES = new Set([
  'update pending',
  'dealer unavailable',
  'unattended alert',
]);

const WAITING_DEALER_ACTION_STATUSES = new Set([
  'update pending',
  'not contacted',
  'received',
  'acknowledged',
  'received / acknowledged',
]);

const IDENTITY_FIELDS = new Set(['crm_record_id', 'enquiry_id', 'dealer_code']);
const PRIVACY_FIELDS = new Set(['accept_privacy_policy']);

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeStatus(value) {
  return normalizeText(value)
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeEmail(value) {
  return normalizeText(value);
}

function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('61') && digits.length === 11) digits = `0${digits.slice(2)}`;
  return digits;
}

function normalizePostcode(value) {
  const raw = String(value ?? '').trim();
  return /^\d{1,4}$/.test(raw) ? raw.padStart(4, '0') : raw;
}

function resolveBoolean(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined || normalizeText(value) === '') return null;
  const normalized = normalizeText(value);
  if (['true', 'yes', 'y', '1', 'accepted', 'accept'].includes(normalized)) return true;
  if (['false', 'no', 'n', '0', 'declined', 'reject', 'rejected'].includes(normalized)) return false;
  return undefined;
}

function scenario(code, overrides = {}) {
  const configured = SCENARIOS[code];
  if (!configured) throw new Error(`Unknown Lead Exchange scenario: ${code}`);
  return { code, ...configured, ...overrides };
}

function isOemOnlyStatus(value) {
  return OEM_ONLY_STATUSES.has(normalizeStatus(value));
}

function getMgLeadStatusSet() {
  return new Set(MG_LEAD_STATUS_VALUES.map(normalizeStatus));
}

/**
 * Every form of a status worth testing against the known sets: the whole
 * normalised value, each '/'-separated part, and each with any
 * parenthetical qualifier stripped.
 *
 *   'Lost (final)'            -> {'lost (final)', 'lost'}
 *   'Received / Acknowledged' -> {'received / acknowledged', 'received', 'acknowledged'}
 *
 * Dealer CRMs label the same lifecycle stage in their own words, so
 * matching only the exact string means every new dealer silently
 * produces unclassified statuses until someone notices.
 */
function statusComponents(value) {
  const stripParens = (v) => v.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const normalized = normalizeStatus(value);
  const parts = new Set();

  const add = (v) => {
    const trimmed = String(v || '').trim();
    if (trimmed) parts.add(trimmed);
  };

  add(normalized);
  add(stripParens(normalized));
  normalized.split('/').forEach((piece) => {
    add(piece.trim());
    add(stripParens(piece));
  });

  return parts;
}

function classifyDealerStatus(value) {
  const components = statusComponents(value);

  // Rejection is tested FIRST and against every component, so a compound
  // like 'Junk Lead / Spam' is never mistaken for a progress status.
  for (const part of components) {
    if (REJECTION_STATUSES.has(part)) return scenario('Unhappy 9');
  }
  for (const part of components) {
    if (PROGRESS_STATUSES.has(part)) return scenario('Happy 2');
  }
  return null;
}

function isWaitingForDealerActionStatus(value) {
  for (const component of statusComponents(value)) {
    if (WAITING_DEALER_ACTION_STATUSES.has(component)) return true;
  }
  return false;
}

function isValidEmail(value) {
  const email = normalizeEmail(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidAustralianMobile(value) {
  const mobile = normalizePhone(value);
  return /^04\d{8}$/.test(mobile) && !/^0+$/.test(mobile);
}

function isValidAustralianPostcode(value) {
  const postcode = normalizePostcode(value);
  const numeric = Number(postcode);
  return /^\d{4}$/.test(postcode) && numeric >= 200 && numeric <= 9999;
}

function validationIssue(field, rule, value) {
  return { field, rule, value };
}

/**
 * Validates the fields required before any dealer API call. Privacy and
 * routing are returned separately because the register assigns those to
 * Unhappy 8 and Unhappy 5 rather than the generic Unhappy 2 bucket.
 */
function validateLeadForDelivery(lead) {
  const issues = [];

  if (!normalizeText(lead.crm_record_id || lead.enquiry_id)) {
    issues.push(validationIssue('enquiry_id', 'A stable Inquiry ID is required', lead.enquiry_id));
  }
  const nameParts = String(lead.customer_name || '').trim().split(/\s+/).filter(Boolean);
  if (nameParts.length < 2) {
    issues.push(validationIssue('customer_name', 'Customer first and last name are required', lead.customer_name));
  }
  if (!isValidAustralianMobile(lead.mobile_number)) {
    issues.push(validationIssue('mobile_number', 'Must be a valid 10-digit Australian mobile number', lead.mobile_number));
  }
  if (!isValidEmail(lead.email_address)) {
    issues.push(validationIssue('email_address', 'Must be a valid email address', lead.email_address));
  }
  if (!isValidAustralianPostcode(lead.postcode)) {
    issues.push(validationIssue('postcode', 'Must be a valid four-digit Australian postcode', lead.postcode));
  }
  if (!normalizeText(lead.vehicle_model || lead.enquiry_model || lead.enquiry_variant)) {
    issues.push(validationIssue('vehicle_model', 'An enquiry model or variant is required', lead.vehicle_model));
  }
  if (!normalizeText(lead.nature_of_enquiry)) {
    issues.push(validationIssue('nature_of_enquiry', 'Nature of enquiry is required', lead.nature_of_enquiry));
  }
  if (!normalizeText(lead.lead_source)) {
    issues.push(validationIssue('lead_source', 'Inquiry source is required', lead.lead_source));
  }
  if (!normalizeText(lead.lead_status)) {
    issues.push(validationIssue('lead_status', 'Lead status is required', lead.lead_status));
  }

  const consent = resolveBoolean(lead.accept_privacy_policy);
  const privacyIssue = consent === true
    ? null
    : validationIssue(
        'accept_privacy_policy',
        consent === false ? 'Privacy consent was not accepted' : 'Privacy consent is missing or cannot be translated safely',
        lead.accept_privacy_policy
      );

  const routingIssue = normalizeText(lead.dealer_code)
    ? null
    : validationIssue('dealer_code', 'No dealer was assigned by the MG PMA/postcode routing', lead.dealer_code);

  return { valid: issues.length === 0 && !privacyIssue && !routingIssue, issues, privacyIssue, routingIssue };
}

function normalizeDuplicateValue(field, value) {
  if (field === 'mobile_number') return normalizePhone(value);
  if (field === 'email_address') return normalizeEmail(value);
  if (field === 'postcode') return normalizePostcode(value);
  if (field === 'accept_privacy_policy') return String(resolveBoolean(value));
  return normalizeText(value);
}

function duplicateFingerprint(lead) {
  return DUPLICATE_FIELDS
    .map((field) => `${field}:${normalizeDuplicateValue(field, lead[field])}`)
    .join('|');
}

function parseTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function leadTimestamp(lead) {
  return parseTimestamp(lead.assigned_date || lead.CREATEDTIME || lead.created_at);
}

function isBusinessDuplicate(currentLead, candidateLead, windowMinutes = DUPLICATE_WINDOW_MINUTES) {
  if (!currentLead || !candidateLead) return false;
  if (String(currentLead.crm_record_id || '') === String(candidateLead.crm_record_id || '')) return false;
  if (duplicateFingerprint(currentLead) !== duplicateFingerprint(candidateLead)) return false;

  const currentAt = leadTimestamp(currentLead);
  const candidateAt = leadTimestamp(candidateLead);
  if (!currentAt || !candidateAt) return false;

  const gapMs = currentAt.getTime() - candidateAt.getTime();
  return gapMs >= 0 && gapMs <= windowMinutes * 60 * 1000;
}

function parseFieldList(value) {
  return String(value || '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
}

// Contact fields MG keeps authoritative: a dealer edit to these is held as
// an ownership conflict (Unhappy 6) and MG's value is kept. Every other
// mapped field the dealer changes is synchronised to MG (Happy 5).
// Overridable per environment via DEALER_PROTECTED_FIELDS.
const DEFAULT_DEALER_PROTECTED_FIELDS = Object.freeze(['email_address', 'mobile_number']);

function getDealerProtectedFields() {
  const configured = parseFieldList(process.env.DEALER_PROTECTED_FIELDS);
  return new Set(configured.length > 0 ? configured : DEFAULT_DEALER_PROTECTED_FIELDS);
}

// Legacy allow-list mode: when DEALER_WRITABLE_FIELDS is set explicitly,
// ONLY those fields are dealer-writable, exactly as before.
function getDealerWritableFields() {
  const configured = parseFieldList(process.env.DEALER_WRITABLE_FIELDS);
  return configured.length > 0 ? new Set(configured) : null;
}

/**
 * Per-field source-of-truth rule for dealer -> MG updates (MG decision):
 *   - Protected contact fields (default: email, mobile) stay MG-owned; a
 *     dealer change to them is held as an ownership conflict (Unhappy 6).
 *   - Every other genuine change is applied to MG (Happy 5).
 *   - Identity (record / enquiry / dealer assignment) and privacy consent
 *     are never taken from the dealer; consent has its own path (Unhappy 8).
 *     They, and a dealer clearing a field MG holds a value for (register
 *     Happy 5 edge case d — never blank an MG value), are left unchanged
 *     without raising a conflict.
 * Returns { allowed, conflicts, ignored }.
 */
function partitionInboundByOwnership(internalUpdate, existingLead) {
  const allowed = {};
  const conflicts = [];
  const ignored = [];
  const writableAllowList = getDealerWritableFields();
  const protectedFields = getDealerProtectedFields();

  Object.entries(internalUpdate || {}).forEach(([field, value]) => {
    const oldValue = existingLead?.[field] ?? '';
    if (String(oldValue) === String(value ?? '')) return;

    if (IDENTITY_FIELDS.has(field) || PRIVACY_FIELDS.has(field)) {
      ignored.push({ field, reason: 'MG_OWNED' });
      return;
    }
    const blocked = writableAllowList ? !writableAllowList.has(field) : protectedFields.has(field);
    if (blocked) {
      conflicts.push({ field, mgValue: oldValue, dealerValue: value });
      return;
    }
    if (String(value ?? '').trim() === '' && String(oldValue).trim() !== '') {
      ignored.push({ field, reason: 'BLANK_WOULD_ERASE_MG_VALUE' });
      return;
    }
    allowed[field] = value;
  });

  return { allowed, conflicts, ignored };
}

function maskSensitiveValue(field, value) {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (field === 'email_address') {
    const [local, domain] = raw.split('@');
    if (!domain) return '***';
    return `${(local || '').slice(0, 1)}***@${domain}`;
  }
  if (field === 'mobile_number') {
    const digits = normalizePhone(raw);
    return digits.length >= 3 ? `*******${digits.slice(-3)}` : '***';
  }
  if (field === 'customer_name') return `${raw.slice(0, 1)}***`;
  return raw.length > 80 ? `${raw.slice(0, 77)}...` : raw;
}

module.exports = {
  SCENARIOS,
  REJECTION_STATUSES,
  PROGRESS_STATUSES,
  DUPLICATE_FIELDS,
  REQUIRED_DELIVERY_MAPPING_FIELDS,
  MG_LEAD_STATUS_VALUES,
  DUPLICATE_WINDOW_MINUTES,
  normalizeText,
  normalizeStatus,
  normalizeEmail,
  normalizePhone,
  normalizePostcode,
  resolveBoolean,
  scenario,
  isOemOnlyStatus,
  getMgLeadStatusSet,
  statusComponents,
  classifyDealerStatus,
  isWaitingForDealerActionStatus,
  validateLeadForDelivery,
  duplicateFingerprint,
  isBusinessDuplicate,
  parseTimestamp,
  partitionInboundByOwnership,
  maskSensitiveValue,
};
