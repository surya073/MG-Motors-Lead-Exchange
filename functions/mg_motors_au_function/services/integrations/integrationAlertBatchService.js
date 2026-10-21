'use strict';

const logger = require('../../utils/logger');
const { mapWithConcurrency } = require('../../utils/concurrency');
const emailTemplates = require('./emailTemplates');
const pathPolicy = require('./pathPolicyService');
const { countFrom } = require('./sweepWindow');
const { withOperationClaim } = require('./integrationOperationClaimService');

// Durable queue of not-yet-emailed integration failures. Each row is one
// failure event (already logged in integration_logs and recorded as an
// in-app admin notification by integrationAlertService.notifyScenario) that
// is waiting to go out as part of the next consolidated email rather than
// its own individual email.
//
// Only technical/reference fields are ever written here — scenario, dealer
// code, MG enquiry (lead) ID, priority, reason — never a customer name,
// phone or email, so the digest built from these rows can never carry
// customer PII.
const ALERT_QUEUE_TABLE = 'integration_alert_queue';

// A single flush never tries to cram an unbounded failure storm into one
// email; anything beyond this stays queued for the next flush. 300 is also
// the most rows one ZCQL SELECT may ask for: a LIMIT above it is refused.
const MAX_BATCH_ROWS = 300;
const DEQUEUE_CONCURRENCY = 5;
const budgetSpent = (deadline) => typeof deadline === 'number' && Date.now() >= deadline;
const budgetResult = () => ({ sent: false, skipped: true, reason: 'WORK_BUDGET_EXHAUSTED', deferredUnknown: true });

// How many queued failures trigger an immediate consolidated email.
const BATCH_SIZE = (() => {
  const configured = Number(process.env.ALERT_BATCH_SIZE);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(MAX_BATCH_ROWS, Math.max(1, Math.floor(configured)))
    : 100;
})();

// How long a failure may sit in the queue before it is sent as part of a
// consolidated email even though the threshold above was never reached.
const BATCH_WINDOW_MINUTES = (() => {
  const configured = Number(process.env.ALERT_BATCH_WINDOW_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
})();

async function fetchPending(catalystApp, limit = MAX_BATCH_ROWS, sentIds = new Set(), { deadline } = {}) {
  const pending = [];
  const pageSize = Math.min(limit, MAX_BATCH_ROWS);
  // Sent rows that cannot be deleted are quarantined by their durable receipt.
  // Page past them, without a giant NOT IN expression or dropping evidence.
  for (let offset = 0; pending.length < limit; offset += pageSize) {
    if (budgetSpent(deadline)) return null;
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${ALERT_QUEUE_TABLE} ORDER BY CREATEDTIME ASC, ROWID ASC LIMIT ${offset + 1}, ${pageSize}`
    );
    for (const wrapped of rows) {
      const row = wrapped[ALERT_QUEUE_TABLE];
      if (!sentIds.has(String(row.ROWID))) pending.push({ ...row, priority: row.priority_for });
      if (pending.length >= limit) break;
    }
    if (rows.length < pageSize) break;
  }
  return pending;
}

async function countPending(catalystApp) {
  return countFrom(await catalystApp.zcql().executeZCQLQuery(
    `SELECT COUNT(ROWID) FROM ${ALERT_QUEUE_TABLE}`
  ), ALERT_QUEUE_TABLE);
}

async function deleteQueuedRows(catalystApp, ids, { deadline } = {}) {
  const table = catalystApp.datastore().table(ALERT_QUEUE_TABLE);
  const remaining = [];
  await mapWithConcurrency(ids, DEQUEUE_CONCURRENCY, async (id) => {
    if (budgetSpent(deadline)) { remaining.push(String(id)); return; }
    try {
      await table.deleteRow(id);
    } catch (error) {
      // A prior cleanup may have removed the row before its receipt update
      // completed. Prove absence rather than guessing vendor error codes;
      // retrying a missing row must not strand the receipt forever.
      try {
        if (budgetSpent(deadline)) { remaining.push(String(id)); return; }
        const existing = await catalystApp.zcql().executeZCQLQuery(
          `SELECT ROWID FROM ${ALERT_QUEUE_TABLE} WHERE ROWID = '${String(id).replace(/'/g, "''")}' LIMIT 1`
        );
        if (!existing.length) return;
      } catch (lookupError) {
        logger.error('integrationAlertBatchService', `Could not verify failed dequeue for alert row ${id}`, lookupError);
      }
      remaining.push(String(id));
      logger.error('integrationAlertBatchService', `Failed to dequeue already emailed alert row ${id}`, error);
    }
  });
  return { deleted: ids.length - remaining.length, remaining };
}

