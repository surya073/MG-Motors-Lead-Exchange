'use strict';

const XLSX = require('xlsx');
const logger = require('../utils/logger');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_TEXT_CHARACTERS = 8000;

const GEMINI_API_KEY = process.env.gemini_api_key; // matches catalyst-config.json's env var name (lowercase)
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

/**
 * onDemandAiService.js
 * -----------------------------------------------------------------------
 * Powers the On-Demand Dashboard's two AI features:
 *
 *   1. analyzeUploadedFile — reads an arbitrary PDF/Excel/CSV and asks
 *      Gemini to propose KPIs/charts/insights from it. This genuinely
 *      needs AI because the file's structure isn't known ahead of time.
 *
 *   2. askAssistant — free-form chat grounded in a text summary of the
 *      live app data (dealers/leads/sync_logs) plus, if present, the
 *      most recently analyzed uploaded file.
 *
 * Live "Use App Data" KPIs deliberately do NOT go through Gemini — see
 * onDemandDashboardRoutes.js's GET /on-demand/summary, which reuses
 * adminDashboardService.getDashboardSummary directly. That schema is
 * already known, so aggregating it exactly is both cheaper and more
 * trustworthy than asking an LLM to re-derive numbers we can compute.
 */

async function callGemini(contents, { maxOutputTokens = 1024, temperature = 0.2 } = {}) {
  if (!GEMINI_API_KEY) {
    throw new Error("gemini_api_key is not set in this function's environment variables");
  }

  const response = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, generationConfig: { temperature, maxOutputTokens } }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function parseJsonSafe(text, fallback) {
  try {
    const stripped = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(stripped);
  } catch (err) {
    return fallback;
  }
}

/**
 * Extracts a compact text/table representation of an uploaded file so
 * it can be handed to Gemini as plain text rather than sending binary.
 * PDF branch requires the `pdf-parse` package — see the note below.
 */
async function extractFileText(base64Data, fileName) {
  if (typeof base64Data !== 'string' || typeof fileName !== 'string') {
    throw Object.assign(new Error('A base64 file and file name are required'), { code: 'INVALID_UPLOAD' });
  }
  if (!/\.(pdf|xlsx|xls|csv)$/i.test(fileName)) {
    throw Object.assign(new Error('Supported file types are PDF, XLSX, XLS and CSV'), { code: 'INVALID_UPLOAD' });
  }
  if (base64Data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
    throw Object.assign(new Error('File must be no larger than 10 MB'), { code: 'UPLOAD_TOO_LARGE' });
  }
  const buf = Buffer.from(base64Data, 'base64');
  if (!buf.length || buf.length > MAX_FILE_BYTES) {
    throw Object.assign(new Error('File is empty or larger than 10 MB'), { code: 'INVALID_UPLOAD' });
  }
  const isSheet = /\.(xlsx|xls|csv)$/i.test(fileName || '');

  if (isSheet) {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, sheetRows: 60 });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw Object.assign(new Error('The spreadsheet contains no sheets'), { code: 'INVALID_UPLOAD' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
    // Cap what we send to Gemini — first 60 rows is plenty for KPI/trend inference
    const capped = rows.slice(0, 60).map((r) => r.join(' | ')).join('\n');
    const reference = wb.Sheets[sheetName]['!fullref'] || wb.Sheets[sheetName]['!ref'];
    const totalRows = reference ? XLSX.utils.decode_range(reference).e.r + 1 : rows.length;
    return {
      kind: 'sheet', rowCount: Math.max(totalRows - 1, 0),
      text: capped.slice(0, MAX_FILE_TEXT_CHARACTERS),
      sampled: totalRows > rows.length || capped.length > MAX_FILE_TEXT_CHARACTERS,
    };
  }

  let PDFParse;
  try {
    // eslint-disable-next-line global-require
    ({ PDFParse } = require('pdf-parse'));
  } catch (err) {
    throw new Error('PDF parsing requires the "pdf-parse" package — run: npm install pdf-parse');
  }
  const parser = new PDFParse({ data: new Uint8Array(buf), isEvalSupported: false });
  try {
    const result = await parser.getText();
    return { kind: 'pdf', rowCount: null, text: result.text.slice(0, MAX_FILE_TEXT_CHARACTERS), sampled: result.text.length > MAX_FILE_TEXT_CHARACTERS };
  } finally {
    // Parsing errors retain their original cause even if worker cleanup fails.
    await parser.destroy().catch((err) => logger.error('onDemandAiService', 'PDF worker cleanup failed', err));
  }
}

