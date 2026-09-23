'use strict';

const nodemailer = require('nodemailer');
const logger = require('../../utils/logger');
const { notifyAdmins } = require('../notificationService');

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

async function notifyScenario(catalystApp, {
  scenarioCode,
  scenarioMessage,
  priority = 'P2',
  dealerCode,
  leadId,
  customerName,
  reason,
}) {
  const title = `${priority ? `${priority} ` : ''}${scenarioCode}: ${scenarioMessage}`.trim();
  const parts = [
    dealerCode ? `Dealer: ${dealerCode}` : null,
    leadId ? `Inquiry: ${leadId}` : null,
    customerName ? `Customer: ${String(customerName).slice(0, 1)}***` : null,
    reason ? `Reason: ${reason}` : null,
    `Time (UTC): ${new Date().toISOString()}`,
  ].filter(Boolean);
  const message = parts.join(' | ');

  await notifyAdmins(catalystApp, {
    type: scenarioCode.replace(/\s+/g, '_').toUpperCase(),
    title,
    message,
    relatedLeadId: leadId,
    relatedDealerCode: dealerCode,
  });

  return sendConfiguredEmail(catalystApp, {
    subject: `[MG Lead Exchange] ${title}`,
    content: `${title}\n\n${parts.join('\n')}`,
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
    reason: `Recovered after ${durationMinutes ?? 'unknown'} minute(s), attempts=${attemptCount ?? 'unknown'}`,
  });
}

async function sendDailyReportEmail(catalystApp, content, html) {
  return sendConfiguredEmail(catalystApp, {
    subject: `[MG Lead Exchange] Daily error report ${new Date().toISOString().slice(0, 10)}`,
    content,
    html,
    recipientEnv: 'DAILY_ERROR_REPORT_TO_EMAILS',
  });
}

module.exports = { notifyScenario, notifyRecovery, sendDailyReportEmail, sendConfiguredEmail, smtpConfigured };
