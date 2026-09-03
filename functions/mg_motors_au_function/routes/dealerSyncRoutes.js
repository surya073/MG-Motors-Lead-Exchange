'use strict';

const express = require('express');
const { fetchDealerMaster } = require('../services/zohoCrmService');
const { syncDealers } = require('../services/dealerSyncService');
const { syncLeads } = require('../services/leadSyncService');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Transforms raw Zoho CRM Dealer_Master records into the app's clean
 * response shape. Kept as a pure function, separate from the route
 * handler, so dealerSyncService.js reuses the exact same mapping when
 * writing into the Catalyst Datastore `dealers` table.
 */
function mapCrmDealerToResponse(crmRecord) {
  return {
    crm_id: crmRecord.id,
    dealer_code: crmRecord.Dealer_Code,
    dealer_name: crmRecord.Dealer_Name,
    phone: crmRecord.Phone_Number || '',
    email: crmRecord.Email_Address || '',
    region: crmRecord.Region || '',
  };
}

/**
 * GET /crm/dealers
 * -----------------------------------------------------------------------
 * Fetch-only: pulls Dealer_Master from Zoho CRM, maps to the app's clean
 * shape, and returns it. No Catalyst Datastore writes here.
 */
router.get('/crm/dealers', async (req, res) => {
  try {
    const crmRecords = await fetchDealerMaster();

    if (!Array.isArray(crmRecords)) {
      logger.error('dealerSyncRoutes', 'Unexpected CRM response shape', crmRecords);
      return res.status(502).json({
        success: false,
        error: 'Zoho CRM returned an unexpected response shape.',
      });
    }

    const dealers = crmRecords.map(mapCrmDealerToResponse);

    res.status(200).json({
      success: true,
      count: dealers.length,
      dealers,
    });
  } catch (err) {
    logger.error('dealerSyncRoutes', 'GET /crm/dealers failed', err);

    const isConfigError = err.message?.startsWith('Missing required environment variable');
    const statusCode = isConfigError ? 500 : 502;

    res.status(statusCode).json({
      success: false,
      error: isConfigError
        ? 'Server configuration error. Contact an administrator.'
        : err.message,
    });
  }
});

/**
 * POST /sync/dealers
 * -----------------------------------------------------------------------
 * Manual Dealer Sync trigger — writes CRM dealer data into the Catalyst
 * `dealers` table (insert new, update changed, skip unchanged), and logs
 * the run to sync_logs.
 */
router.post('/sync/dealers', async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const currentUser = res.locals.currentUser;

    const result = await syncDealers(catalystApp, {
      trigger: 'Manual',
      triggeredBy: currentUser?.email_id || 'Unknown',
    });

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('dealerSyncRoutes', 'POST /sync/dealers failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * POST /sync/leads
 * -----------------------------------------------------------------------
 * Manual Lead Sync trigger — writes CRM OEM_Leads data into the Catalyst
 * `leads` table (insert new, update changed, skip unchanged), keyed on
 * crm_record_id, and logs the run to sync_logs.
 */
router.post('/sync/leads', async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const currentUser = res.locals.currentUser; // FIXED

    const result = await syncLeads(catalystApp, {
      trigger: 'Manual',
      triggeredBy: currentUser?.email_id || 'Unknown',
    });

    res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('dealerSyncRoutes', 'POST /sync/leads failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});



module.exports = router;