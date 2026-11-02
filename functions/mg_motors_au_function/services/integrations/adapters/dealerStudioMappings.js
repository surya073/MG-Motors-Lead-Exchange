'use strict';

/**
 * dealerStudioMappings.js
 * -----------------------------------------------------------------------
 * The confirmed default field and status mapping for Dealer Studio
 * (Dealer Studio API mapping update, 2 Nov 2026), in the stored shape of
 * integration_field_mappings rows. It is the reference the Field Mapping
 * workbook is generated from and the tests assert against. The admin UI's
 * "Load Dealer Studio default map" button (DealerCRMConfig.jsx
 * DEALER_STUDIO_DEFAULT_FIELD_MAPPINGS) mirrors it by hand, as the Fusion
 * presets do: the two deployables share no code.
 *
 * Targets with a dot ("address_attributes.postcode") become nested objects when
 * the request is built (dealerStudioAdapter via nestDottedKeys).
 * Fixed values (`provider`, `source`) and the department -> `category` rule live in
 * dealerStudioPayload.js, not here: they are not configurable per dealer.
 */

// [MG source field, Dealer Studio target, data_type, required, note]
const FIELD_PRESET_ROWS = [
  ['first_name', 'first_name', 'string', false, 'First Name'],
  ['last_name', 'last_name', 'string', false, 'Last Name'],
  ['email_address', 'email', 'string', true, 'Email'],
  ['mobile_number', 'mobile', 'string', true, 'Mobile'],
  ['customer_message', 'message', 'string', false, 'Customer Message (max 2000 characters)'],
  ['nature_of_enquiry', 'category', 'string', true, 'Nature of Enquiry; sent as the category value chosen with Lead Department'],
  ['postcode', 'address_attributes.postcode', 'string', true, 'Postcode'],
  ['receive_marketing_updates', 'opt_in', 'boolean', false, 'Marketing Opt-in'],
  ['accept_privacy_policy', 'fields.privacy_policy_accepted', 'boolean', true, 'Privacy Policy Accepted'],
  ['lead_department', 'fields.lead_department', 'string', true, 'Lead Department, kept as sent'],
  ['vehicle_make', 'fields.make', 'string', false, 'Make (no MG source field yet; left out until MG supplies one)'],
  ['enquiry_model', 'fields.model', 'string', false, 'Model'],
  ['enquiry_variant', 'fields.vehicle_badge', 'string', false, 'Variant, sent as the badge'],
  ['enquiry_powertrain', 'fields.powertrain', 'string', false, 'Powertrain (a custom field)'],
  ['chat_url', 'fields.chat_url', 'string', false, 'Chat URL (no MG source field yet; left out until MG supplies one)'],
  ['chat_transcript', 'chat_transcript', 'array', false, 'Chat Transcript, as [{ message, type: bot|user }]'],
  ['enquiry_id', 'provider_id', 'string', true, 'MG Enquiry ID, the id Dealer Studio reconciles on'],
  // Dealer Studio needs one dealership identifier on every create and update.
  ['dealer_code', 'dealer_code', 'string', true, 'Dealership identifier'],
  // Inbound only: the webhook's status type is read through this row. The
  // status is never sent (Dealer Studio owns it).
  ['lead_status', 'status', 'string', true, 'Enquiry Status; dealer-managed, comes back through the webhook only'],
];

const FIELD_PRESET = FIELD_PRESET_ROWS.map(([source_field, target_field, data_type, required, note]) => ({
  source_field, target_field, data_type, required, note,
}));

// Webhook status_type -> MG Lead_Status (inbound only; MG never sends a status).
// Not decided yet, so deliberately absent: converted and delivered. Until MG
// decides, those two arrive as an unmapped status and are held for review.
const INBOUND_STATUS_PRESET = Object.freeze([
  { dealer_status: 'new', mg_status: 'Not Contacted' },
  { dealer_status: 'working', mg_status: 'Contacted' },
  { dealer_status: 'lost', mg_status: 'Lost Lead' },
  { dealer_status: 'invalid', mg_status: 'Not Qualified' },
]);

module.exports = { FIELD_PRESET, INBOUND_STATUS_PRESET };
