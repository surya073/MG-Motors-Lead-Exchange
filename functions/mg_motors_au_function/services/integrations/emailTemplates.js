'use strict';

/**
 * emailTemplates.js
 * -----------------------------------------------------------------------
 * One visual system for every email Lead Exchange sends: path alerts
 * (Unhappy 1-12, Happy 4 recovery), the daily error report and the test
 * alert. Email clients (Outlook in particular) ignore <style> blocks and
 * most modern CSS, so everything here is table-based with inline styles,
 * a 600px card and a system font stack. Every template returns both an
 * HTML and a plain-text part.
 */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

const COLORS = {
  ink: '#111418',
  body: '#3a4250',
  muted: '#6b7280',
  faint: '#9aa1ab',
  line: '#e5e7eb',
  canvas: '#f3f4f6',
  card: '#ffffff',
  panel: '#f9fafb',
  brandDark: '#16181c',
  brandRed: '#c8102e',
};

// Severity drives the badge, the accent bar and the subject tag.
const TONES = {
  P1: { label: 'P1 · Critical', fg: '#b3261e', bg: '#fdecea', bar: '#b3261e', tag: 'P1 CRITICAL' },
  P2: { label: 'P2 · High', fg: '#9a5800', bg: '#fff4e0', bar: '#e08a00', tag: 'P2' },
  P3: { label: 'P3 · Medium', fg: '#3f4b5b', bg: '#eef1f5', bar: '#64748b', tag: 'P3' },
  RECOVERED: { label: 'Recovered', fg: '#1e7a3c', bg: '#e7f5ec', bar: '#1e7a3c', tag: 'RECOVERED' },
  INFO: { label: 'Information', fg: '#1f5fad', bg: '#eaf1fb', bar: '#1f5fad', tag: 'INFO' },
};

// Where the "Open Lead Exchange" button points. Set LEAD_EXCHANGE_APP_URL
// per environment; the default is this project's Development client.
const APP_URL = process.env.LEAD_EXCHANGE_APP_URL
  || 'https://mg-motors-au-60069659585.development.catalystserverless.in/app/index.html#/lead-exchange';

/**
 * Per-path wording, from the Happy & Unhappy Path Register: a plain-English
 * headline, what it means for the enquiry, and what the reader should do.
 */