async function analyzeUploadedFile(base64Data, fileName) {
  const extracted = await extractFileText(base64Data, fileName);

  const prompt = `You analyze a business report (${extracted.kind === 'sheet' ? 'a spreadsheet' : 'a PDF document'}) for the MG Motor dealer network dashboard and respond with ONLY valid JSON, no markdown fences, in exactly this shape:
{
  "summary": "1-2 sentence plain-English summary of what this file contains",
  "insights": ["short insight 1", "short insight 2", "short insight 3"],
  "suggestedKpis": [{ "label": "KPI name", "value": "KPI value as a string" }],
  "charts": [
    { "type": "bar" | "line" | "donut", "title": "Chart title", "data": [{ "label": "x", "value": 0 }] }
  ]
}
Rules:
- Base every number strictly on the data below — never invent figures.
- insights: 3-5 short, concrete, specific observations (trends, outliers, concentration, anomalies).
- charts: 1-3 charts genuinely supported by the data's columns/rows.
- If the data doesn't support a field, return an empty array for it — do not fabricate.

FILE: ${fileName}
${extracted.kind === 'sheet' ? `ROWS: ${extracted.rowCount}` : ''}
${extracted.sampled ? 'DATA IS A SAMPLE: some rows or text were omitted. Describe only visible data; do not infer whole-file totals from this sample.' : ''}
DATA:
${extracted.text}`;

  const raw = await callGemini([{ role: 'user', parts: [{ text: prompt }] }], { maxOutputTokens: 1536 });

  return parseJsonSafe(raw, {
    summary: 'AI could not fully parse this file — showing raw structure only.',
    insights: [],
    suggestedKpis: [],
    charts: [],
  });
}

/**
 * Builds a compact text summary of live app data for the assistant's
 * grounding context. `summary` is the object returned by
 * adminDashboardService.getDashboardSummary.
 */
function buildAppDataContext(summary) {
  if (!summary) return 'No live app data loaded in this conversation.';
  const { totalDealers, totalLeads, leadStatusSummary, topDealers } = summary;
  const topDealerLines = (topDealers || [])
    .map((d, i) => `  ${i + 1}. ${d.name} (${d.region}) — ${d.total_leads} leads, ${d.conversion_rate}% conversion`)
    .join('\n');

  return `LIVE APP DATA SNAPSHOT
Total dealers: ${totalDealers}
Total leads: ${totalLeads}
Lead status breakdown: new ${leadStatusSummary?.new}, contacted ${leadStatusSummary?.contacted}, test drive ${leadStatusSummary?.test_drive}, quotation ${leadStatusSummary?.quotation}, delivered ${leadStatusSummary?.delivered}, lost ${leadStatusSummary?.lost}
Top dealers by lead volume:
${topDealerLines || '  (none)'}`;
}

async function askAssistant(question, { appDataSummary, uploadedFileSummary, history } = {}) {
  const systemInstruction = `You are the AI assistant inside MG Motor's On-Demand Dashboard. Answer questions about the dealer network using ONLY the data below — never invent numbers. Be concise and specific.

${buildAppDataContext(appDataSummary)}

${uploadedFileSummary ? `UPLOADED FILE SUMMARY\n${uploadedFileSummary}` : 'No file has been uploaded in this conversation yet.'}`;

  const contents = [
    { role: 'user', parts: [{ text: systemInstruction }] },
    { role: 'model', parts: [{ text: 'Understood — I will answer using only the data provided above.' }] },
  ];

  (history || []).forEach((msg) => {
    contents.push({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.text }] });
  });
  contents.push({ role: 'user', parts: [{ text: question }] });

  const reply = await callGemini(contents, { maxOutputTokens: 512, temperature: 0.3 });
  return reply.trim() || 'I could not generate a response.';
}

module.exports = {
  analyzeUploadedFile,
  askAssistant,
  buildAppDataContext,
  _test: { extractFileText },
};
