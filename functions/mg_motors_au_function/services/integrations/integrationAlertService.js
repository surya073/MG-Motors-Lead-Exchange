'use strict';

const nodemailer = require('nodemailer');
const logger = require('../../utils/logger');
const { notifyAdmins } = require('../notificationService');
const emailTemplates = require('./emailTemplates');
const alertContext = require('./alertContext');

/**
 * Two delivery channels, tried in order:
 *
 *   1. SMTP (SMTP_HOST + SMTP_USER + SMTP_PASS) — used when configured.
 *      Catalyst's own mail service requires the sender address to be
 *      registered AND verified by clicking a code, which is a manual step
 *      that cannot be automated; SMTP needs only credentials, so it is the
 *      practical channel for getting GR-04 alerts flowing.
 *   2. Catalyst Email — used when SMTP is not configured and a verified
 *      sender exists.
 *
 * Both are optional. With neither configured the alert still reaches the
 * in-app notifications table and the log, so a missing mail setup can never
 * break a sync.
 */
let cachedTransport;

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getSmtpTransport() {
  if (cachedTransport) return cachedTransport;
  const port = Number(process.env.SMTP_PORT) || 587;
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // Implicit TLS on 465; STARTTLS on 587/25. Overridable for providers
    // that do not follow the convention.
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return cachedTransport;
}

async function sendViaSmtp({ from, to, subject, content, html }) {
  const info = await getSmtpTransport().sendMail({
    from: `"MG Lead Exchange" <${from}>`,
    to: to.join(', '),
    subject,
    // Both parts are sent: the HTML renders in a mail client, the plain
    // text is what a phone notification preview or a text-only client shows.
    text: content,
    ...(html ? { html } : {}),
  });
  return { sent: true, channel: 'SMTP', messageId: info.messageId, accepted: info.accepted };
}

