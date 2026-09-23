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
const crmIntegrationService = require('../services/integrations/crmIntegrationService');
const pathPolicy = require('../services/integrations/pathPolicyService');

const logger = require('../utils/logger');

const router = express.Router();

// Exact live MG Lead_Status values that a dealer may legitimately set. MG
// workflow-only values (Update Pending, Dealer Unavailable, Unattended Alert)
// and the empty picklist value are intentionally excluded.
const ALLOWED_LEAD_STATUSES = pathPolicy.MG_LEAD_STATUS_VALUES.filter((status) =>
  status !== '-None-' && !pathPolicy.isOemOnlyStatus(status)
);

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
 * Step 5: dealer updates lead_status and the portal-only next follow-up
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

    if (lead_status !== undefined && !ALLOWED_LEAD_STATUSES.includes(lead_status)) {
      return res.status(400).json({
        success: false,
        error: `lead_status must be one of: ${ALLOWED_LEAD_STATUSES.join(', ')}`,
      });
    }

    const existingLead = await getOwnedLead(catalystApp, req.params.rowId, dealerCode);
    if (!existingLead) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }

    if (lead_status === undefined && dealer_remarks === undefined && next_followup_date === undefined) {
      return res.status(400).json({ success: false, error: 'NO_SUPPORTED_CHANGES' });
    }

    // Live MG metadata confirms there is no Dealer_Remarks field. Do not
    // claim a successful two-system update by writing it locally and then
    // sending an invalid API name to Zoho. An unchanged/blank value from the
    // current form is tolerated; a real edit is held until MG approves a
    // destination (the proposed Description field is not yet authorised).
    const remarksChanged = dealer_remarks !== undefined &&
      String(dealer_remarks ?? '') !== String(existingLead.dealer_remarks ?? '');
    if (remarksChanged) {
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode: 'Unhappy 6',
        dealerCode,
        leadRow: existingLead,
        direction: 'EXTERNAL_CRM_TO_ZOHO',
        operation: 'UPDATE_LEAD',
        errorCode: 'DEALER_REMARKS_MAPPING_NOT_APPROVED',
        reason: 'Dealer remarks were held because MG CRM has no approved destination field.',
        notify: false,
      });
      return res.status(409).json({
        success: false,
        error: 'DEALER_REMARKS_MAPPING_NOT_APPROVED',
        message: 'Remarks were not saved because MG CRM has no approved destination field.',
      });
    }

    // Write the authoritative MG record first. The previous local-first,
    // best-effort flow returned success even when Zoho rejected the update,
    // leaving Catalyst and MG visibly out of sync.
    let crmSync = 'skipped';
    if (lead_status !== undefined) {
      if (!existingLead.crm_record_id) {
        return res.status(409).json({ success: false, error: 'CRM_RECORD_ID_MISSING' });
      }
      try {
        await updateOemLead(existingLead.crm_record_id, { Lead_Status: lead_status });
        crmSync = 'success';
      } catch (err) {
        logger.error('dealerLeadRoutes', `CRM write-back failed for ROWID=${req.params.rowId}`, err);
        await crmIntegrationService.recordScenario(catalystApp, {
          scenarioCode: 'Unhappy 4',
          dealerCode,
          leadRow: existingLead,
          direction: 'EXTERNAL_CRM_TO_ZOHO',
          operation: 'UPDATE_LEAD',
          errorCode: 'ZOHO_UPDATE_FAILED',
          reason: err.message,
          notify: true,
        });
        return res.status(502).json({ success: false, error: 'ZOHO_UPDATE_FAILED' });
      }
    }

    const table = catalystApp.datastore().table('leads');
    const updatePayload = { ROWID: req.params.rowId };

    if (lead_status !== undefined) {
      updatePayload.lead_status = lead_status;
      updatePayload.last_status_update = toCatalystDateTime();
    }
    if (next_followup_date !== undefined) {
      updatePayload.next_followup_date = next_followup_date;
    }

    const updatedLead = await table.updateRow(updatePayload);

    if (lead_status !== undefined) {
      try {
        await notifyAdmins(catalystApp, {
          type: 'LEAD_STATUS_UPDATED',
          title: `${dealerCode} updated a lead`,
          message: `${existingLead.customer_name || 'A lead'} was marked as ${lead_status}.`,
          relatedLeadId: req.params.rowId,
          relatedDealerCode: dealerCode,
        });
      } catch (notifyErr) {
        logger.error('dealerLeadRoutes', `Status notification failed for ROWID=${req.params.rowId}`, notifyErr);
      }

      const rawScenario = pathPolicy.classifyDealerStatus(lead_status);
      const scenarioCode = rawScenario?.code || 'Happy 2';
      await crmIntegrationService.recordScenario(catalystApp, {
        scenarioCode,
        dealerCode,
        leadRow: existingLead,
        direction: 'EXTERNAL_CRM_TO_ZOHO',
        operation: 'UPDATE_LEAD',
        notify: scenarioCode === 'Unhappy 9',
        reason: scenarioCode === 'Unhappy 9'
          ? `Dealer classified the enquiry as "${lead_status}".`
          : undefined,
        fieldChanges: [{ field: 'lead_status', from: existingLead.lead_status, to: lead_status }],
      });
    }

    res.status(200).json({ success: true, lead: updatedLead, crmSync });
  } catch (err) {
    logger.error('dealerLeadRoutes', 'PATCH /dealer/leads/:rowId failed', err);
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;
