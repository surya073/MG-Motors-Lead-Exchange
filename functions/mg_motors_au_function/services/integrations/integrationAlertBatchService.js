'use strict';

const logger = require('../../utils/logger');
const emailTemplates = require('./emailTemplates');
const pathPolicy = require('./pathPolicyService');

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
// email; anything beyond this stays queued for the next flush.
const MAX_BATCH_ROWS = 500;

// How many queued failures trigger an immediate consolidated email.
const BATCH_SIZE = (() => {
  const configured = Number(process.env.ALERT_BATCH_SIZE);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 10;
})();

// How long a failure may sit in the queue before it is sent as part of a
// consolidated email even though the threshold above was never reached.
const BATCH_WINDOW_MINUTES = (() => {
  const configured = Number(process.env.ALERT_BATCH_WINDOW_MINUTES);
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
})();

async function fetchPending(catalystApp, limit = MAX_BATCH_ROWS) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${ALERT_QUEUE_TABLE} ORDER BY CREATEDTIME ASC LIMIT 0, ${Math.min(limit, MAX_BATCH_ROWS)}`
  );
  // The datastore column is priority_for, not priority — "priority" is a
  // reserved word in Catalyst Data Store. Aliased back to `priority` here,
  // at the one place rows are read, so every other consumer (email
  // rendering, sorting) can keep using the natural field name.
  return rows.map((r) => {
    const row = r[ALERT_QUEUE_TABLE];
    return { ...row, priority: row.priority_for };
  });
}

/**
 * Sends exactly the rows passed in as one consolidated email, then dequeues
 * those rows. Rows inserted after `rows` was fetched are left untouched for
 * the next flush, so a flush can never lose or duplicate a failure that
 * arrives mid-flight.
 *
 * required lazily to avoid a require cycle: integrationAlertService requires
 * this module to enqueue failures, this module requires it back only here,
 * at call time, to reuse its SMTP/Catalyst-email delivery.
 */
async function flushPending(catalystApp, rows) {
  if (!rows.length) return { sent: false, reason: 'EMPTY', count: 0 };

  const integrationAlertService = require('./integrationAlertService');
  const email = emailTemplates.renderBatchAlertEmail({ failures: rows });
  const result = await integrationAlertService.sendConfiguredEmail(catalystApp, {
    subject: email.subject,
    content: email.text,
    html: email.html,
    recipientEnv: 'INTEGRATION_ALERT_TO_EMAILS',
  });

  if (result.sent) {
    const table = catalystApp.datastore().table(ALERT_QUEUE_TABLE);
    await Promise.all(rows.map((row) => table.deleteRow(row.ROWID).catch((err) => {
      logger.error('integrationAlertBatchService', `Failed to dequeue alert row ${row.ROWID} after sending batch email`, err);
    })));
    logger.info('integrationAlertBatchService', `Sent consolidated failure email for ${rows.length} failure(s)`);
  } else {
    // Delivery must never lose the underlying failures: leave them queued
    // so the next threshold hit or window flush retries them.
    logger.info('integrationAlertBatchService', `Consolidated failure email not sent (${result.reason}); ${rows.length} failure(s) remain queued`);
  }

  return { ...result, count: rows.length };
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
    const pending = await fetchPending(catalystApp, BATCH_SIZE);
    if (pending.length >= BATCH_SIZE) {
      return { queued: true, flush: await flushPending(catalystApp, pending) };
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
async function flushIfWindowElapsed(catalystApp) {
  const pending = await fetchPending(catalystApp, MAX_BATCH_ROWS);
  if (!pending.length) return { sent: false, reason: 'EMPTY', count: 0 };

  const oldest = pathPolicy.parseTimestamp(pending[0].CREATEDTIME);
  const ageMinutes = oldest ? (Date.now() - oldest.getTime()) / 60000 : Infinity;
  if (ageMinutes < BATCH_WINDOW_MINUTES) {
    return { sent: false, reason: 'WINDOW_NOT_ELAPSED', count: pending.length };
  }

  return flushPending(catalystApp, pending);
}

module.exports = {
  enqueueFailure,
  flushIfWindowElapsed,
  ALERT_QUEUE_TABLE,
  BATCH_SIZE,
  BATCH_WINDOW_MINUTES,
};
