'use strict';

const logger = require('../../utils/logger');
const integrationAlertService = require('./integrationAlertService');

const INTEGRATION_LOGS_TABLE = 'integration_logs';

/**
 * Pulls integration activity from the last 24h and keeps every Unhappy
 * classification. Some unhappy business events (notably Unhappy 9) can
 * be transported successfully, so filtering only status=FAILED would
 * hide them from MG's report.
 * Filters by happy_unhappy_path_priority, NOT a hardcoded scenario
 * name list, so future P1 scenarios are picked up automatically.
 */
async function buildDailyErrorReport(catalystApp) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${INTEGRATION_LOGS_TABLE} WHERE CREATEDTIME > CURRENT_TIMESTAMP - 1 ORDER BY CREATEDTIME DESC LIMIT 0, 200`
  );
  const logs = rows
    .map((r) => r[INTEGRATION_LOGS_TABLE])
    .filter((log) => /^Unhappy\s+/i.test(log.happy_unhappy_path_name || ''));

  const p1 = logs.filter((l) => l.happy_unhappy_path_priority === 'P1');
  const other = logs.filter((l) => l.happy_unhappy_path_priority !== 'P1');

  return { generatedAt: new Date().toISOString(), totalFailures: logs.length, p1, other };
}

async function sendDailyErrorReport(catalystApp) {
  const report = await buildDailyErrorReport(catalystApp);
  const lines = [
    `Generated: ${report.generatedAt}`,
    `Failures in the last 24 hours: ${report.totalFailures}`,
    `P1: ${report.p1.length}`,
    '',
    ...report.p1.concat(report.other).map((row) =>
      [
        row.happy_unhappy_path_priority || 'P2/P3',
        row.happy_unhappy_path_name || 'Unclassified',
        `dealer=${row.dealer_code || 'n/a'}`,
        `inquiry=${row.zoho_lead_id || 'n/a'}`,
        `reason=${row.error_message || row.happy_unhappy_path_message || 'n/a'}`,
      ].join(' | ')
    ),
  ];

  const email = await integrationAlertService.sendDailyReportEmail(
    catalystApp,
    lines.join('\n')
  );
  logger.info(
    'dailyErrorReportService',
    `MG Daily Error Report — ${report.totalFailures} failures (${report.p1.length} P1) in last 24h; emailSent=${email.sent}`
  );

  return { ...report, email };
}

module.exports = { buildDailyErrorReport, sendDailyErrorReport };
