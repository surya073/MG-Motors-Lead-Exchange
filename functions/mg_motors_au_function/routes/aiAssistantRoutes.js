'use strict';

const express = require('express');
const multer = require('multer');
const { normalizeRole, APP_ROLES } = require('../constants/roles.constants');
const { getAiAssistantConfig } = require('../config/env');
const aiTools = require('../services/aiAssistantToolService');
const logger = require('../utils/logger');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const { geminiApiKey: GEMINI_API_KEY, geminiModel: GEMINI_MODEL, sarvamApiKey: SARVAM_API_KEY } = getAiAssistantConfig();
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Admin/Super Admin/View User all get the same read-only "admin" tool
 * scope here — matches the requireAdminOrViewRole convention used across
 * the rest of this app (view access, not a mutation boundary). Dealer
 * resolves its own dealer_code via the real session-bound lookup
 * (leadAccessService.resolveDealerCodeForUser, the same mechanism
 * dealerLeadRoutes.js uses) rather than an ad hoc email match.
 */
async function resolveAiContext(catalystApp, currentUser) {
  const role = normalizeRole(currentUser);

  if (role === APP_ROLES.SUPER_ADMIN || role === APP_ROLES.ADMIN || role === APP_ROLES.VIEW_USER) {
    return { role: 'admin', dealerCode: null, dealerName: null };
  }

  if (role === APP_ROLES.DEALER) {
    const dealerCode = await aiTools.resolveDealerCodeForUser(catalystApp, currentUser.user_id);
    if (!dealerCode) return { role: 'unknown', dealerCode: null, dealerName: null };
    const { dealer } = await aiTools.resolveDealerByNameOrCode(catalystApp, dealerCode);
    return { role: 'dealer', dealerCode, dealerName: dealer?.dealer_name || null };
  }

  return { role: 'unknown', dealerCode: null, dealerName: null };
}

/* ------------------------------------------------------------------ */
/* Gemini tool declarations + dispatcher                               */
/* ------------------------------------------------------------------ */

