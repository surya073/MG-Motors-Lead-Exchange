'use strict';

const leadMappingService = require('../leadMappingService');

/**
 * dealerStudioPayload.js
 * -----------------------------------------------------------------------
 * Outbound shaping for Dealer Studio (crm_type = DEALER_STUDIO), applied by
 * crmIntegrationService.buildOutboundPayload after the generic field mapping.
 * Field NAMES stay in the dealer's field mappings (see
 * dealerStudioMappings.js for the confirmed default set); this module owns
 * only what a mapping cannot express:
 *   - the department -> `category` rule (Dealer Studio has no department field),
 *   - the fixed `provider` / `source` values,
 *   - boolean consent values, chat transcript formatting,
 *   - keys that must never be sent (`lead_state`, `subsource`).
 * The result is still flat; dealerStudioAdapter nests dotted keys
 * ("address_attributes.postcode", "fields.make") when it builds the request.
 *
 * Confirmed Dealer Studio specification (Dealer Studio API mapping update,
 * 2 Nov 2026). Nothing here is guessed: an unresolvable category is an error,
 * not a default.
 */

const PROVIDER_NAME = 'MG Leads Exchange';
const SOURCE_NAME = 'Manufacturer';

// Dealer Studio category values are case-sensitive and must match exactly.
const CATEGORY = Object.freeze({
  TEST_DRIVE: 'Test Drive Booking',
  NEW_VEHICLE: 'New Vehicle Enquiry',
  FINANCE: 'Finance Enquiry',
  SERVICE: 'Service Enquiry',
  PARTS: 'Parts Enquiry',
  GENERAL: 'General Enquiry',
});

// Sales leads are categorised by MG's Nature of Enquiry.
const SALES_CATEGORY_BY_NATURE = Object.freeze({
  'test drive': CATEGORY.TEST_DRIVE,
  'product enquiry': CATEGORY.NEW_VEHICLE,
  'finance enquiry': CATEGORY.FINANCE,
});

// Every other department decides the category by itself.
const CATEGORY_BY_DEPARTMENT = Object.freeze({
  service: CATEGORY.SERVICE,
  parts: CATEGORY.PARTS,
  'customer care': CATEGORY.GENERAL,
  marketing: CATEGORY.GENERAL,
  aftersales: CATEGORY.GENERAL,
  general: CATEGORY.GENERAL,
});

const KEYS_NEVER_SENT = Object.freeze(['lead_state', 'subsource']);

// Targets that carry a yes/no value whatever the mapping row's data_type says.
const BOOLEAN_TARGETS = Object.freeze(['opt_in', 'fields.privacy_policy_accepted']);

function norm(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function fail(message) {
  const err = new Error(message);
  err.code = 'FIELD_MAPPING_INVALID';
  return err;
}

/**
 * Dealer Studio `category` from MG's Lead Department and Nature of Enquiry.
 * Sales + Test Drive / Product Enquiry / Finance Enquiry, or one of the other
 * departments. Anything else throws FIELD_MAPPING_INVALID (the lead is held for
 * correction) rather than sending a value Dealer Studio would answer with 422.
 */
function resolveCategory(department, natureOfEnquiry) {
  const dept = norm(department);
  if (!dept) throw fail('Dealer Studio category cannot be set: Lead Department is missing');
  if (dept === 'sales') {
    const category = SALES_CATEGORY_BY_NATURE[norm(natureOfEnquiry)];
    if (!category) {
      throw fail(`Dealer Studio category cannot be set: Sales needs a Nature of Enquiry of Test Drive, Product Enquiry or Finance Enquiry (got "${String(natureOfEnquiry ?? '').slice(0, 60)}")`);
    }
    return category;
  }
  const category = CATEGORY_BY_DEPARTMENT[dept];
  if (!category) throw fail(`Dealer Studio category cannot be set: unknown Lead Department "${String(department).slice(0, 60)}"`);
  return category;
}

// ------------------------------------------------------------ chat transcript

const BOT_SPEAKERS = new Set(['bot', 'chatbot', 'assistant', 'ai', 'mg bot', 'mg assistant']);
const USER_SPEAKERS = new Set(['user', 'customer', 'visitor', 'guest', 'client']);
const MAX_TRANSCRIPT_ENTRIES = 200;
const MAX_TRANSCRIPT_BYTES = 20000; // well inside the adapter's 32000-byte body limit
const SPEAKER_LINE = /^\s*([A-Za-z][A-Za-z ]{0,19}?)\s*:\s*(.*)$/;

function speakerType(label) {
  const name = norm(label);
  if (BOT_SPEAKERS.has(name)) return 'bot';
  if (USER_SPEAKERS.has(name)) return 'user';
  return null;
}

function fromEntries(list) {
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const message = [item.message, item.text, item.content].find((v) => typeof v === 'string' && v.trim());
    const type = speakerType(item.type ?? item.role ?? item.sender);
    return message && type ? [{ message: message.trim(), type }] : [];
  });
}