async function cleanSentReceipt(catalystApp, lease, receipt, { deadline } = {}) {
  const now = Date.now();
  // Cleanup must leave time for unrelated unsent mail in this invocation.
  // In-flight datastore calls cannot be cancelled, but no more deletes start
  // after this small sub-budget (also bounded by the outer request deadline).
  const remainingMs = deadline === undefined ? 20000 : Math.max(0, deadline - now);
  const cleanupDeadline = now + Math.min(2000, Math.floor(remainingMs / 4));
  if (budgetSpent(cleanupDeadline)) return { deleted: 0, deleteFailed: 0, cleanupPending: true, reason: 'WORK_BUDGET_EXHAUSTED' };
  const { deleted, remaining } = await deleteQueuedRows(catalystApp, receipt.rowIds, { deadline: cleanupDeadline });
  try {
    if (remaining.length) await lease.keepUndeleted(receipt, remaining);
    else await lease.removeReceipt(receipt);
  } catch (error) {
    // The existing receipt remains durable; retry cleanup, never email it.
    logger.error('integrationAlertBatchService', 'Could not finish sent-batch receipt cleanup', error);
    return { deleted, deleteFailed: remaining.length, cleanupPending: true };
  }
  return { deleted, deleteFailed: remaining.length, cleanupPending: remaining.length > 0 };
}

/**
 * Called only under the durable dispatch lease, on a freshly read snapshot.
 * After email acceptance, a separate receipt is saved before dequeueing.
 * Partial deletion is retried from that receipt without sending again.
 * SMTP acceptance followed by a crash/receipt-write failure is still an
 * ambiguous delivery window; SMTP has no exactly-once transaction with us.
 *
 * required lazily to avoid a require cycle: integrationAlertService requires
 * this module to enqueue failures, this module requires it back only here,
 * at call time, to reuse its SMTP/Catalyst-email delivery.
 */
async function flushPending(catalystApp, rows, lease, { deadline } = {}) {
  if (!rows.length) return { sent: false, reason: 'EMPTY', count: 0 };
  if (budgetSpent(deadline)) return budgetResult();

  if (!(await lease.isCurrent())) return { sent: false, skipped: true, reason: 'OPERATION_LEASE_EXPIRED' };
  if (budgetSpent(deadline)) return budgetResult();

  const integrationAlertService = require('./integrationAlertService');
  const email = emailTemplates.renderBatchAlertEmail({ failures: rows });
  const result = await integrationAlertService.sendConfiguredEmail(catalystApp, {
    subject: email.subject,
    content: email.text,
    html: email.html,
    recipientEnv: 'INTEGRATION_ALERT_TO_EMAILS',
  });

  if (result.sent) {
    let receipt;
    try {
      receipt = await lease.recordSent({ rowIds: rows.map((row) => row.ROWID), messageId: result.messageId });
    } catch (error) {
      lease.retain();
      logger.error('integrationAlertBatchService', 'Email accepted but its sent-batch receipt could not be stored; delivery requires review', error);
      return { ...result, count: rows.length, deliveryUncertain: true, cleanupPending: true, reason: 'SENT_RECEIPT_NOT_STORED' };
    }
    const cleanup = await cleanSentReceipt(catalystApp, lease, receipt, { deadline });
    logger.info('integrationAlertBatchService', `Sent consolidated failure email for ${rows.length} failure(s)`);
    return { ...result, count: rows.length, ...cleanup };
  } else {
    // Delivery must never lose the underlying failures: leave them queued
    // so the next threshold hit or window flush retries them.
    logger.info('integrationAlertBatchService', `Consolidated failure email not sent (${result.reason}); ${rows.length} failure(s) remain queued`);
  }

  return { ...result, count: rows.length };
}

let dispatchActive = false;

