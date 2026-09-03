'use strict';

const LEADS_TABLE = 'leads';
const MAPPING_TABLE = 'dealer_user_mapping';

/**
 * leadAccessService.js
 * -----------------------------------------------------------------------
 * Enforces "never expose one dealer's leads to another dealer" at the
 * server layer. dealer_code is ALWAYS resolved server-side from the
 * logged-in user's session via dealer_user_mapping — never accepted
 * from the client, which would let a dealer simply pass a different
 * dealer_code and see someone else's data.
 */

async function resolveDealerCodeForUser(catalystApp, catalystUserId) {
  const safeId = String(catalystUserId).replace(/'/g, "''");
  const query = `SELECT * FROM ${MAPPING_TABLE} WHERE catalyst_user_id = '${safeId}' LIMIT 1`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  if (!result || result.length === 0) return null;
  return result[0][MAPPING_TABLE].dealer_code || null;
}

/**
 * Returns all Catalyst user_ids mapped to the given dealer_code — a
 * dealership can have more than one login (e.g. sales manager + staff),
 * so this returns an array, not a single id. Used by leadSyncService to
 * notify every user linked to a dealer when that dealer gets a new lead.
 */
async function resolveUsersForDealerCode(catalystApp, dealerCode) {
  const safeCode = String(dealerCode).replace(/'/g, "''");
  const query = `SELECT * FROM ${MAPPING_TABLE} WHERE dealer_code = '${safeCode}'`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  return result.map((row) => row[MAPPING_TABLE].catalyst_user_id).filter(Boolean);
}

/**
 * Returns all leads belonging to the given dealer_code.
 */
async function getLeadsForDealer(catalystApp, dealerCode) {
  const safeCode = String(dealerCode).replace(/'/g, "''");
  const query = `SELECT * FROM ${LEADS_TABLE} WHERE dealer_code = '${safeCode}'`;
  const result = await catalystApp.zcql().executeZCQLQuery(query);
  return result.map((row) => row[LEADS_TABLE]);
}

/**
 * Groups leads by lead_status into the counts the Dealer Dashboard
 * needs (Step 4): Total, New, Contacted, Test Drive, Quotation,
 * Delivered, Lost.
 */
function summarizeLeadsByStatus(leads) {
  const summary = {
    total: leads.length,
    new: 0,
    contacted: 0,
    test_drive: 0,
    quotation: 0,
    delivered: 0,
    lost: 0,
  };

  const statusKeyMap = {
    'New': 'new',
    'Contacted': 'contacted',
    'Test Drive': 'test_drive',
    'Quotation': 'quotation',
    'Delivered': 'delivered',
    'Lost': 'lost',
  };

  leads.forEach((lead) => {
    const key = statusKeyMap[lead.lead_status];
    if (key) summary[key] += 1;
  });

  return summary;
}

/**
 * Fetches a single lead by ROWID, but only returns it if it belongs to
 * the given dealer_code — otherwise returns null, which the route
 * translates to a 403/404 rather than leaking whether the lead exists
 * at all for another dealer.
 */
async function getOwnedLead(catalystApp, rowId, dealerCode) {
  const table = catalystApp.datastore().table(LEADS_TABLE);
  const row = await table.getRow(rowId);
  if (!row || row.dealer_code !== dealerCode) {
    return null;
  }
  return row;
}

module.exports = {
  resolveDealerCodeForUser,
  resolveUsersForDealerCode,
  getLeadsForDealer,
  summarizeLeadsByStatus,
  getOwnedLead,
};