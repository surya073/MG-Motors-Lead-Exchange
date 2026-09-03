'use strict';

const logger = require('../utils/logger');

const SYNC_LOGS_TABLE = 'sync_logs';

/**
 * syncLogService.js
 * -----------------------------------------------------------------------
 * Writes one row per sync run into sync_logs. Deliberately generic
 * (sync_type is a field, not a table-per-type) so Lead Sync reuses this
 * same service later without duplicating logging logic.
 */

async function recordSyncRun(catalystApp, {
  syncType,
  syncTrigger,
  triggeredBy,
  startTime,
  endTime,
  totalRecordsFetched,
  recordsInserted,
  recordsUpdated,
  recordsFailed,
  status,
  errorDetails,
}) {
  const table = catalystApp.datastore().table(SYNC_LOGS_TABLE);

  try {
    await table.insertRow({
      sync_type: syncType,
      sync_trigger: syncTrigger,
      triggered_by: triggeredBy,
      start_time: startTime,
      end_time: endTime,
      total_records_fetched: totalRecordsFetched,
      records_inserted: recordsInserted,
      records_updated: recordsUpdated,
      records_failed: recordsFailed,
      status,
      error_details: errorDetails ? JSON.stringify(errorDetails) : '',
    });
  } catch (err) {
    // A logging failure should never crash the sync itself — the sync
    // result has already been determined by this point; we just
    // couldn't persist the audit trail. Log to console as a fallback.
    logger.error('syncLogService', 'Failed to write sync_logs row', err);
  }
}

module.exports = { recordSyncRun };