const PATH_GUIDE = {
  'Unhappy 1': {
    headline: 'Enquiry could not be delivered to the dealer CRM',
    summary: 'Lead Exchange could not reach the dealer CRM. The enquiry is retained and is being retried automatically.',
    actions: [
      'No action is needed while retries continue — the enquiry is delivered automatically once the dealer CRM responds (Happy 4).',
      'If failures persist, check the dealer CRM connection in Dealers → CRM Config and contact the dealer\'s IT provider.',
      'If it remains unresolved past the escalation window it becomes Unhappy 3 (critical).',
    ],
  },
  'Unhappy 2': {
    headline: 'Enquiry held — invalid or missing data',
    summary: 'The enquiry failed MG\'s mandatory-field validation and was not sent to the dealer.',
    actions: [
      'Correct the field(s) listed in Details on the enquiry in MG CRM.',
      'Once the data is valid the enquiry is delivered automatically — no re-entry needed.',
    ],
  },
  'Unhappy 3': {
    headline: 'Dealer unavailable — integration failure has not recovered',
    summary: 'The same delivery failure has continued past the escalation window. The affected enquiries are marked "Dealer Unavailable" in MG and are still being retried.',
    actions: [
      'Treat as critical: contact the dealer and their CRM provider now.',
      'Invoke the manual fallback — send the affected enquiries listed in Details to the dealer\'s shared inbox.',
      'Delivery resumes automatically once the dealer CRM is reachable; each enquiry then shows Happy 4.',
    ],
  },
  'Unhappy 4': {
    headline: 'Dealer update could not be applied to MG',
    summary: 'The dealer updated the enquiry but MG CRM was not updated, so MG\'s view is out of date. The update is held, not lost.',
    actions: [
      'Mapping failure (unmapped dealer status): approve a mapping in Dealers → CRM Config → Status mappings. The held update is applied automatically.',
      'Transport failure: no action — it is retried automatically.',
      'Validation failure at MG: correct the value in MG or the mapping, then it is re-applied.',
    ],
  },
  'Unhappy 5': {
    headline: 'Enquiry held — dealer routing or configuration problem',
    summary: 'The enquiry could not be routed to a correctly configured dealer integration and is held as a routing exception.',
    actions: [
      'Check the assigned dealer and its integration in Dealers → CRM Config (status, endpoints, field and status mappings).',
      'Held enquiries are re-sent automatically once the configuration is corrected.',
    ],
  },
  'Unhappy 6': {
    headline: 'Dealer attempted to change an MG-owned field',
    summary: 'The dealer\'s update touched a field MG owns. MG\'s value was kept and the dealer\'s value was held.',
    actions: [
      'Review the attempted change shown in Details with the dealer.',
      'No data was overwritten; no system action is required.',
    ],
  },
  'Unhappy 7': {
    headline: 'Dealer update arrived before its MG enquiry',
    summary: 'The dealer CRM sent an update for a record with no linked MG enquiry. It is held — never applied to the wrong enquiry.',
    actions: [
      'It is released automatically if the MG enquiry is linked.',
      'If the prerequisite never arrives, the event expires after the retention period with a final alert.',
      'A dealer record created directly in the dealer CRM (not from MG) will always end this way — check why it was created there.',
    ],
  },
  'Unhappy 8': {
    headline: 'Enquiry held — privacy consent missing or declined',
    summary: 'The enquiry does not carry a valid privacy-policy acceptance, so it was not shared with the dealer.',
    actions: [
      'Confirm the customer\'s privacy consent on the enquiry in MG CRM.',
      'Once consent is recorded the enquiry is delivered automatically.',
    ],
  },
  'Unhappy 9': {
    headline: 'Dealer marked a genuine MG enquiry as spam or junk',
    summary: 'The dealer classified the enquiry as spam/junk. This is flagged for investigation — ordinary Lost / Not Qualified outcomes never raise this alert.',
    actions: [
      'Ask the dealer why the enquiry was classified as spam/junk.',
      'If no one at the dealer did it, check the dealer CRM\'s spam or auto-classification rules — the lead may otherwise be lost silently.',
    ],
  },
  'Unhappy 10': {
    headline: 'Dealer has not actioned the enquiry within the SLA',
    summary: 'The enquiry was delivered and acknowledged, the integration is healthy, but the dealer has not acted on it. MG status is now "Unattended Alert".',
    actions: [
      'Follow up with the dealer to action the enquiry.',
      'The alert clears automatically as soon as the dealer progresses the enquiry in their CRM.',
    ],
  },
  'Unhappy 11': {
    headline: 'Cross-system mismatch found by reconciliation',
    summary: 'MG shows the enquiry as delivered, but the dealer CRM record is missing or was never confirmed. Reconciliation is re-delivering it safely.',
    actions: [
      'No action while re-delivery succeeds — the enquiry is reconciled automatically (Happy 1).',
      'If it is reported as unresolved, the named owner investigates the mismatch.',
    ],
  },
  'Unhappy 12': {
    headline: 'Dealer CRM migration or offboarding',
    summary: 'An enquiry is affected by a dealer changing CRM or leaving the network.',
    actions: ['Review the reassignment in MG and confirm the enquiry reached the new dealer.'],
  },
  'Happy 4': {
    headline: 'Integration recovered — enquiry delivered',
    summary: 'An enquiry that failed during a dealer outage has now been delivered to the dealer CRM. Its failure history is kept on the timeline.',
    actions: ['No action required.'],
  },
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** "24 Sep 2026, 10:15 am AEST · 00:15 UTC" — MG is in Australia. */
function formatWhen(date = new Date()) {
  const utc = `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')} UTC`;
  try {
    const local = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Melbourne',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
    return `${local} · ${utc}`;
  } catch (err) {
    return `${date.toISOString().slice(0, 10)} ${utc}`;
  }
}

function toneFor({ scenarioCode, priority }) {
  if (/^Happy/i.test(scenarioCode || '')) return TONES.RECOVERED;
  return TONES[priority] || TONES.P2;
}

/** Splits "a; b; c" detail strings into separate readable points. */
function reasonPoints(reason) {
  if (!reason) return [];
  const text = String(reason).trim();
  const parts = text.split(/;\s+/).map((part) => part.trim()).filter(Boolean);
  const capitalise = (part) => part.charAt(0).toUpperCase() + part.slice(1);
  return (parts.length > 1 ? parts : [text]).map(capitalise);
}

function badge(tone, text) {
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${tone.bg};color:${tone.fg};font:600 11px/1.6 ${FONT};letter-spacing:.02em">${esc(text)}</span>`;
}

function button(href, label) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td style="border-radius:6px;background:${COLORS.brandDark}">
      <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:11px 22px;font:600 14px/1.2 ${FONT};color:#ffffff;text-decoration:none;border-radius:6px">${esc(label)}</a>
    </td></tr></table>`;
}

function factRows(facts) {
  return facts
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value], index) => `
      <tr>
        <td style="padding:9px 14px;${index ? `border-top:1px solid ${COLORS.line};` : ''}width:38%;font:500 13px/1.5 ${FONT};color:${COLORS.muted};vertical-align:top">${esc(label)}</td>
        <td style="padding:9px 14px;${index ? `border-top:1px solid ${COLORS.line};` : ''}font:600 13px/1.5 ${FONT};color:${COLORS.ink};vertical-align:top;word-break:break-word">${esc(value)}</td>
      </tr>`)
    .join('');
}

function section(title, innerHtml) {
  return `<tr><td style="padding:0 32px 24px">
    <div style="font:700 11px/1.4 ${FONT};color:${COLORS.muted};letter-spacing:.08em;text-transform:uppercase;margin:0 0 10px">${esc(title)}</div>
    ${innerHtml}
  </td></tr>`;
}

function bulletList(items, color = COLORS.body) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${items.map((item) => `
    <tr>
      <td style="width:16px;vertical-align:top;padding:2px 0;font:400 14px/1.6 ${FONT};color:${COLORS.faint}">&bull;</td>
      <td style="vertical-align:top;padding:2px 0;font:400 14px/1.6 ${FONT};color:${color}">${esc(item)}</td>
    </tr>`).join('')}</table>`;
}

