'use strict';

const logger = require('../../utils/logger');
const { notifyAdmins } = require('../notificationService');

function configuredRecipients(envName = 'INTEGRATION_ALERT_TO_EMAILS') {
  return String(process.env[envName] || '')
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

async function sendConfiguredEmail(catalystApp, { subject, content, recipientEnv }) {
  const fromEmail = process.env.INTEGRATION_ALERT_FROM_EMAIL;
  const recipients = configuredRecipients(recipientEnv);
  if (!fromEmail || recipients.length === 0) {
    logger.info(
      'integrationAlertService',
      `Email not sent for "${subject}"; configure INTEGRATION_ALERT_FROM_EMAIL and ${recipientEnv}.`
    );
    return { sent: false, reason: 'EMAIL_NOT_CONFIGURED' };
  }

  try {
    const result = await catalystApp.email().sendMail({
      from_email: fromEmail,
      to_email: recipients,
      subject,
      content,
      html_mode: false,
      display_name: 'MG Lead Exchange',
    });
    return { sent: true, result };
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

async function sendDailyReportEmail(catalystApp, content) {
  return sendConfiguredEmail(catalystApp, {
    subject: `[MG Lead Exchange] Daily error report ${new Date().toISOString().slice(0, 10)}`,
    content,
    recipientEnv: 'DAILY_ERROR_REPORT_TO_EMAILS',
  });
}

module.exports = { notifyScenario, notifyRecovery, sendDailyReportEmail };
