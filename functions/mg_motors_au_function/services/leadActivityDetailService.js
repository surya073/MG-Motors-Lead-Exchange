'use strict';

const zohoCrmService = require('./zohoCrmService');
const crmIntegrationService = require('./integrations/crmIntegrationService');
const logger = require('../utils/logger');

/**
 * Leads Exchange Activity for the lead detail page: Connected CRM, Test Drive Date and
 * Closed Date (MG Zoho's Connected_CRM, Test_Drive_Date and Sold_Date). The Enquiry Outcome
 * is already on the lead row. These three live in MG's Zoho only, so the one lead is read
 * from there when its detail page opens (one API call). If that read fails the page still
 * opens: the dates are left blank and Connected CRM falls back to the dealer's CRM type.
 *
 * @returns {Promise<{connected_crm: string, test_drive_date: string, closed_date: string}>}
 */
async function getLeadActivityDetails(catalystApp, lead) {
  const out = { connected_crm: '', test_drive_date: '', closed_date: '' };
  if (!lead?.crm_record_id) return out;

  try {
    const [record] = await zohoCrmService.fetchOemLeadsByIds([lead.crm_record_id]);
    if (record) {
      out.connected_crm = String(record.Connected_CRM || '').trim();
      out.test_drive_date = String(record.Test_Drive_Date || '').trim();
      out.closed_date = String(record.Sold_Date || '').trim();
    }
  } catch (err) {
    logger.error('leadActivityDetailService', `Could not read activity fields for lead ${lead.crm_record_id}`, err);
  }

  if (!out.connected_crm && lead.dealer_code) {
    try {
      const integration = await crmIntegrationService.getIntegrationByDealerCode(catalystApp, lead.dealer_code);
      out.connected_crm = integration ? crmIntegrationService.connectedCrmLabel(integration) : '';
    } catch (err) {
      logger.error('leadActivityDetailService', `Could not read the integration of dealer ${lead.dealer_code}`, err);
    }
  }
  return out;
}

module.exports = { getLeadActivityDetails };
