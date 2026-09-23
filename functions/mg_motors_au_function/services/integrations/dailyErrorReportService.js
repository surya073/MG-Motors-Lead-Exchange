'use strict';

const logger = require('../../utils/logger');
const integrationAlertService = require('./integrationAlertService');
const pathPolicy = require('./pathPolicyService');

const INTEGRATION_LOGS_TABLE = 'integration_logs';
const LEADS_TABLE = 'leads';
const PAGE_SIZE = 200;
const MAX_ROWS = 2000;

// How many affected leads to name inline per issue before summarising the
// rest as "+N more". The register wants the affected leads identified by
// ID and customer name; it does not want a wall of 40 identical lines.
const LEADS_NAMED_PER_ISSUE = 8;

const PRIORITY_ORDER = { P1: 0, P2: 1, P3: 2, '': 3 };

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Pulls the last 24 hours of integration activity.
 *
 * Every log row is kept, not only the Unhappy ones: a later SUCCESS on the
 * same lead is what tells us an issue was RESOLVED during the day, and the
 * register asks the end-of-day report to show "unhappy items still open,
 * plus items resolved or reclassified as Happy during the day".
 */
async function fetchRecentLogs(catalystApp, cutoffMs) {
  const logs = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const rows = await catalystApp.zcql().executeZCQLQuery(
      `SELECT * FROM ${INTEGRATION_LOGS_TABLE} ORDER BY CREATEDTIME DESC LIMIT ${offset}, ${PAGE_SIZE}`
    );
    const batch = rows.map((r) => r[INTEGRATION_LOGS_TABLE]);
    batch.forEach((log) => {
      const at = pathPolicy.parseTimestamp(log.CREATEDTIME);
      if (at && at.getTime() >= cutoffMs) logs.push({ ...log, _at: at });
    });

    const oldest = pathPolicy.parseTimestamp(batch[batch.length - 1]?.CREATEDTIME);
    if (batch.length < PAGE_SIZE || (oldest && oldest.getTime() < cutoffMs)) break;
  }
  return logs;
}

/** Customer names for the affected leads, so the report names people not just ids. */
async function fetchLeadNames(catalystApp, leadIds) {
  const names = new Map();
  const ids = Array.from(leadIds).filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map((id) => `'${safeQuoteForZcql(id)}'`).join(',');
    if (!chunk) continue;
    try {
      const rows = await catalystApp.zcql().executeZCQLQuery(
        `SELECT crm_record_id, customer_name, lead_status FROM ${LEADS_TABLE} WHERE crm_record_id IN (${chunk})`
      );
      rows.forEach((r) => {
        const lead = r[LEADS_TABLE];
        names.set(lead.crm_record_id, {
          name: lead.customer_name || '',
          status: lead.lead_status || '',
        });
      });
    } catch (err) {
      logger.error('dailyErrorReportService', 'Lead name lookup failed for a chunk', err);
    }
  }
  return names;
}

function hhmm(date) {
  return date ? date.toISOString().slice(11, 16) : '--:--';
}

/**
 * Collapses raw log rows into one entry per (scenario + dealer + reason),
 * which is what makes the report readable: the flat version repeated the
 * same enquiry once per retry, so 97 rows described about a dozen problems.
 */
