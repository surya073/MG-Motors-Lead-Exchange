'use strict';

const logger = require('../../utils/logger');
const integrationAlertService = require('./integrationAlertService');
const emailTemplates = require('./emailTemplates');
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
  const { layout, section, esc: e, formatWhen, FONT, COLORS, TONES, APP_URL, button, PATH_GUIDE } = emailTemplates;
  const tone = report.p1Open.length ? TONES.P1 : (report.openIssues.length ? TONES.P2 : TONES.RECOVERED);

  const tile = (label, value, color) => `
    <td width="25%" style="padding:4px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${COLORS.line};border-radius:8px;border-collapse:separate">
        <tr><td style="padding:12px 12px 2px;font:700 22px/1.1 ${FONT};color:${color || COLORS.ink}">${e(value)}</td></tr>
        <tr><td style="padding:0 12px 12px;font:500 11px/1.4 ${FONT};color:${COLORS.muted}">${e(label)}</td></tr>
      </table>
    </td>`;

  const tiles = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
      ${tile('Open issues', report.openIssues.length)}
      ${tile('P1 critical', report.p1Open.length, report.p1Open.length ? TONES.P1.fg : COLORS.ink)}
      ${tile('Enquiries affected', report.affectedLeads)}
      ${tile('Recovered', report.resolvedLeads, TONES.RECOVERED.fg)}
    </tr></table>`;

  const issueCard = (issue) => {
    const issueTone = TONES[issue.priority] || TONES.P3;
    const headline = (PATH_GUIDE[issue.scenario] && PATH_GUIDE[issue.scenario].headline) || issue.scenario;
    const leads = describeLeads(issue, report.leadInfo);
    return `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${COLORS.line};border-left:4px solid ${issueTone.bar};border-radius:8px;border-collapse:separate;margin:0 0 12px">
        <tr><td style="padding:14px 16px">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
            <td style="font:700 11px/1.6 ${FONT};color:${issueTone.fg};letter-spacing:.04em">${e(issue.priority || 'UNCLASSIFIED')} &middot; ${e(issue.scenario)} &middot; DEALER ${e(issue.dealer)}</td>
            <td align="right" style="font:700 13px/1.6 ${FONT};color:${COLORS.ink};white-space:nowrap">${e(issue.openLeads.length)} open${issue.resolvedCount ? ` <span style="font-weight:500;color:${TONES.RECOVERED.fg}">&middot; ${e(issue.resolvedCount)} recovered</span>` : ''}</td>
          </tr></table>
          <div style="font:600 15px/1.45 ${FONT};color:${COLORS.ink};margin:4px 0 4px">${e(headline)}</div>
          <div style="font:400 13px/1.55 ${FONT};color:${COLORS.body};margin:0 0 8px">${e(issue.reason)}</div>
          <div style="font:400 12px/1.6 ${FONT};color:${COLORS.muted}">${leads.map(e).join(' &nbsp;&middot;&nbsp; ')}</div>
          <div style="font:400 11px/1.6 ${FONT};color:${COLORS.faint};margin-top:6px">${e(hhmm(issue.firstAt))}&ndash;${e(hhmm(issue.lastAt))} UTC &middot; ${e(issue.occurrences)} event(s)</div>
        </td></tr>
      </table>`;
  };

  const recovered = report.issues.filter((i) => i.resolvedCount > 0 && i.openLeads.length === 0);

  const rowsHtml = [
    section('Summary', tiles),
    report.openIssues.length
      ? section('Open issues — most urgent first', report.openIssues.map(issueCard).join(''))
      : section('Open issues', `<div style="background:${TONES.RECOVERED.bg};border-radius:8px;padding:14px 16px;font:500 14px/1.6 ${FONT};color:${TONES.RECOVERED.fg}">No open issues — everything raised in the last ${e(report.windowHours)} hours has recovered.</div>`),
    recovered.length
      ? section('Resolved during the day', recovered.map((issue) => `<div style="font:400 13px/1.7 ${FONT};color:${COLORS.body}">&#10003; ${e(issue.scenario)} &middot; dealer ${e(issue.dealer)} &middot; ${e(issue.resolvedCount)} enquir${issue.resolvedCount === 1 ? 'y' : 'ies'} recovered</div>`).join(''))
      : '',
    `<tr><td style="padding:0 32px 30px">${button(APP_URL, 'Open Lead Exchange')}</td></tr>`,
  ].join('');

  const summary = report.openIssues.length
    ? `${report.openIssues.length} open issue(s) across ${report.dealersAffected} dealer(s), affecting ${report.affectedLeads} enquir${report.affectedLeads === 1 ? 'y' : 'ies'}${report.p1Open.length ? ` — ${report.p1Open.length} critical` : ''}. Repeated retries of the same enquiry are grouped.`
    : 'All clear — no open integration issues in the last 24 hours.';

  return layout({
    preheader: summary,
    tone,
    eyebrow: `Daily error report · ${formatWhen(report.generatedAt)}`,
    title: 'MG Daily Error Report',
    summary,
    rowsHtml,
    width: 640,
  });
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