async function dispatchPending(catalystApp, { threshold = false, window = false, deadline = Date.now() + 20000 } = {}) {
  if (budgetSpent(deadline)) return budgetResult();
  // Avoid redundant competing inserts within one instance. The UNIQUE
  // datastore lease below also protects independent function instances.
  if (dispatchActive) return { sent: false, skipped: true, reason: 'OPERATION_ALREADY_RUNNING' };
  dispatchActive = true;
  try {
    const result = await withOperationClaim(catalystApp, 'integration-alert-dispatch', async (lease) => {
      if (budgetSpent(deadline)) return budgetResult();
      const receipts = await lease.listSentReceipts({ deadline });
      if (!receipts) return budgetResult();
      const sentIds = new Set(receipts.flatMap((receipt) => receipt.rowIds.map(String)));
      let cleanup = {};
      if (receipts.length) {
        if (!(await lease.isCurrent())) return { sent: false, skipped: true, reason: 'OPERATION_LEASE_EXPIRED' };
        // Cleanup is bounded to one receipt per invocation and has its own
        // retry clock. A broken delete never blocks selection of unrelated
        // unsent rows, and the receipt remains the authoritative sent marker.
        const due = receipts.find((receipt) => !receipt.reference.cleanupRetryAt
          || Date.now() >= receipt.reference.cleanupRetryAt);
        if (due) cleanup = await cleanSentReceipt(catalystApp, lease, due, { deadline });
        else cleanup = { cleanupPending: true };
      }
      const pending = await fetchPending(catalystApp, threshold ? BATCH_SIZE : MAX_BATCH_ROWS, sentIds, { deadline });
      if (!pending) return { ...budgetResult(), ...cleanup };
      if (!pending.length && receipts.length) return {
        sent: false, reason: 'PREVIOUS_BATCH_CLEANED', count: 0, ...cleanup,
      };
      if (!pending.length) return { sent: false, reason: 'EMPTY', count: 0 };
      if (threshold && pending.length < BATCH_SIZE) return { sent: false, reason: 'THRESHOLD_NOT_REACHED', count: pending.length };
      if (window && !windowElapsed(pending[0].CREATEDTIME)) {
        return { sent: false, reason: 'WINDOW_NOT_ELAPSED', count: pending.length };
      }
      const flushed = await flushPending(catalystApp, pending, lease, { deadline });
      return { ...flushed, ...(cleanup.cleanupPending ? { cleanupPending: true } : {}) };
    });
    return { sent: false, ...result };
  } finally {
    dispatchActive = false;
  }
}

function windowElapsed(createdTime) {
  const oldest = pathPolicy.parseSystemTimestamp(createdTime);
  return !oldest || (Date.now() - oldest.getTime()) / 60000 >= BATCH_WINDOW_MINUTES;
}

/**
 * Queues one integration failure instead of emailing it immediately. If
 * this is the Nth failure to reach ALERT_BATCH_SIZE, flushes the queue right
 * away as one consolidated email.
 */
async function enqueueFailure(catalystApp, { scenarioCode, scenarioMessage, priority, dealerCode, leadId, reason }) {
  const row = {
    scenario_code: String(scenarioCode || '').slice(0, 60),
    scenario_message: String(scenarioMessage || '').slice(0, 200),
    // Column is named priority_for — "priority" is a reserved word in
    // Catalyst Data Store and could not be used as the column name.
    priority_for: String(priority || '').slice(0, 10),
    dealer_code: String(dealerCode || '').slice(0, 40),
    lead_id: String(leadId || '').slice(0, 60),
    reason: String(reason || '').slice(0, 500),
  };

  try {
    await catalystApp.datastore().table(ALERT_QUEUE_TABLE).insertRow(row);
  } catch (err) {
    logger.error('integrationAlertBatchService', 'Failed to queue integration failure for batching', err);
    return { queued: false };
  }

  try {
    // One aggregate request replaces repeated materialization of the growing
    // message batch. It reduces payload, not necessarily billed requests.
    if (await countPending(catalystApp) >= BATCH_SIZE) {
      return { queued: true, flush: await dispatchPending(catalystApp, { threshold: true }) };
    }
  } catch (err) {
    logger.error('integrationAlertBatchService', 'Failed to check batch threshold after queueing failure', err);
  }

  return { queued: true };
}

/**
 * Called from the fast-recovery cron sweep. Flushes the queue as one
 * consolidated email once the oldest pending failure has been waiting
 * longer than ALERT_BATCH_WINDOW_MINUTES, even if ALERT_BATCH_SIZE was
 * never reached — "send what's pending" rather than holding a handful of
 * failures indefinitely.
 */
async function flushIfWindowElapsed(catalystApp, { deadline } = {}) {
  if (budgetSpent(deadline)) return budgetResult();
  // Quiet ticks cost one bounded read and no lease writes. Bodies are loaded
  // only when due, and re-read under the lease before sending.
  const oldest = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID, CREATEDTIME FROM ${ALERT_QUEUE_TABLE} ORDER BY CREATEDTIME ASC LIMIT 1`
  );
  if (!oldest.length) return { sent: false, reason: 'EMPTY', count: 0 };
  if (!windowElapsed(oldest[0][ALERT_QUEUE_TABLE].CREATEDTIME)) {
    return { sent: false, reason: 'WINDOW_NOT_ELAPSED', pendingCountUnknown: true };
  }
  return dispatchPending(catalystApp, { window: true, deadline });
}

module.exports = {
  enqueueFailure,
  flushIfWindowElapsed,
  ALERT_QUEUE_TABLE,
  BATCH_SIZE,
  BATCH_WINDOW_MINUTES,
};