function buildIssues(unhappyLogs, resolvedLeadIds) {
  const issues = new Map();

  unhappyLogs.forEach((log) => {
    const scenario = log.happy_unhappy_path_name || 'Unclassified';
    const dealer = log.dealer_code || 'unrouted';
    const reason = log.error_message || log.happy_unhappy_path_message || 'no reason recorded';
    const key = `${scenario}|${dealer}|${reason}`;

    let issue = issues.get(key);
    if (!issue) {
      issue = {
        scenario,
        dealer,
        reason,
        priority: log.happy_unhappy_path_priority || '',
        occurrences: 0,
        firstAt: log._at,
        lastAt: log._at,
        leadIds: new Set(),
      };
      issues.set(key, issue);
    }

    issue.occurrences += 1;
    if (log._at < issue.firstAt) issue.firstAt = log._at;
    if (log._at > issue.lastAt) issue.lastAt = log._at;
    if (log.zoho_lead_id) issue.leadIds.add(log.zoho_lead_id);
    // Keep the strongest priority seen; early rows predate the priority column.
    if (log.happy_unhappy_path_priority &&
        PRIORITY_ORDER[log.happy_unhappy_path_priority] < PRIORITY_ORDER[issue.priority]) {
      issue.priority = log.happy_unhappy_path_priority;
    }
  });

  return Array.from(issues.values())
    .map((issue) => {
      const leads = Array.from(issue.leadIds);
      const open = leads.filter((id) => !resolvedLeadIds.has(id));
      return { ...issue, leads, openLeads: open, resolvedCount: leads.length - open.length };
    })
    .sort((a, b) => {
      const p = (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
      if (p !== 0) return p;
      if (b.openLeads.length !== a.openLeads.length) return b.openLeads.length - a.openLeads.length;
      return b.occurrences - a.occurrences;
    });
}

async function buildDailyErrorReport(catalystApp) {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const logs = await fetchRecentLogs(catalystApp, cutoffMs);

  const unhappy = logs.filter((l) => /^Unhappy\s+/i.test(l.happy_unhappy_path_name || ''));

  // A lead counts as resolved when a SUCCESS landed after its last failure.
  const lastFailureAt = new Map();
  unhappy.forEach((l) => {
    if (!l.zoho_lead_id) return;
    const prev = lastFailureAt.get(l.zoho_lead_id);
    if (!prev || l._at > prev) lastFailureAt.set(l.zoho_lead_id, l._at);
  });

  const resolvedLeadIds = new Set();
  logs.forEach((l) => {
    if (l.status !== 'SUCCESS' || !l.zoho_lead_id) return;
    if (/^Unhappy\s+/i.test(l.happy_unhappy_path_name || '')) return; // Unhappy 9 transports fine
    const failedAt = lastFailureAt.get(l.zoho_lead_id);
    if (failedAt && l._at > failedAt) resolvedLeadIds.add(l.zoho_lead_id);
  });

  const issues = buildIssues(unhappy, resolvedLeadIds);
  const affected = new Set(unhappy.map((l) => l.zoho_lead_id).filter(Boolean));
  const leadInfo = await fetchLeadNames(catalystApp, affected);

  const openIssues = issues.filter((i) => i.openLeads.length > 0);
  const p1Open = openIssues.filter((i) => i.priority === 'P1');

  return {
    generatedAt: new Date(),
    windowHours: 24,
    totalEvents: unhappy.length,
    issues,
    openIssues,
    p1Open,
    affectedLeads: affected.size,
    resolvedLeads: resolvedLeadIds.size,
    dealersAffected: new Set(unhappy.map((l) => l.dealer_code).filter(Boolean)).size,
    leadInfo,
  };
}

function describeLeads(issue, leadInfo) {
  const shown = issue.openLeads.slice(0, LEADS_NAMED_PER_ISSUE).map((id) => {
    const info = leadInfo.get(id);
    return info && info.name ? `${info.name} (${id})` : id;
  });
  const remaining = issue.openLeads.length - shown.length;
  if (remaining > 0) shown.push(`+${remaining} more`);
  return shown;
}

function renderText(report) {
  const d = report.generatedAt;
  const out = [
    'MG LEAD EXCHANGE - DAILY ERROR REPORT',
    `${d.toISOString().slice(0, 10)}  ${hhmm(d)} UTC   (rolling ${report.windowHours}h)`,
    '',
    'SUMMARY',
    `  Open issues        ${report.openIssues.length}`,
    `  P1 critical        ${report.p1Open.length}${report.p1Open.length ? '   <-- act first' : ''}`,
    `  Leads affected     ${report.affectedLeads}`,
    `  Resolved today     ${report.resolvedLeads}`,
    `  Dealers affected   ${report.dealersAffected}`,
    `  Total events       ${report.totalEvents}`,
    '',
  ];

  if (report.openIssues.length === 0) {
    out.push('No open issues. Everything raised in the last 24 hours has recovered.');
    return out.join('\n');
  }

  let lastPriority = null;
  report.openIssues.forEach((issue) => {
    const label = issue.priority || 'unclassified';
    if (label !== lastPriority) {
      out.push('', `${'='.repeat(64)}`, `${label.toUpperCase()}`, `${'='.repeat(64)}`);
      lastPriority = label;
    }
    out.push('');
    out.push(`${issue.scenario}  -  dealer ${issue.dealer}`);
    out.push(`  Reason        ${issue.reason}`);
    out.push(`  Open leads    ${issue.openLeads.length}${issue.resolvedCount ? ` (${issue.resolvedCount} recovered)` : ''}`);
    out.push(`  Window        ${hhmm(issue.firstAt)} - ${hhmm(issue.lastAt)} UTC, ${issue.occurrences} event(s)`);
    describeLeads(issue, report.leadInfo).forEach((line, i) => {
      out.push(`  ${i === 0 ? 'Affected     ' : '             '} ${line}`);
    });
  });

  const recovered = report.issues.filter((i) => i.resolvedCount > 0 && i.openLeads.length === 0);
  if (recovered.length) {
    out.push('', '='.repeat(64), 'RESOLVED DURING THE DAY', '='.repeat(64));
    recovered.forEach((issue) => {
      out.push(`  ${issue.scenario} - dealer ${issue.dealer} - ${issue.resolvedCount} lead(s) recovered`);
    });
  }

  return out.join('\n');
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(report) {
  const d = report.generatedAt;
  const colour = { P1: '#b3261e', P2: '#a15c00', P3: '#4a5568' };
  const chip = (p) =>
    `<span style="background:${colour[p] || '#4a5568'};color:#fff;border-radius:3px;padding:1px 7px;font:600 11px/1.6 system-ui,sans-serif">${esc(p || 'UNCLASSIFIED')}</span>`;

  const stat = (label, value, accent) => `
    <td style="padding:10px 16px;border:1px solid #e3e6ea;border-radius:6px">
      <div style="font:600 22px/1.2 system-ui,sans-serif;color:${accent || '#111'}">${esc(value)}</div>
      <div style="font:400 11px/1.6 system-ui,sans-serif;color:#667">${esc(label)}</div>
    </td>`;

  const rows = report.openIssues.map((issue) => `
    <tr>
      <td style="padding:12px 10px;border-top:1px solid #e3e6ea;vertical-align:top;white-space:nowrap">${chip(issue.priority)}</td>
      <td style="padding:12px 10px;border-top:1px solid #e3e6ea;vertical-align:top">
        <div style="font:600 14px/1.4 system-ui,sans-serif;color:#111">${esc(issue.scenario)}</div>
        <div style="font:400 12px/1.6 system-ui,sans-serif;color:#556">${esc(issue.reason)}</div>
        <div style="font:400 12px/1.7 system-ui,sans-serif;color:#334;margin-top:6px">
          ${describeLeads(issue, report.leadInfo).map(esc).join(' &middot; ')}
        </div>
      </td>
      <td style="padding:12px 10px;border-top:1px solid #e3e6ea;vertical-align:top;font:400 12px/1.6 system-ui,sans-serif;color:#334;white-space:nowrap">${esc(issue.dealer)}</td>
      <td style="padding:12px 10px;border-top:1px solid #e3e6ea;vertical-align:top;font:600 13px/1.6 system-ui,sans-serif;color:#111;text-align:right">${issue.openLeads.length}</td>
      <td style="padding:12px 10px;border-top:1px solid #e3e6ea;vertical-align:top;font:400 12px/1.6 system-ui,sans-serif;color:#667;white-space:nowrap">${esc(hhmm(issue.firstAt))}&ndash;${esc(hhmm(issue.lastAt))}</td>
    </tr>`).join('');

  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;padding:24px">
<div style="max-width:860px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:8px;overflow:hidden">
  <div style="padding:20px 24px;border-bottom:1px solid #e3e6ea">
    <div style="font:600 17px/1.3 system-ui,sans-serif;color:#111">MG Lead Exchange &mdash; Daily Error Report</div>
    <div style="font:400 12px/1.6 system-ui,sans-serif;color:#667">${esc(d.toISOString().slice(0,10))} ${esc(hhmm(d))} UTC &middot; rolling ${report.windowHours} hours</div>
  </div>
  <div style="padding:18px 24px">
    <table cellspacing="8" cellpadding="0" style="border-collapse:separate"><tr>
      ${stat('Open issues', report.openIssues.length)}
      ${stat('P1 critical', report.p1Open.length, report.p1Open.length ? '#b3261e' : '#111')}
      ${stat('Leads affected', report.affectedLeads)}
      ${stat('Recovered today', report.resolvedLeads, '#1e7a3c')}
      ${stat('Dealers', report.dealersAffected)}
    </tr></table>
  </div>
  ${report.openIssues.length === 0
    ? `<div style="padding:0 24px 24px;font:400 13px/1.7 system-ui,sans-serif;color:#1e7a3c">No open issues &mdash; everything raised in the last 24 hours has recovered.</div>`
    : `<table cellspacing="0" cellpadding="0" style="width:100%;border-collapse:collapse">
        <tr style="background:#fafbfc">
          <th style="text-align:left;padding:9px 10px;font:600 11px/1.6 system-ui,sans-serif;color:#667">SEVERITY</th>
          <th style="text-align:left;padding:9px 10px;font:600 11px/1.6 system-ui,sans-serif;color:#667">ISSUE &amp; AFFECTED ENQUIRIES</th>
          <th style="text-align:left;padding:9px 10px;font:600 11px/1.6 system-ui,sans-serif;color:#667">DEALER</th>
          <th style="text-align:right;padding:9px 10px;font:600 11px/1.6 system-ui,sans-serif;color:#667">OPEN</th>
          <th style="text-align:left;padding:9px 10px;font:600 11px/1.6 system-ui,sans-serif;color:#667">WINDOW UTC</th>
        </tr>${rows}
      </table>`}
  <div style="padding:14px 24px;border-top:1px solid #e3e6ea;font:400 11px/1.6 system-ui,sans-serif;color:#889">
    Generated automatically by Lead Exchange. Repeated retries of the same enquiry are grouped into one row.
  </div>
</div></body></html>`;
}

async function sendDailyErrorReport(catalystApp) {
  const report = await buildDailyErrorReport(catalystApp);

  const email = await integrationAlertService.sendDailyReportEmail(
    catalystApp,
    renderText(report),
    renderHtml(report)
  );

  logger.info(
    'dailyErrorReportService',
    `MG Daily Error Report — ${report.openIssues.length} open issue(s), ${report.p1Open.length} P1, ` +
    `${report.affectedLeads} lead(s) affected, ${report.resolvedLeads} recovered; emailSent=${email.sent}`
  );

  return {
    generatedAt: report.generatedAt.toISOString(),
    openIssues: report.openIssues.length,
    p1Open: report.p1Open.length,
    affectedLeads: report.affectedLeads,
    resolvedLeads: report.resolvedLeads,
    dealersAffected: report.dealersAffected,
    totalEvents: report.totalEvents,
    email,
  };
}

module.exports = { buildDailyErrorReport, sendDailyErrorReport, renderText, renderHtml };
