'use strict';

/**
 * dealerStatusService.js
 * -----------------------------------------------------------------------
 * The last status a dealer CRM reported for a lead, as the dealer worded it
 * (Fusion: Open, Won, Delivered, Lost, Prospect Lost). Fusion cannot be read
 * back (no GET on its lead API), so what MG knows is what its webhooks said.
 * It is kept on the lead's own inbound audit rows (integration_logs.field_changes,
 * the entries `lead_status`, `enquiry_outcome` and `dealer_status` carry the dealer's
 * wording as raw_dealer_value), so no new column or table is needed.
 *
 * Used by the lead detail page ("Fusion current status") and by the outbound path, so
 * an update never sends Won to a lead the dealer has already marked Delivered.
 */

const INTEGRATION_LOGS_TABLE = 'integration_logs';
const STATUS_FIELDS = new Set(['lead_status', 'enquiry_outcome', 'dealer_status']);
const LOOKBACK_ROWS = 15;

function idText(value) {
  return String(value ?? '').replace(/[^0-9A-Za-z_-]/g, '');
}

/** Newest dealer status among inbound rows (newest first). Pure. */
function latestFromRows(rows) {
  for (const wrapped of rows || []) {
    const row = wrapped?.[INTEGRATION_LOGS_TABLE] || wrapped || {};
    let changes;
    try {
      changes = JSON.parse(row.field_changes || '[]');
    } catch (_) {
      continue;
    }
    if (!Array.isArray(changes)) continue;
    // Within one row the last status entry is the final word.
    for (let i = changes.length - 1; i >= 0; i -= 1) {
      const change = changes[i];
      const raw = typeof change?.raw_dealer_value === 'string' ? change.raw_dealer_value.trim() : '';
      if (raw && STATUS_FIELDS.has(change.field)) {
        return { status: raw, at: change.received_at || row.CREATEDTIME || null };
      }
    }
  }
  return null;
}

/** The dealer's latest reported status for a lead, or null when none was recorded. */
async function readLatestDealerStatus(catalystApp, zohoLeadId) {
  const id = idText(zohoLeadId);
  if (!id) return null;
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT field_changes, CREATEDTIME FROM ${INTEGRATION_LOGS_TABLE} WHERE zoho_lead_id = '${id}' ` +
    `AND direction = 'EXTERNAL_CRM_TO_ZOHO' AND status = 'SUCCESS' ORDER BY CREATEDTIME DESC LIMIT 1, ${LOOKBACK_ROWS}`
  );
  return latestFromRows(rows);
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

module.exports = { readLatestDealerStatus, latestFromRows, same };