function fromText(text) {
  const entries = [];
  text.split(/\r?\n/).forEach((line) => {
    const match = SPEAKER_LINE.exec(line);
    const type = match ? speakerType(match[1]) : null;
    if (type) {
      entries.push({ message: match[2].trim(), type });
    } else if (entries.length > 0 && line.trim()) {
      entries[entries.length - 1].message += `\n${line.trim()}`; // a wrapped message
    }
  });
  return entries.filter((entry) => entry.message);
}

/**
 * MG stores the transcript as one string (Zoho Chat_Trascript). Dealer Studio
 * wants an array of { message, type: "bot" | "user" }. Reads an array, a JSON
 * array string, or "Bot: ..." / "Customer: ..." lines. Text with no recognised
 * speaker is NOT guessed at: it yields [] and the field is left out. A very long
 * chat keeps its most recent entries so the lead is never refused for size.
 */
function formatChatTranscript(raw) {
  let entries = [];
  if (Array.isArray(raw)) {
    entries = fromEntries(raw);
  } else if (typeof raw === 'string' && raw.trim()) {
    const text = raw.trim();
    let parsed = null;
    if (text.startsWith('[')) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    entries = Array.isArray(parsed) ? fromEntries(parsed) : fromText(text);
  }
  entries = entries.slice(-MAX_TRANSCRIPT_ENTRIES);
  while (entries.length > 1 && Buffer.byteLength(JSON.stringify(entries)) > MAX_TRANSCRIPT_BYTES) entries.shift();
  return entries;
}

// ------------------------------------------------------------------- the rules

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * @param {object} payload - flat output of mapZohoLeadToExternal
 * @param {object} leadRow - the MG lead (internal field names)
 * @param {object[]} fieldMappings - the dealer's integration_field_mappings rows
 * @returns {object} a new flat payload; the input is not modified
 */
function applyDealerStudioPayloadRules(payload, leadRow, fieldMappings = []) {
  const out = { ...payload };
  const targetOf = (sourceField) => fieldMappings.find((m) => m.source_field === sourceField)?.target_field;

  // Never sent: Dealer Studio owns the enquiry status (it comes back through
  // the webhook) and MG has no confirmed subsource yet.
  KEYS_NEVER_SENT.forEach((key) => { delete out[key]; });

  // Category replaces the raw Nature of Enquiry; the original department is
  // kept separately in fields.lead_department by its own mapping.
  const natureTarget = targetOf('nature_of_enquiry');
  if (natureTarget && natureTarget !== 'category') delete out[natureTarget];
  out.category = resolveCategory(leadRow?.lead_department, leadRow?.nature_of_enquiry);

  // Fixed values: this exchange is the provider, MG is a manufacturer source.
  out.provider = PROVIDER_NAME;
  out.source = SOURCE_NAME;

  // The MG enquiry id is the provider id Dealer Studio reconciles on.
  const enquiryTarget = targetOf('enquiry_id');
  if (enquiryTarget && enquiryTarget !== 'provider_id') delete out[enquiryTarget];
  const providerId = out.provider_id ?? (enquiryTarget ? payload[enquiryTarget] : undefined) ?? leadRow?.enquiry_id ?? leadRow?.crm_record_id;
  if (!isBlank(providerId)) out.provider_id = String(providerId).trim();
  else delete out.provider_id;

  // Consent: a real boolean, or left out when unreadable (never guessed as false).
  const booleanTargets = new Set([
    ...BOOLEAN_TARGETS,
    ...fieldMappings.filter((m) => m.data_type === 'boolean').map((m) => m.target_field),
  ]);
  booleanTargets.forEach((target) => {
    if (!Object.hasOwn(out, target)) return;
    const value = leadMappingService.parseTriState(out[target]);
    if (value === undefined) delete out[target];
    else out[target] = value;
  });

  // Chat transcript: array of { message, type }, or nothing.
  const transcriptTarget = targetOf('chat_transcript');
  const rawTranscript = leadRow?.chat_transcript ?? (transcriptTarget ? payload[transcriptTarget] : undefined);
  if (transcriptTarget && transcriptTarget !== 'chat_transcript') delete out[transcriptTarget];
  const transcript = formatChatTranscript(rawTranscript);
  if (transcript.length > 0) out.chat_transcript = transcript;
  else delete out.chat_transcript;

  // Optional fields that are empty are left out, never sent as '' (a blank
  // make or model would create an empty vehicle of interest).
  Object.keys(out).forEach((key) => {
    if (isBlank(out[key])) delete out[key];
  });
  return out;
}

module.exports = {
  PROVIDER_NAME,
  SOURCE_NAME,
  CATEGORY,
  resolveCategory,
  formatChatTranscript,
  applyDealerStudioPayloadRules,
};