/**
 * The shared shell: preheader, dark MG header with red accent, severity
 * accent bar, content rows, footer.
 */
function layout({ preheader, tone, eyebrow, title, summary, rowsHtml, width = 600 }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.canvas};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader || summary || '')}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${COLORS.canvas}">
<tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:${width}px">
    <tr><td style="background:${COLORS.brandDark};border-radius:10px 10px 0 0;padding:18px 32px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
        <td style="font:800 16px/1 ${FONT};color:#ffffff;letter-spacing:.06em">MG <span style="font-weight:500;letter-spacing:.02em;color:#d1d5db">Lead Exchange</span></td>
        <td align="right" style="font:500 11px/1 ${FONT};color:#9ca3af;letter-spacing:.04em">INTEGRATION ALERTS</td>
      </tr></table>
    </td></tr>
    <tr><td style="height:3px;line-height:3px;font-size:0;background:${COLORS.brandRed}">&nbsp;</td></tr>
    <tr><td style="background:${COLORS.card};border-left:1px solid ${COLORS.line};border-right:1px solid ${COLORS.line}">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td style="padding:28px 32px 6px;border-left:4px solid ${tone.bar}">
          <div style="margin:0 0 12px">${badge(tone, eyebrow)}</div>
          <div style="font:700 21px/1.35 ${FONT};color:${COLORS.ink};margin:0 0 8px">${esc(title)}</div>
          ${summary ? `<div style="font:400 15px/1.6 ${FONT};color:${COLORS.body};margin:0 0 20px">${esc(summary)}</div>` : ''}
        </td></tr>
        ${rowsHtml}
      </table>
    </td></tr>
    <tr><td style="background:${COLORS.panel};border:1px solid ${COLORS.line};border-top:none;border-radius:0 0 10px 10px;padding:18px 32px">
      <div style="font:400 12px/1.6 ${FONT};color:${COLORS.muted}">This is an automated message from MG Lead Exchange. Please do not reply to this email.</div>
      <div style="font:400 12px/1.6 ${FONT};color:${COLORS.faint}">MG Motor Australia &middot; Lead Exchange middleware &middot; Operated with FI Digital</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

function textBlock({ heading, lines }) {
  return [heading.toUpperCase(), ...lines.map((line) => `  ${line}`)].join('\n');
}

/**
 * Path alert (every Unhappy path, the Happy 4 recovery notice and
 * operational alerts such as a failed reconciliation run).
 */