const ADMIN_TOOLS = [
  { name: 'get_dashboard_summary', description: 'Network-wide dealer/lead totals and status breakdown — use for general "how are we doing" / "give me a summary" questions.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'get_dealers', description: 'Search/list dealers in the network.', parameters: { type: 'OBJECT', properties: { search: { type: 'STRING', description: 'Optional name/region/status/code filter.' } } } },
  { name: 'get_dealer_detail', description: 'Profile, lead count and status breakdown for one dealer (by name or code).', parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' } }, required: ['dealerName'] } },
  { name: 'get_dealer_leads', description: "List a dealer's leads (by name or code), optionally filtered by the real MG lead status.", parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' }, leadStatus: { type: 'STRING', description: 'A real Lead_Status value, e.g. "Not Qualified", "Contacted", "Follow-up 1".' } }, required: ['dealerName'] } },
  { name: 'get_lead_detail', description: 'Look up a single lead network-wide by its ID or a customer-name match — includes status, dealer, and its full sync/integration timeline.', parameters: { type: 'OBJECT', properties: { leadIdOrCustomerName: { type: 'STRING' } }, required: ['leadIdOrCustomerName'] } },
  { name: 'get_happy_unhappy_summary', description: 'Happy/Unhappy path breakdown (counts per scenario), duplicate-lead totals, SLA status, and dealer health. Optionally scope to one dealer, one date range or relative period ("today", "yesterday", "this week", a month name), or one specific scenario code ("Happy 3", "Unhappy 7").', parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' }, when: { type: 'STRING', description: '"today" | "yesterday" | "this week" | a month name' }, fromDate: { type: 'STRING', description: 'YYYY-MM-DD, overrides `when` if given' }, toDate: { type: 'STRING', description: 'YYYY-MM-DD' }, scenarioCode: { type: 'STRING', description: 'e.g. "Happy 1".."Happy 5", "Unhappy 1".."Unhappy 12"' } } } },
  { name: 'get_duplicate_leads', description: 'List recently detected duplicate leads (Happy 3), optionally scoped to a dealer or period.', parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' }, when: { type: 'STRING' } } } },
  { name: 'get_sla_breaches', description: 'SLA breach history plus leads CURRENTLY sitting in breach, optionally scoped to a dealer or period.', parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' }, when: { type: 'STRING' } } } },
  { name: 'get_out_of_order_events', description: 'Unhappy 7 — dealer updates that arrived before their enquiry existed in MG\'s system, held for replay.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'get_integration_logs', description: 'Drill down into raw integration error/event logs, optionally filtered by dealer, date range, scenario code, or status (SUCCESS/FAILED).', parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' }, scenarioCode: { type: 'STRING' }, status: { type: 'STRING' }, fromDate: { type: 'STRING' }, toDate: { type: 'STRING' } } } },
];

const DEALER_TOOLS = [
  { name: 'get_my_leads', description: "List the current dealer's own leads, optionally filtered by the real MG lead status.", parameters: { type: 'OBJECT', properties: { leadStatus: { type: 'STRING' } } } },
  { name: 'get_my_lead_detail', description: "Look up one of the current dealer's own leads by ID or customer name — includes status and its sync timeline.", parameters: { type: 'OBJECT', properties: { leadIdOrCustomerName: { type: 'STRING' } }, required: ['leadIdOrCustomerName'] } },
  { name: 'get_my_happy_unhappy_summary', description: "Happy/Unhappy path breakdown for the current dealer's own leads only, optionally scoped to a period or one scenario code.", parameters: { type: 'OBJECT', properties: { when: { type: 'STRING' }, scenarioCode: { type: 'STRING' } } } },
  { name: 'get_my_sla_status', description: "SLA breach history and current breaches for the current dealer's own leads only.", parameters: { type: 'OBJECT', properties: { when: { type: 'STRING' } } } },
];

async function runTool(catalystApp, ctx, name, args) {
  try {
    if (ctx.role === 'admin') {
      switch (name) {
        case 'get_dashboard_summary': return await aiTools.getDashboardSummary(catalystApp);
        case 'get_dealers': return await aiTools.getDealers(catalystApp, args.search);
        case 'get_dealer_detail': return await aiTools.getDealerDetail(catalystApp, args.dealerName);
        case 'get_dealer_leads': return await aiTools.getDealerLeads(catalystApp, args.dealerName, { leadStatus: args.leadStatus });
        case 'get_lead_detail': return await aiTools.getLeadDetailByIdentifier(catalystApp, args.leadIdOrCustomerName);
        case 'get_happy_unhappy_summary': return await aiTools.getHappyUnhappySummary(catalystApp, args);
        case 'get_duplicate_leads': return await aiTools.getDuplicateLeads(catalystApp, args);
        case 'get_sla_breaches': return await aiTools.getSlaBreaches(catalystApp, args);
        case 'get_out_of_order_events': {
          const events = await aiTools.getOutOfOrderEvents(catalystApp);
          return { count: events.length, events };
        }
        case 'get_integration_logs': {
          let dealerCode;
          if (args.dealerName) {
            const { dealer } = await aiTools.resolveDealerByNameOrCode(catalystApp, args.dealerName);
            if (!dealer) return { error: `No dealer found matching "${args.dealerName}".` };
            dealerCode = dealer.dealer_code;
          }
          return await aiTools.getIntegrationLogs(catalystApp, { ...args, dealerCode });
        }
        default: return { error: `Unknown tool ${name}` };
      }
    }
    if (ctx.role === 'dealer') {
      switch (name) {
        case 'get_my_leads': return await aiTools.getMyLeads(catalystApp, ctx.dealerCode, { leadStatus: args.leadStatus });
        case 'get_my_lead_detail': return await aiTools.getLeadDetailByIdentifier(catalystApp, args.leadIdOrCustomerName, { dealerCodeScope: ctx.dealerCode });
        case 'get_my_happy_unhappy_summary': return await aiTools.getHappyUnhappySummary(catalystApp, { ...args, dealerCode: ctx.dealerCode });
        case 'get_my_sla_status': return await aiTools.getSlaBreaches(catalystApp, { ...args, dealerCode: ctx.dealerCode });
        default: return { error: `Unknown tool ${name}` };
      }
    }
    return { error: "Could not confirm your account role, so live data lookups aren't available right now." };
  } catch (err) {
    logger.error('aiAssistantRoutes', `tool ${name} failed`, err);
    return { error: "I couldn't retrieve that data right now." };
  }
}

function systemPromptFor(ctx) {
  const base = 'You are the MG Motor Lead Exchange AI assistant, embedded in the dealer management dashboard. '
    + 'Answer concisely and in plain language, using the tools to fetch real data instead of guessing. '
    + 'Dates from tools are timestamps in the platform\'s stored format — describe them in relative, human terms '
    + '(e.g. "3 days ago") when that helps. If a tool returns an error, say so plainly instead of inventing an answer. '
    + 'If a request is genuinely ambiguous (e.g. "show me the leads" with no dealer or status given), ask one short '
    + 'clarifying question instead of guessing — but if the conversation already makes the intent clear, just answer. '
    + 'Each tool call is a real network + database round trip, so call only the tools you actually need: for a broad '
    + '"summary" style question, one summary-shaped tool (get_dashboard_summary, or get_happy_unhappy_summary if the '
    + "question is about paths/duplicates/SLA/today/this week) is normally enough — don't chain a second broad tool "
    + 'just to pad the answer. Chain multiple tools only when the question genuinely needs data from more than one '
    + '(e.g. a specific dealer\'s Happy/Unhappy breakdown needs a dealer lookup plus the path summary for that dealer). '
    + 'Never reveal internal IDs, table names, or API details.';

  if (ctx.role === 'admin') {
    return `${base} You are talking to a network admin/view-only user. They can ask about any dealer, any dealer's `
      + 'leads, individual lead detail and timelines, Happy/Unhappy path counts (there are 5 Happy and 12 Unhappy '
      + 'scenarios, e.g. "Unhappy 10" is an SLA breach and "Happy 3" is a detected duplicate), integration health, '
      + 'duplicate leads, SLA breaches, and out-of-order events.';
  }
  if (ctx.role === 'dealer') {
    return `${base} You are talking to ${ctx.dealerName || 'a dealer'}. They can only see their own leads — never `
      + "imply you can show another dealer's data. They can ask about their own leads, lead statuses, Happy/Unhappy "
      + 'path activity, and SLA status, plus general questions about how the portal works.';
  }
  return `${base} This user's role could not be confirmed, so data tools are unavailable — help only with general questions about how the portal works.`;
}

/* ------------------------------------------------------------------ */
/* Gemini call loop                                                    */
/* ------------------------------------------------------------------ */

/**
 * NOTE: an earlier version of this function streamed via
 * :streamGenerateContent?alt=sse for token-by-token rendering. That broke
 * every query in production (every reply fell through to "I couldn't find
 * an answer to that.", including plain greetings needing no tool call at
 * all) in a way that couldn't be diagnosed without live server logs this
 * environment doesn't have access to, so it was reverted back to this
 * known-working one-shot call. Do not reintroduce streaming here without a
 * way to verify the SSE parsing against Gemini's actual response shape
 * first.
 */
async function callGemini({ systemPrompt, contents, tools }) {
  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: tools.length ? [{ functionDeclarations: tools }] : undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`Gemini API error (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

function historyToContents(history = []) {
  return history.slice(-10).map((h) => ({
    role: h.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: h.text }],
  }));
}

async function runAssistant(catalystApp, ctx, message, history) {
  const tools = ctx.role === 'admin' ? ADMIN_TOOLS : ctx.role === 'dealer' ? DEALER_TOOLS : [];
  const systemPrompt = systemPromptFor(ctx);
  const contents = [...historyToContents(history), { role: 'user', parts: [{ text: message }] }];

  for (let step = 0; step < 4; step++) {
    const data = await callGemini({ systemPrompt, contents, tools });
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCallPart = parts.find((p) => p.functionCall);

    if (!functionCallPart) {
      const text = parts.map((p) => p.text || '').join('').trim();
      return text || "I couldn't find an answer to that.";
    }

    const { name, args } = functionCallPart.functionCall;
    const rawResult = await runTool(catalystApp, ctx, name, args || {});
    // Gemini's function_response.response field must be a JSON object —
    // it rejects a bare array with a 400 ("Proto field is not repeating,
    // cannot start list"). Every tool above already returns an object,
    // but this guard makes that a guarantee rather than a convention any
    // future tool could silently break.
    const result = Array.isArray(rawResult) ? { items: rawResult } : rawResult;

    // Push the model's turn back exactly as returned — Gemini 3 attaches
    // a thoughtSignature to each functionCall part and rejects the next
    // step if it isn't echoed back unchanged.
    contents.push({ role: 'model', parts });
    contents.push({ role: 'function', parts: [{ functionResponse: { name, response: result } }] });
  }

  return 'That took more steps than I could complete — try asking a more specific question.';
}

/* ------------------------------------------------------------------ */
/* Sarvam voice helpers                                                */
/* ------------------------------------------------------------------ */

async function transcribeSpeech(buffer, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/webm' }), 'audio.webm');
  form.append('model', 'saaras:v3');
  form.append('language_code', 'en-IN');

  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_API_KEY },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Sarvam STT error (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.transcript || '';
}

async function synthesizeSpeech(text) {
  try {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: {
        'api-subscription-key': SARVAM_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text.slice(0, 2500),
        target_language_code: 'en-IN',
        model: 'bulbul:v3',
        speaker: 'shubh', // bulbul:v3 voice — 'anushka' is v2-only
      }),
    });
    if (!res.ok) {
      console.error('Sarvam TTS error', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return data.audios?.[0] || null;
  } catch (err) {
    console.error('Sarvam TTS request failed:', err);
    return null;
  }
}
/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

// POST /ai-assistant/query  { message, history? }
router.post('/ai-assistant/query', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'gemini_api_key is not configured on this function.' });
    }
    const { message, history = [] } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const catalystApp = res.locals.catalystApp;
    const ctx = await resolveAiContext(catalystApp, res.locals.currentUser);
    const reply = await runAssistant(catalystApp, ctx, message.trim(), history);

    const audio = SARVAM_API_KEY ? await synthesizeSpeech(reply) : null;
    res.status(200).json({ reply, audio });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /ai-assistant/transcribe  multipart: audio (file)
// Speech-to-text ONLY — no Gemini call, no TTS. Added so the frontend can
// show the user's transcribed message immediately (ChatGPT-style: speak ->
// see your own message right away -> thinking -> reply), then hand the
// transcript to the existing, unchanged POST /ai-assistant/query for the
// actual assistant turn (which already returns TTS audio when configured).
// Reuses the same transcribeSpeech() helper /ai-assistant/voice already
// used — that combined endpoint is left in place, untouched, for anything
// still calling it.
router.post('/ai-assistant/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!SARVAM_API_KEY) {
      return res.status(500).json({ error: 'Sarvam_api_key is not configured on this function.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'audio file is required' });
    }
    const transcript = await transcribeSpeech(req.file.buffer, req.file.mimetype);
    res.status(200).json({ transcript: transcript.trim() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /ai-assistant/voice  multipart: audio (file), history (JSON string, optional)
router.post('/ai-assistant/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'gemini_api_key is not configured on this function.' });
    }
    if (!SARVAM_API_KEY) {
      return res.status(500).json({ error: 'Sarvam_api_key is not configured on this function.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'audio file is required' });
    }

    const transcript = await transcribeSpeech(req.file.buffer, req.file.mimetype);
    if (!transcript.trim()) {
      return res.status(200).json({
        transcript: '',
        reply: "I couldn't make out what you said — could you try again?",
        audio: null,
      });
    }

    let history = [];
    try { history = JSON.parse(req.body.history || '[]'); } catch (_) { /* ignore malformed history */ }

    const catalystApp = res.locals.catalystApp;
    const ctx = await resolveAiContext(catalystApp, res.locals.currentUser);
    const reply = await runAssistant(catalystApp, ctx, transcript.trim(), history);
    const audio = await synthesizeSpeech(reply);

    res.status(200).json({ transcript: transcript.trim(), reply, audio });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;


