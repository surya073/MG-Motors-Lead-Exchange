'use strict';

const express = require('express');
const { fetchDealerMaster } = require('../services/zohoCrmService');
const { inviteDealerUser, getDealerCodeForUser } = require('../services/dealerInviteService');
const { requireAdminRole } = require('../middleware/requireAdminRole');

const logger = require('../utils/logger');

const router = express.Router();


/**
 * POST /dealers/invite
 * -----------------------------------------------------------------------
 * Super Admin triggers this after selecting a dealer from the CRM
 * dealer list (GET /crm/dealers). Body: { crmRecordId: string }.
 */
router.post('/dealers/invite', requireAdminRole, async (req, res) => {
  try {
    const { crmRecordId } = req.body;
    if (!crmRecordId) {
      return res.status(400).json({ success: false, error: 'crmRecordId is required' });
    }

    const catalystApp = res.locals.catalystApp;

    const crmDealers = await fetchDealerMaster();
    const crmRecord = crmDealers.find((d) => d.id === crmRecordId);

    if (!crmRecord) {
      return res.status(404).json({ success: false, error: 'Dealer not found in CRM' });
    }

    const result = await inviteDealerUser(catalystApp, crmRecord);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    logger.error('dealerInviteRoutes', 'POST /dealers/invite failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * GET /dealer-context/:userId
 * -----------------------------------------------------------------------
 * Called by the frontend's authService.getDealerContext() right after
 * login, to resolve which dealer_code the logged-in Dealer user maps to.
 * Intentionally NOT behind requireAdminRole — a just-logged-in Dealer
 * user is resolving their own context, not performing an admin action.
 */
router.get('/dealer-context/:userId', async (req, res) => {
  try {
    const catalystApp = res.locals.catalystApp;
    const dealerCode = await getDealerCodeForUser(catalystApp, req.params.userId);
    res.status(200).json({ success: true, dealer_code: dealerCode });
  } catch (err) {
    logger.error('dealerInviteRoutes', 'GET /dealer-context failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;