function configuredRecipients(envName = 'INTEGRATION_ALERT_TO_EMAILS') {
  return String(process.env[envName] || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

async function sendConfiguredEmail(catalystApp, { subject, content, html, recipientEnv }) {
  const fromEmail = process.env.INTEGRATION_ALERT_FROM_EMAIL || process.env.SMTP_USER;
  const recipients = configuredRecipients(recipientEnv);
  if (!fromEmail || recipients.length === 0) {
    logger.info(
      'integrationAlertService',
      `Email not sent for "${subject}"; configure a sender and ${recipientEnv}.`
    );
    return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  }

  if (smtpConfigured()) {
    try {
      return await sendViaSmtp({ from: fromEmail, to: recipients, subject, content, html });
    } catch (err) {
      // Fall through to Catalyst Email rather than losing the alert.
      logger.error('integrationAlertService', `SMTP delivery failed for "${subject}"`, err);
    }
  }

  try {
    const result = await catalystApp.email().sendMail({
      from_email: fromEmail,
      to_email: recipients,
      subject,
      content: html || content,
      html_mode: Boolean(html),
      display_name: 'MG Lead Exchange',
    });
    return { sent: true, channel: 'CATALYST', result };
  } catch (err) {
    // Alert delivery must never replace the original integration result.
    logger.error('integrationAlertService', `Email delivery failed for "${subject}"`, err);
    return { sent: false, reason: err.message };
  }
}

// Repeat suppression. The register wants an alert on the FIRST failure of
// a lead, immediately — not one per retry. The same alert (same path, same
// lead, same cause) inside this window is logged but not re-emailed or
// re-pushed. Happy (recovery) notices are never suppressed.
const DEDUPE_HOURS = (() => {
  const configured = Number(process.env.ALERT_DEDUPE_HOURS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 6;
})();

// "CODE: detail" -> "CODE"; otherwise the first 60 characters. Two alerts
// with the same cause share this key even when their detail text differs
// only in counts or timestamps.
function causeKey(reason) {
  const text = String(reason || '').trim();
  const code = /^([A-Z0-9_]{4,}):/.exec(text);
  return code ? code[1] : text.slice(0, 60);
}

async function isDuplicateAlert(catalystApp, { type, leadId, reason }) {
  if (!catalystApp || !leadId || DEDUPE_HOURS === 0) return false;
  try {
    const cutoff = new Date(Date.now() - DEDUPE_HOURS * 3600 * 1000);
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT message, created_time FROM notifications WHERE type = '${String(type).replace(/'/g, "''")}' AND related_lead_id = '${String(leadId).replace(/'/g, "''")}' AND recipient_role = 'ADMIN' ORDER BY CREATEDTIME DESC LIMIT 0, 20`
    );
    const key = causeKey(reason);
    return rows.some((row) => {
      const notification = row.notifications;
      const at = new Date(`${String(notification.created_time || '').replace(' ', 'T')}Z`);
      if (Number.isNaN(at.getTime()) || at < cutoff) return false;
      return String(notification.message || '').includes(key);
    });
  } catch (err) {
    // A failed lookup must never swallow an alert.
    logger.error('integrationAlertService', 'Alert de-duplication lookup failed; sending anyway', err);
    return false;
  }
}

async function notifyScenario(catalystApp, {
  scenarioCode,
  scenarioMessage,
  priority = 'P2',
  dealerCode,
  leadId,
  customerName,
  reason,
}) {
  const type = scenarioCode.replace(/\s+/g, '_').toUpperCase();
  const isHappy = /^Happy/i.test(scenarioCode);

  if (!isHappy && await isDuplicateAlert(catalystApp, { type, leadId, reason })) {
    logger.info(
      'integrationAlertService',
      `Suppressed repeat ${scenarioCode} alert for lead ${leadId} (same cause within ${DEDUPE_HOURS}h)`
    );
    return { sent: false, reason: 'DUPLICATE_SUPPRESSED' };
  }

  const email = emailTemplates.renderAlertEmail({
    scenarioCode,
    scenarioMessage,
    priority,
    dealerCode,
    leadId,
    customerName,
    reason,
  });

  // In-app notification: short, scannable, and carries the cause key so the
  // de-duplication above can recognise a repeat.
  const title = `${priority && !isHappy ? `${priority} ` : ''}${scenarioCode}: ${scenarioMessage}`.trim();
  const message = [
    dealerCode ? `Dealer ${dealerCode}` : null,
    customerName ? `Customer ${String(customerName).slice(0, 1)}***` : null,
    reason ? String(reason).slice(0, 400) : null,
  ].filter(Boolean).join(' · ');

  if (catalystApp) {
    await notifyAdmins(catalystApp, {
      type,
      title,
      message,
      relatedLeadId: leadId,
      relatedDealerCode: dealerCode,
    });
  }

  // Detected by a background scheduler rather than by someone's action:
  // recorded above (and on the timeline / daily report), not emailed.
  if (alertContext.isBackground() && !alertContext.backgroundEmailEnabled()) {
    logger.info('integrationAlertService', `Background ${scenarioCode} alert for lead ${leadId || '-'} recorded without email`);
    return { sent: false, reason: 'BACKGROUND_NO_EMAIL' };
  }

  return sendConfiguredEmail(catalystApp, {
    subject: email.subject,
    content: email.text,
    html: email.html,
    recipientEnv: 'INTEGRATION_ALERT_TO_EMAILS',
  });
}

async function notifyRecovery(catalystApp, { dealerCode, leadId, customerName, durationMinutes, attemptCount }) {
  return notifyScenario(catalystApp, {
    scenarioCode: 'Happy 4',
    scenarioMessage: 'Integration recovery (replay)',
    priority: '',
    dealerCode,
    leadId,
    customerName,
    reason:
      `Delivered to the dealer CRM after ${durationMinutes ?? 'an unknown number of'} minute(s) of failure; ` +
      `delivery attempts: ${attemptCount ?? 'unknown'}`,
  });
}

async function sendTestAlert(catalystApp) {
  const email = emailTemplates.renderTestEmail({
    channel: smtpConfigured() ? 'SMTP' : 'Catalyst Email',
  });
  return sendConfiguredEmail(catalystApp, {
    subject: email.subject,
    content: email.text,
    html: email.html,
    recipientEnv: 'INTEGRATION_ALERT_TO_EMAILS',
  });
}

async function sendDailyReportEmail(catalystApp, content, html) {
  return sendConfiguredEmail(catalystApp, {
    subject: `[DAILY REPORT] MG Lead Exchange — ${new Date().toISOString().slice(0, 10)}`,
    content,
    html,
    recipientEnv: 'DAILY_ERROR_REPORT_TO_EMAILS',
  });
}

module.exports = { notifyScenario, notifyRecovery, sendDailyReportEmail, sendConfiguredEmail, sendTestAlert, smtpConfigured };
