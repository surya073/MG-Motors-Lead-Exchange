'use strict';

const logger = require('../../utils/logger');
const { getWebhookEventRetentionDays } = require('../../config/env');

/**
 * webhookEventRetention.js
 * -----------------------------------------------------------------------
 * Audit S9 (FUSION_REMEDIATION_PLAN.md, Batch 6): webhook_events gains a row
 * per dealer delivery, and with INBOUND_EVENT_STORE each Fusion row carries
 * the encrypted body. SUCCESS rows older than WEBHOOK_EVENT_RETENTION_DAYS
 * are deleted; rows in any other state are kept, since they may still be
 * processed again or replayed. Off until the variable is set (Q23).
 */

const WEBHOOK_EVENTS_TABLE = 'webhook_events';
// ZCQL refuses a LIMIT above 300 rows.
const MAX_ROWS_PER_RUN = 300;
const DELETE_CONCURRENCY = 10;
// Catalyst system columns (CREATEDTIME) are in the project timezone,
// Asia/Kolkata (see inboundReplayScheduler.js).
const PROJECT_UTC_OFFSET_MINUTES = 330;
// fast-recover runs every 2 minutes; this window catches one run a day.
const DAILY_WINDOW_START_MINUTE_UTC = 16 * 60;
const DAILY_WINDOW_MINUTES = 2;

function pad(n) {
  return String(n).padStart(2, '0');
}

function toProjectSystemTime(ms) {
  const d = new Date(ms + PROJECT_UTC_OFFSET_MINUTES * 60000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function isRetentionDue(now = new Date()) {
  const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minuteOfDay >= DAILY_WINDOW_START_MINUTE_UTC &&
    minuteOfDay < DAILY_WINDOW_START_MINUTE_UTC + DAILY_WINDOW_MINUTES;
}

async function purgeOldWebhookEvents(catalystApp, { now = Date.now(), days = getWebhookEventRetentionDays() } = {}) {
  if (!days) return { skipped: true, reason: 'RETENTION_OFF' };
  const cutoff = toProjectSystemTime(now - days * 24 * 60 * 60 * 1000);
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT ROWID FROM ${WEBHOOK_EVENTS_TABLE} WHERE processing_status = 'SUCCESS' AND CREATEDTIME < '${cutoff}' LIMIT 0, ${MAX_ROWS_PER_RUN}`
  );
  const ids = rows.map((r) => r[WEBHOOK_EVENTS_TABLE].ROWID);
  const table = catalystApp.datastore().table(WEBHOOK_EVENTS_TABLE);
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < ids.length; i += DELETE_CONCURRENCY) {
    const outcomes = await Promise.allSettled(ids.slice(i, i + DELETE_CONCURRENCY).map((id) => table.deleteRow(id)));
    outcomes.forEach((outcome) => {
      if (outcome.status === 'fulfilled') deleted += 1;
      else failed += 1;
    });
  }
  if (failed > 0) logger.error('webhookEventRetention', `${failed} old webhook event row(s) could not be deleted`);
  logger.info('webhookEventRetention', `Deleted ${deleted} SUCCESS webhook event row(s) created before ${cutoff}`);
  return { deleted, failed, cutoff, more: ids.length === MAX_ROWS_PER_RUN };
}

module.exports = { purgeOldWebhookEvents, isRetentionDue };
