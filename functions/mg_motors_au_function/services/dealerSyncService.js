'use strict';

const { fetchDealerMaster } = require('./zohoCrmService');
const { recordSyncRun } = require('./syncLogService');
const { toCatalystDateTime } = require('../utils/dateFormat');
const logger = require('../utils/logger');
const dashboardStats = require('./dashboardStatsService');

const DEALERS_TABLE = 'dealers';
const DEALER_ROW_BOUND = 50000;

function mapCrmRecordToDealerRow(crmRecord) {
  return {
    // Dealer_Code is a Number field on the MG OEM Dealers module; the
    // dealers table (and every lookup keyed on it) holds it as text.
    dealer_code: String(crmRecord.Dealer_Code ?? ''),
    dealer_name: crmRecord.Name || '',
    phone_number: crmRecord.Phone_Number || '',
    email_address: crmRecord.Email || '',
    region: crmRecord.Dealer_Region || '',
    state: crmRecord.Dealer_State || '',
    city: crmRecord.City_Suburb || '',
    status: crmRecord.Dealer_Stage || '',
    crm_record_id: crmRecord.id || '',
  };
}

async function loadExistingDealersByCode(catalystApp) {
  // Every dealer row, read in ordered pages. A bare `SELECT * FROM dealers`
  // silently stops at 300 rows, so beyond 300 dealers the rest looked "new"
  // (insert fails on the unique dealer_code) and could never be marked Removed.
  const rows = await dashboardStats.selectEveryRow(catalystApp, DEALERS_TABLE, '', 'ORDER BY ROWID ASC', DEALER_ROW_BOUND);
  const map = new Map();
  rows.forEach((dealer) => map.set(dealer.dealer_code, dealer));
  return map;
}

function hasChanges(existingRow, mappedRow) {
  return Object.keys(mappedRow).some((key) => {
    const existingValue = existingRow[key] ?? '';
    const newValue = mappedRow[key] ?? '';
    return String(existingValue) !== String(newValue);
  });
}

async function syncDealers(catalystApp, { trigger = 'Manual', triggeredBy = 'System' } = {}) {
  const startTime = toCatalystDateTime();
  const table = catalystApp.datastore().table(DEALERS_TABLE);

  let crmRecords;
  try {
    crmRecords = await fetchDealerMaster();
  } catch (err) {
    const endTime = toCatalystDateTime();
    await recordSyncRun(catalystApp, {
      syncType: 'Dealer_Sync', syncTrigger: trigger, triggeredBy, startTime, endTime,
      totalRecordsFetched: 0, recordsInserted: 0, recordsUpdated: 0, recordsFailed: 0,
      status: 'Failed', errorDetails: [{ error: `CRM fetch failed: ${err.message}` }],
    });
    throw err;
  }

  const existingDealersByCode = await loadExistingDealersByCode(catalystApp);

  let inserted = 0;
  let updated = 0;
  let failed = 0;
  let removed = 0;
  const errors = [];

  // Track which existing dealer_codes are still present in CRM's
  // response — anything left over after this loop is no longer in CRM
  // and should be soft-deleted.
  const seenDealerCodes = new Set();

  for (const crmRecord of crmRecords) {
    try {
      if (!crmRecord.Dealer_Code) {
        throw new Error('CRM record missing Dealer_Code — skipped');
      }

      const dealerCode = String(crmRecord.Dealer_Code);
      seenDealerCodes.add(dealerCode);

      const mappedRow = mapCrmRecordToDealerRow(crmRecord);
      const now = toCatalystDateTime();
      const existingRow = existingDealersByCode.get(dealerCode);

      if (!existingRow) {
        await table.insertRow({ ...mappedRow, last_synced_at: now, sync_status: 'Synced' });
        inserted += 1;
      } else if (existingRow.sync_status === 'Removed' || hasChanges(existingRow, mappedRow)) {
        // Also un-removes a dealer that reappeared in CRM after
        // previously being soft-deleted — sync_status flips back to
        // 'Synced' in either branch here.
        await table.updateRow({ ROWID: existingRow.ROWID, ...mappedRow, last_synced_at: now, sync_status: 'Synced' });
        updated += 1;
      }
    } catch (err) {
      failed += 1;
      errors.push({ dealer_code: crmRecord.Dealer_Code || 'UNKNOWN', error: err.message });
      logger.error('dealerSyncService', `Failed syncing dealer_code=${crmRecord.Dealer_Code}`, err);
    }
  }

  // Soft-delete pass: any dealer_code in our table that CRM no longer
  // returned, and that isn't already marked Removed, gets marked now.
  // Row is kept (not deleted) — history/foreign-key safety (leads still
  // reference this dealer_code) and protects against a transient CRM
  // fetch issue wiping data based on an incomplete response.
  for (const [dealerCode, existingRow] of existingDealersByCode) {
    if (!seenDealerCodes.has(dealerCode) && existingRow.sync_status !== 'Removed') {
      try {
        await table.updateRow({
          ROWID: existingRow.ROWID,
          sync_status: 'Removed',
          last_synced_at: toCatalystDateTime(),
        });
        removed += 1;
      } catch (err) {
        logger.error('dealerSyncService', `Failed soft-deleting dealer_code=${dealerCode}`, err);
      }
    }
  }

  const endTime = toCatalystDateTime();
  const status = failed === 0 ? 'Success' : (inserted + updated > 0 ? 'Partial' : 'Failed');

  await recordSyncRun(catalystApp, {
    syncType: 'Dealer_Sync', syncTrigger: trigger, triggeredBy, startTime, endTime,
    totalRecordsFetched: crmRecords.length, recordsInserted: inserted, recordsUpdated: updated,
    recordsFailed: failed, status, errorDetails: errors.length > 0 ? errors : null,
  });

  return { status, totalRecordsFetched: crmRecords.length, recordsInserted: inserted, recordsUpdated: updated, recordsFailed: failed, recordsRemoved: removed, errors };
}

module.exports = { syncDealers, _test: { mapCrmRecordToDealerRow, hasChanges } };