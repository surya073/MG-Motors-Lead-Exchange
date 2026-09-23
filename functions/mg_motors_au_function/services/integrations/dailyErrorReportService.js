'use strict';

const logger = require('../../utils/logger');

const INTEGRATION_LOGS_TABLE = 'integration_logs';

/**
 * Pulls every integration_logs row from the last 24h that is flagged
 * P1 (currently: Unhappy 3 escalations, Unhappy 8 consent holds), plus
 * all other FAILED rows, for the MG Daily Error Report.
 * Filters by happy_unhappy_path_priority, NOT a hardcoded scenario
 * name list, so future P1 scenarios are picked up automatically.
 */
async function buildDailyErrorReport(catalystApp) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${INTEGRATION_LOGS_TABLE} WHERE status = 'FAILED' AND CREATEDTIME > CURRENT_TIMESTAMP - 1 ORDER BY CREATEDTIME DESC`
  );
  const logs = rows.map((r) => r[INTEGRATION_LOGS_TABLE]);

  const p1 = logs.filter((l) => l.happy_unhappy_path_priority === 'P1');
  const other = logs.filter((l) => l.happy_unhappy_path_priority !== 'P1');

  return { generatedAt: new Date().toISOString(), totalFailures: logs.length, p1, other };
}

async function sendDailyErrorReport(catalystApp) {
  const report = await buildDailyErrorReport(catalystApp);

  // TODO: wire to your actual email/notification mechanism —
  // Catalyst Email service, Zoho Cliq webhook, Slack, etc.
  // Stubbed as a log line so the sweep and cron wiring can be tested
  // end-to-end before the notification channel is decided.
  logger.info(
    'dailyErrorReportService',
    `MG Daily Error Report — ${report.totalFailures} failures (${report.p1.length} P1) in last 24h`
  );

  return report;
}

module.exports = { buildDailyErrorReport, sendDailyErrorReport };