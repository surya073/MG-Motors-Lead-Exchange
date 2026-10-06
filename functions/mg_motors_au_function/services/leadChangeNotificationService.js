'use strict';

const { maskSensitiveValue } = require('./integrations/pathPolicyService');

/**
 * leadChangeNotificationService.js
 * -----------------------------------------------------------------------
 * Turns "a dealer changed this lead" into the in-app notification admins
 * see in the bell: WHICH dealer, WHICH lead, and WHAT changed (status plus
 * any other field), e.g.
 *
 *   title:   MG Sydney (AU008) moved Rahul Sharma to Contacted
 *   message: Status: New → Contacted
 *            Next follow-up: — → 2026-10-12
 *
 * The notifications table has fixed columns (type / title / message /
 * related ids), so the detail lives in `message` as one change per line in
 * the form "Label: from → to". The web app parses exactly that shape into
 * change chips; anything it cannot parse still reads fine as plain text.
 *
 * Pure functions only — no datastore access — so this is trivially testable.
 * Sensitive values (mobile, email, customer name) go through the same
 * masking the activity log uses.
 */

const FIELD_LABELS = {
  lead_status: 'Status',
  next_followup_date: 'Next follow-up',
  dealer_remarks: 'Remarks',
  customer_name: 'Customer',
  mobile_number: 'Mobile',
  email_address: 'Email',
  vehicle_model: 'Vehicle',
  lead_source: 'Lead source',
  preferred_dealer: 'Preferred dealer',
  test_drive_date: 'Test drive date',
  postcode: 'Postcode',
};

// Bookkeeping fields that change on every sync and mean nothing to a person.
const IGNORED_FIELDS = new Set([
  'ROWID',
  'last_status_update',
  'sync_status',
  'assigned_date',
  'crm_record_id',
  'dealer_crm_record_id',
  'dealer_code',
  'dealer_name',
  'happy_unhappy_path_name',
  'happy_unhappy_path_message',
  'happy_unhappy_path_priority',
]);

const MAX_CHANGE_LINES = 5;
const MAX_MESSAGE_LENGTH = 480;
const EMPTY = '—';

function humanizeField(field) {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const words = String(field).replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function displayValue(field, value) {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return EMPTY;
  return maskSensitiveValue(field, raw) || EMPTY;
}

/**
 * @param {object} params
 * @param {string} [params.dealerCode]
 * @param {object} [params.leadRow]       leads-table row (customer_name, dealer_name ...)
 * @param {{field: string, from: any, to: any}[]} params.fieldChanges
 * @returns {{type: string, title: string, message: string} | null}  null when nothing worth telling anyone
 */
function buildLeadChangeNotification({ dealerCode, leadRow, fieldChanges }) {
  const changes = (Array.isArray(fieldChanges) ? fieldChanges : [])
    .filter((c) => c && c.field && !IGNORED_FIELDS.has(c.field))
    .filter((c) => String(c.from ?? '') !== String(c.to ?? ''));

  if (changes.length === 0) return null;

  const dealerName = leadRow?.dealer_name && String(leadRow.dealer_name).trim();
  const dealerLabel = dealerName
    ? (dealerCode && dealerName !== dealerCode ? `${dealerName} (${dealerCode})` : dealerName)
    : (dealerCode || 'A dealer');
  const customer = (leadRow?.customer_name && String(leadRow.customer_name).trim()) || 'a lead';

  // Status first, then the rest in the order they arrived.
  const ordered = [
    ...changes.filter((c) => c.field === 'lead_status'),
    ...changes.filter((c) => c.field !== 'lead_status'),
  ];

  const statusChange = ordered.find((c) => c.field === 'lead_status');
  const title = statusChange
    ? `${dealerLabel} moved ${customer} to ${displayValue('lead_status', statusChange.to)}`
    : `${dealerLabel} updated ${customer}`;

  const shown = ordered.slice(0, MAX_CHANGE_LINES);
  const lines = shown.map(
    (c) => `${humanizeField(c.field)}: ${displayValue(c.field, c.from)} → ${displayValue(c.field, c.to)}`
  );
  if (ordered.length > shown.length) {
    lines.push(`+${ordered.length - shown.length} more field${ordered.length - shown.length === 1 ? '' : 's'}`);
  }

  return {
    type: statusChange ? 'LEAD_STATUS_UPDATED' : 'LEAD_FIELDS_UPDATED',
    title: title.slice(0, 200),
    message: lines.join('\n').slice(0, MAX_MESSAGE_LENGTH),
  };
}

module.exports = { buildLeadChangeNotification, humanizeField };
