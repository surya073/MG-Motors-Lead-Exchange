'use strict';

const logger = require('../utils/logger');

const SYNC_LOGS_TABLE = 'sync_logs';

/**
 * syncLogService.js
 * -----------------------------------------------------------------------
 * Writes one row per sync run into sync_logs. Deliberately generic
 * (sync_type is a field, not a table-per-type) so Lead Sync reuses this
 * same service later without duplicating logging logic.
 *
 * SCENARIO SUMMARY (happy_unhappy_path_name / _message)
 * -----------------------------------------------------------------------
 * Unlike integration_logs (one row = one lead-level event = exactly one
 * scenario), a sync_logs row is a whole BATCH run that can contain
 * several distinct outcomes at once — e.g. 1 new lead (Happy 1), 2 rows
 * with a missing Dealer_Code (Unhappy 2), and 24 unchanged/already-synced
 * rows (Happy 3), all in a single run. The frontend's resolveRowScenarios()
 * in SyncLogsPage.jsx already models this as a multi-scenario breakdown
 * per row, so these two columns store an ENCODED SUMMARY of every
 * scenario present in the run — "Happy 1 x1, Unhappy 2 x2, Happy 3 x24" —
 * rather than a single value, so no information the frontend currently
 * derives gets lost by storing it here.
 *
 * Encoding: comma-separated "Happy N xCOUNT" / "Unhappy N xCOUNT"
 * segments in happy_unhappy_path_name, in the same order, with the
 * matching human-readable labels semicolon-joined in
 * happy_unhappy_path_message. Parse with the same split rather than
 * re-deriving from records_* counts, once callers are ready to trust it.
 *
 * WHAT THIS CAN AND CAN'T CLASSIFY PRECISELY
 * - recordsInserted / recordsUpdated / the "fetched but otherwise
 *   unaccounted for" remainder (duplicates) are exact — these come
 *   straight from the counts the caller already computed.
 * - recordsFailed is only exact for the two literal error messages
 *   leadSyncService.js's loop actually throws today ('CRM record
 *   missing id — skipped' / 'CRM record missing Dealer_Code —
 *   skipped', both Unhappy 2 — invalid/missing data). Any other
 *   failure message (a thrown network/datastore error, etc.) is
 *   classified as Unhappy 1 (API/integration failure) by default,
 *   since that's what the client's own matrix calls anything
 *   recoverable/unclassified on this path. If a caller later throws
 *   new, distinct error messages that deserve their own bucket, add
 *   them to KNOWN_FAILURE_MESSAGES below rather than relying on
 *   keyword-guessing — this intentionally does NOT do fuzzy keyword
 *   matching the way the frontend's classifyErrorText() does, to avoid
 *   false positives (e.g. a dealer name that happens to contain the
 *   word "invalid").
 */

// Exact (not substring) matches against known thrown messages in
// leadSyncService.js's per-record try/catch. Add new literal messages
// here as new callers/throw-sites are introduced.
const KNOWN_FAILURE_MESSAGES = {
  'CRM record missing id — skipped': { code: 'unhappy-2', label: 'Invalid / missing data' },
  'CRM record missing Dealer_Code — skipped': { code: 'unhappy-2', label: 'Invalid / missing data' },
};

const SCENARIO_LABELS = {
  'happy-1': 'New enquiry routed successfully',
  'happy-2': 'Dealer progresses enquiry (status sync)',
  'happy-3': 'Duplicate detected',
  'happy-4': 'Integration recovery (replay)',
  'happy-5': 'Data synchronisation (dealer → OEM)',
  'unhappy-1': 'API / integration failure',
  'unhappy-2': 'Invalid / missing data',
};

function scenarioDisplayName(code) {
  const [path, number] = code.split('-');
  return `${path === 'happy' ? 'Happy' : 'Unhappy'} ${number}`;
}

function classifyFailureMessage(message) {
  const known = KNOWN_FAILURE_MESSAGES[String(message || '').trim()];
  return known ? known.code : 'unhappy-1';
}

/**
 * Builds the ordered {code -> count} scenario breakdown for a run, using
 * only the aggregate counts and error list the caller already has —
 * mirrors resolveRowScenarios() in SyncLogsPage.jsx so the stored
 * summary and the frontend's own derivation agree.
 */
function buildScenarioBreakdown({
  syncType,
  syncTrigger,
  totalRecordsFetched,
  recordsInserted,
  recordsUpdated,
  recordsFailed,
  errorDetails,
}) {
  const fetched = Number(totalRecordsFetched) || 0;
  const inserted = Number(recordsInserted) || 0;
  const updated = Number(recordsUpdated) || 0;
  const failed = Number(recordsFailed) || 0;
  const errors = Array.isArray(errorDetails) ? errorDetails : [];

  const counts = new Map(); // code -> count, insertion order preserved
  const add = (code, count) => {
    if (!code || count <= 0) return;
    counts.set(code, (counts.get(code) || 0) + count);
  };

  // Failures first, classified per known error message. Any failed
  // count not explained by an individual error entry (shouldn't
  // normally happen, but defends against a caller passing a raw
  // recordsFailed number without matching errorDetails entries) is
  // bucketed as Unhappy 1 rather than silently dropped.
  errors.forEach((entry) => add(classifyFailureMessage(entry?.error), 1));
  const unexplainedFailed = failed - errors.length;
  if (unexplainedFailed > 0) add('unhappy-1', unexplainedFailed);

  if (inserted > 0) {
    const trigger = String(syncTrigger || '').toLowerCase();
    add(trigger.includes('schedul') || trigger.includes('retry') ? 'happy-4' : 'happy-1', inserted);
  }

  if (updated > 0) {
    add(syncType === 'Dealer_Sync' ? 'happy-5' : 'happy-2', updated);
  }

  // Fetched but neither inserted, updated, nor failed — left
  // untouched because it already matched an existing record
  // unchanged. Per the client's own matrix this is the dedupe path
  // (Happy 3), not a no-op to leave unclassified.
  const accounted = inserted + updated + errors.length + Math.max(unexplainedFailed, 0);
  const skipped = Math.max(fetched - accounted, 0);
  if (skipped > 0) add('happy-3', skipped);

  return counts;
}

function encodeScenarioSummary(counts) {
  if (counts.size === 0) return { name: '', message: '' };
  const names = [];
  const messages = [];
  for (const [code, count] of counts) {
    names.push(`${scenarioDisplayName(code)} x${count}`);
    messages.push(`${SCENARIO_LABELS[code] || code} x${count}`);
  }
  return { name: names.join(', '), message: messages.join('; ') };
}

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

  const scenarioCounts = buildScenarioBreakdown({
    syncType,
    syncTrigger,
    totalRecordsFetched,
    recordsInserted,
    recordsUpdated,
    recordsFailed,
    errorDetails,
  });
  const { name: happyUnhappyPathName, message: happyUnhappyPathMessage } = encodeScenarioSummary(scenarioCounts);

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
      happy_unhappy_path_name: happyUnhappyPathName,
      happy_unhappy_path_message: happyUnhappyPathMessage,
    });
  } catch (err) {
    // A logging failure should never crash the sync itself — the sync
    // result has already been determined by this point; we just
    // couldn't persist the audit trail. Log to console as a fallback.
    logger.error('syncLogService', 'Failed to write sync_logs row', err);
  }
}

module.exports = { recordSyncRun };