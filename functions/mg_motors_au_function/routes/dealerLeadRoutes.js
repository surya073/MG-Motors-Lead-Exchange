'use strict';

const express = require('express');
const {
  resolveDealerCodeForUser,
  getLeadsForDealer,
  summarizeLeadsByStatus,
  getOwnedLead,
} = require('../services/leadAccessService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const { updateOemLead } = require('../services/zohoCrmService'); 
const { notifyAdmins } = require('../services/notificationService');

const logger = require('../utils/logger');

const router = express.Router();

const ALLOWED_LEAD_STATUSES = ['New', 'Contacted', 'Test Drive', 'Quotation', 'Delivered', 'Lost'];

/**
 * Shared helper: resolves the logged-in user's dealer_code, or responds
 * with 403 if they're not mapped to any dealer. Every route in this file
 * calls this first — this is the single enforcement point for
 * "Dealer can only access his own leads."
 */
async function requireDealerCode(req, res) {
  const catalystApp = res.locals.catalystApp;
  const currentUser = res.locals.currentUser;

  if (!currentUser) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return null;
  }

  const dealerCode = await resolveDealerCodeForUser(catalystApp, currentUser.user_id);

  if (!dealerCode) {
    res.status(403).json({ success: false, error: 'This account is not linked to a dealership.' });
    return null;
  }

  return dealerCode;
}

/**
 * GET /dealer/leads
 * -----------------------------------------------------------------------
 * Step 4/5: returns only the logged-in dealer's own leads. Path uses a
 * /dealer/leads prefix (not /leads/my) specifically to avoid colliding
 * with the legacy admin route app.get('/leads/:rowId', ...) already
 * registered in index.js — Express matches routes in registration order,
 * and "/leads/my" would otherwise be swallowed by "/leads/:rowId" with
 * "my" treated as a ROWID.
 */
router.get('/dealer/leads', async (req, res) => {
  try {
    const dealerCode = await requireDealerCode(req, res);
    if (!dealerCode) return;

    const leads = await getLeadsForDealer(res.locals.catalystApp, dealerCode);
    res.status(200).json({ success: true, dealerCode, leads });
  } catch (err) {
    logger.error('dealerLeadRoutes', 'GET /dealer/leads failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * GET /dealer/leads/summary
 * -----------------------------------------------------------------------
 * Step 4: dashboard counts (Total, New, Contacted, Test Drive,
 * Quotation, Delivered, Lost) for the logged-in dealer only.
 */
router.get('/dealer/leads/summary', async (req, res) => {
    console.log('[DEBUG] dealerLeadRoutes: /dealer/leads/summary handler REACHED');

  try {
    const dealerCode = await requireDealerCode(req, res);
    if (!dealerCode) return;

    const leads = await getLeadsForDealer(res.locals.catalystApp, dealerCode);
    const summary = summarizeLeadsByStatus(leads);
    res.status(200).json({ success: true, dealerCode, summary });
  } catch (err) {
    logger.error('dealerLeadRoutes', 'GET /dealer/leads/summary failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /dealer/leads/:rowId
 * -----------------------------------------------------------------------
 * Step 5: dealer updates lead_status, dealer_remarks, next follow-up
 * date on their own lead. Ownership is verified server-side via
 * getOwnedLead() — a dealer cannot update a lead belonging to another
 * dealer_code, even by guessing/brute-forcing a ROWID.
 */
router.patch('/dealer/leads/:rowId', async (req, res) => {
  try {
    const dealerCode = await requireDealerCode(req, res);
    if (!dealerCode) return;

    const catalystApp = res.locals.catalystApp;
    const { lead_status, dealer_remarks, next_followup_date } = req.body;

    if (lead_status && !ALLOWED_LEAD_STATUSES.includes(lead_status)) {
      return res.status(400).json({
        success: false,
        error: `lead_status must be one of: ${ALLOWED_LEAD_STATUSES.join(', ')}`,
      });
    }

    const existingLead = await getOwnedLead(catalystApp, req.params.rowId, dealerCode);
    if (!existingLead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    const table = catalystApp.datastore().table('leads');
    const updatePayload = { ROWID: req.params.rowId };

    if (lead_status !== undefined) {
      updatePayload.lead_status = lead_status;
      updatePayload.last_status_update = toCatalystDateTime();
    }
    if (dealer_remarks !== undefined) {
      updatePayload.dealer_remarks = dealer_remarks;
    }
    if (next_followup_date !== undefined) {
      updatePayload.next_followup_date = next_followup_date;
    }

    const updatedLead = await table.updateRow(updatePayload);

    if (lead_status !== undefined) {
      notifyAdmins(catalystApp, {
        type: 'LEAD_STATUS_UPDATED',
        title: `${dealerCode} updated a lead`,
        message: `${existingLead.customer_name || 'A lead'} was marked as ${lead_status}.`,
        relatedLeadId: req.params.rowId,
        relatedDealerCode: dealerCode,
      }); // fire-and-forget — do not await/block the response on this
    }

    // CRM write-back — best-effort, never blocks the local update. Only
    // lead_status and dealer_remarks are pushed; next_followup_date has
    // no corresponding CRM field.
    let crmSync = 'skipped';
    if (existingLead.crm_record_id && (lead_status !== undefined || dealer_remarks !== undefined)) {
      const crmFields = {};
      if (lead_status !== undefined) crmFields.Lead_Status = lead_status;
      if (dealer_remarks !== undefined) crmFields.Dealer_Remarks = dealer_remarks;

      try {
        await updateOemLead(existingLead.crm_record_id, crmFields);
        crmSync = 'success';
      } catch (err) {
        logger.error('dealerLeadRoutes', `CRM write-back failed for ROWID=${req.params.rowId}`, err);
        crmSync = 'failed';
      }
    }

    res.status(200).json({ success: true, lead: updatedLead, crmSync });
  } catch (err) {
    logger.error('dealerLeadRoutes', 'PATCH /dealer/leads/:rowId failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;