function renderAlertEmail({
  scenarioCode,
  scenarioMessage,
  priority,
  dealerCode,
  leadId,
  customerName,
  reason,
  occurredAt = new Date(),
}) {
  const tone = toneFor({ scenarioCode, priority });
  const guide = PATH_GUIDE[scenarioCode] || {};
  const headline = guide.headline || scenarioMessage || scenarioCode;
  const summary = guide.summary || '';
  const when = formatWhen(occurredAt);
  const maskedCustomer = customerName ? `${String(customerName).trim().slice(0, 1)}***` : '';
  const points = reasonPoints(reason);
  const actions = guide.actions || [];
  const isHappy = /^Happy/i.test(scenarioCode || '');

  const facts = [
    ['Path', `${scenarioCode} — ${scenarioMessage || headline}`],
    ['Priority', isHappy ? 'Resolved' : (priority || '—')],
    ['Dealer', dealerCode],
    ['MG enquiry ID', leadId],
    ['Customer', maskedCustomer],
    ['Detected', when],
  ];

  const rowsHtml = [
    section('Key facts', `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${COLORS.line};border-radius:8px;border-collapse:separate">${factRows(facts)}</table>`),
    points.length ? section('Details', `<div style="background:${COLORS.panel};border:1px solid ${COLORS.line};border-radius:8px;padding:12px 14px">${bulletList(points)}</div>`) : '',
    actions.length ? section('What to do next', bulletList(actions, COLORS.ink)) : '',
    `<tr><td style="padding:0 32px 30px">${button(APP_URL, 'Open Lead Exchange')}</td></tr>`,
  ].join('');

  // Short and scannable in an inbox list; customer data stays out of the
  // subject line.
  const subject = `[${tone.tag}] ${scenarioCode}: ${scenarioMessage || headline}${dealerCode ? ` · ${dealerCode}` : ''}`;

  const html = layout({
    preheader: `${scenarioCode}${dealerCode ? ` · ${dealerCode}` : ''} — ${summary || headline}`,
    tone,
    eyebrow: `${isHappy ? 'Recovered' : tone.label} · ${scenarioCode}`,
    title: headline,
    summary,
    rowsHtml,
  });

  const text = [
    `MG LEAD EXCHANGE — ${scenarioCode.toUpperCase()} (${isHappy ? 'RECOVERED' : (priority || 'ALERT')})`,
    headline,
    summary,
    '',
    textBlock({
      heading: 'Key facts',
      lines: facts.filter(([, v]) => v).map(([label, value]) => `${label}: ${value}`),
    }),
    points.length ? `\n${textBlock({ heading: 'Details', lines: points.map((p) => `- ${p}`) })}` : '',
    actions.length ? `\n${textBlock({ heading: 'What to do next', lines: actions.map((a) => `- ${a}`) })}` : '',
    '',
    `Open Lead Exchange: ${APP_URL}`,
    '',
    'Automated message from MG Lead Exchange — please do not reply.',
  ].filter((line) => line !== '').join('\n');

  return { subject, html, text };
}

/** Confirms the alert channel works end to end. */
function renderTestEmail({ sentAt = new Date(), channel } = {}) {
  const tone = TONES.INFO;
  const when = formatWhen(sentAt);
  const rowsHtml = [
    section('Channel check', `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid ${COLORS.line};border-radius:8px;border-collapse:separate">${factRows([
      ['Status', 'Delivered'],
      ['Sent', when],
      ['Channel', channel || 'Configured mail channel'],
    ])}</table>`),
    section('What this means', bulletList([
      'Immediate Unhappy-path alerts will reach this inbox without anyone logging into Lead Exchange.',
      'The 12pm daily error report is delivered through the same channel.',
    ])),
    `<tr><td style="padding:0 32px 30px">${button(APP_URL, 'Open Lead Exchange')}</td></tr>`,
  ].join('');

  return {
    subject: '[INFO] Lead Exchange alert channel test',
    html: layout({
      preheader: 'Your Lead Exchange alert channel is working.',
      tone,
      eyebrow: 'Information · Test alert',
      title: 'Alert channel is working',
      summary: 'This is a test message confirming that Lead Exchange can deliver alerts to this inbox.',
      rowsHtml,
    }),
    text: [
      'MG LEAD EXCHANGE — TEST ALERT',
      'Alert channel is working.',
      '',
      `Sent: ${when}`,
      'Immediate Unhappy-path alerts and the 12pm daily error report will reach this inbox.',
      '',
      `Open Lead Exchange: ${APP_URL}`,
    ].join('\n'),
  };
}

module.exports = {
  renderAlertEmail,
  renderTestEmail,
  layout,
  section,
  bulletList,
  badge,
  button,
  esc,
  formatWhen,
  FONT,
  COLORS,
  TONES,
  APP_URL,
  PATH_GUIDE,
};
