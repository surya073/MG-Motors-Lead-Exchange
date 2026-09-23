'use strict';

const logger = require('../../utils/logger');
const integrationAlertService = require('./integrationAlertService');
const pathPolicy = require('./pathPolicyService');

const INTEGRATION_LOGS_TABLE = 'integration_logs';
const PAGE_SIZE = 200;
const MAX_ROWS = 2000;

/**
 * Pulls integration activity from the last 24h and keeps every Unhappy
 * classification. Some unhappy business events (notably Unhappy 9) can
 * be transported successfully, so filtering only status=FAILED would
 * hide them from MG's report.
 * Filters by happy_unhappy_path_priority, NOT a hardcoded scenario
 * name list, so future P1 scenarios are picked up automatically.
 */
async function buildDailyErrorReport(catalystApp) {
  // Catalyst ZCQL does not consistently support SQL date arithmetic such
  // as `CURRENT_TIMESTAMP - 1`. Page newest-first and apply the exact
  // rolling 24-hour cutoff in JavaScript instead.
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const logs = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${INTEGRATION_LOGS_TABLE} ORDER BY CREATEDTIME DESC LIMIT ${offset}, ${PAGE_SIZE}`
    );
    const batch = rows.map((r) => r[INTEGRATION_LOGS_TABLE]);
    batch.forEach((log) => {
      const createdAt = pathPolicy.parseTimestamp(log.CREATEDTIME);
      if (
        createdAt && createdAt.getTime() >= cutoffMs &&
        /^Unhappy\s+/i.test(log.happy_unhappy_path_name || '')
      ) {
        logs.push(log);
      }
    });

    const oldest = pathPolicy.parseTimestamp(batch[batch.length - 1]?.CREATEDTIME);
    if (batch.length < PAGE_SIZE || (oldest && oldest.getTime() < cutoffMs)) break;
  }

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
