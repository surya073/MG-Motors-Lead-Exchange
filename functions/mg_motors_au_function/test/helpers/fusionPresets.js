'use strict';

/**
 * The stored form of the Fusion presets an admin saves with "Load Fusion
 * default map" (DealerCRMConfig.jsx FUSION_DEFAULT_FIELD_MAPPINGS and
 * FUSION_DEFAULT_STATUS_MAPPINGS, Batch 4), for integration ROWID 1000.
 * Two-way status rows are stored as one row per direction.
 */

const FIELD_PRESET = [
  ['enquiry_id', 'refID', 'string', true],
  ['first_name', 'contact.firstName', 'string', false],
  ['last_name', 'contact.lastName', 'string', false],
  ['mobile_number', 'contact.phone', 'string', true],
  ['email_address', 'contact.email', 'string', true],
  ['postcode', 'contact.areaCode', 'string', true],
  ['vehicle_model', 'requirement.model', 'string', true],
  ['enquiry_channel', 'enquiryType', 'string', true],
  ['lead_origin', 'origin', 'string', true],
  ['nature_of_enquiry', 'leadSource', 'string', true],
  ['accept_privacy_policy', 'privacy', 'boolean', true],
  ['lead_status', 'enquiryStatus', 'string', true],
  ['receive_marketing_updates', 'contact.marketingOptinEmail', 'boolean', false],
  ['dealer_rejected_reason', 'lostReason', 'string', false],
].map(([source_field, target_field, data_type, required]) => ({ integration_id: '1000', source_field, target_field, data_type, required }));

const OPEN = ['Not Contacted', 'Follow-up 1', 'Follow-up 2', 'Attempted to Contact', 'Contacted', 'Contact in Future', 'Pre-Qualified'];
const PROSPECT_LOST = ['Not Qualified', 'Dropped', 'Lost', 'Junk Lead', 'Lost Lead'];
const STATUS_PRESET = [
  ...OPEN.map((mg) => ({ source_status: mg, target_status: 'Open', direction: 'ZOHO_TO_EXTERNAL' })),
  ...PROSPECT_LOST.map((mg) => ({ source_status: mg, target_status: 'Prospect Lost', direction: 'ZOHO_TO_EXTERNAL' })),
  { source_status: 'Open', target_status: 'Not Contacted', direction: 'EXTERNAL_TO_ZOHO' },
  { source_status: 'Prospect Lost', target_status: 'Not Qualified', direction: 'EXTERNAL_TO_ZOHO' },
  { source_status: 'Lost', target_status: 'Lost', direction: 'EXTERNAL_TO_ZOHO' },
].map((row) => ({ integration_id: '1000', ...row }));

module.exports = { FIELD_PRESET, STATUS_PRESET, OPEN, PROSPECT_LOST };
