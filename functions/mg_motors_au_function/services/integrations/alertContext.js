'use strict';

const { AsyncLocalStorage } = require('async_hooks');

/**
 * Marks work that runs from a background scheduler (retry, replay, SLA and
 * reconciliation sweeps) so alerts raised inside it are recorded — timeline,
 * Activity Log, daily report, in-app notification — but NOT emailed.
 *
 * Email is reserved for paths someone actually triggers: a lead created or
 * edited in the OEM CRM, a dealer editing in their CRM, or an action taken in
 * Lead Exchange. Set ALERT_EMAIL_FROM_BACKGROUND=true to email background
 * detections again.
 */
const storage = new AsyncLocalStorage();

function runInBackground(fn) {
  return storage.run({ background: true }, fn);
}

function isBackground() {
  return Boolean(storage.getStore()?.background);
}

function backgroundEmailEnabled() {
  return String(process.env.ALERT_EMAIL_FROM_BACKGROUND || '').toLowerCase() === 'true';
}

module.exports = { runInBackground, isBackground, backgroundEmailEnabled };
