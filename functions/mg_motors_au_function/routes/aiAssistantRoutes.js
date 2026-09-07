'use strict';

const express = require('express');
const multer = require('multer');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Keep these in sync with functions/mg_motors_au_function/index.js
const DEALERS_TABLE_ID = '37148000000425015';
const LEADS_TABLE_ID = '37148000000442417';
const LEAD_DELIVERY_LOGS_TABLE_ID = '37148000000425411';

// TODO: fill in with the real admin_user_mapping table ID (see adminUserRoutes.js).
// Left blank means the admin check below always falls through to "not admin".
// const ADMIN_USER_MAPPING_TABLE_ID = '';
const SUPER_ADMIN_ROLE_ID = '37148000000359008'; // App Administrator


const GEMINI_MODEL = 'gemini-3.5-flash'; // current GA Flash model as of mid-2026
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/* ------------------------------------------------------------------ */
/* Datastore helpers                                                   */
/* ------------------------------------------------------------------ */

async function fetchAllRows(table) {
  const rows = [];
  let nextToken;
  do {
    const page = await table.getPagedRows({ nextToken, maxRows: 100 });
    rows.push(...page.data);
    nextToken = page.more_records ? page.next_token : undefined;
  } while (nextToken);
  return rows;
}

/**
 * ASSUMPTION: admin = present in admin_user_mapping by email; dealer =
 * a Dealers row whose Email matches the logged-in Catalyst user's email.
 * Replace with the real lookup used elsewhere in this codebase if it
 * resolves role differently.
 */
async function resolveAiContext(catalystApp, currentUser) {
  const roleId = currentUser?.role_details?.role_id;
  if (roleId === SUPER_ADMIN_ROLE_ID) {
    return { role: 'admin', dealerId: null, dealerName: null };
  }

  const email = (currentUser?.email_id || currentUser?.email || '').toLowerCase();
  const dealers = await fetchAllRows(catalystApp.datastore().table(DEALERS_TABLE_ID));
  const dealer = dealers.find((d) => (d.Email || '').toLowerCase() === email);
  if (dealer) {
    return { role: 'dealer', dealerId: dealer.ROWID, dealerName: dealer.Name };
  }

  return { role: 'unknown', dealerId: null, dealerName: null };
}

async function findDealerByNameOrId(catalystApp, dealerNameOrId) {
  const rows = await fetchAllRows(catalystApp.datastore().table(DEALERS_TABLE_ID));
  const needle = (dealerNameOrId || '').trim().toLowerCase();
  return rows.find((d) => d.ROWID === dealerNameOrId || (d.Name || '').toLowerCase().includes(needle));
}

async function getLeadsFor(catalystApp, dealerId, { status } = {}) {
  const rows = await fetchAllRows(catalystApp.datastore().table(LEADS_TABLE_ID));
  return rows
    .filter((l) => l.DealerID === dealerId)
    .filter((l) => !status || l.Status === status)
    .map((l) => ({
      leadId: l.ROWID,
      customerName: l.CustomerName,
      status: l.Status,
      deliveryStatus: l.DeliveryStatus,
      source: l.Source,
      receivedAt: l.CREATEDTIME, // when the lead came in
      lastUpdatedAt: l.MODIFIEDTIME, // when it was last touched/updated
    }));
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */
/* ------------------------------------------------------------------ */

async function toolListDealers(catalystApp, { search = '' } = {}) {
  const rows = await fetchAllRows(catalystApp.datastore().table(DEALERS_TABLE_ID));
  const q = search.trim().toLowerCase();
  const filtered = q
    ? rows.filter((d) => [d.Name, d.Region, d.Status].filter(Boolean).some((f) => f.toLowerCase().includes(q)))
    : rows;
  return {
    dealers: filtered.slice(0, 25).map((d) => ({
      dealerId: d.ROWID,
      name: d.Name,
      region: d.Region,
      status: d.Status,
      contactPerson: d.ContactPerson,
      email: d.Email,
      phone: d.Phone,
    })),
  };
}

async function toolDealerDetail(catalystApp, { dealerName } = {}) {
  const dealer = await findDealerByNameOrId(catalystApp, dealerName);
  if (!dealer) return { error: `No dealer found matching "${dealerName}".` };
  const leads = await getLeadsFor(catalystApp, dealer.ROWID);
  const delivered = leads.filter((l) => l.status === 'delivered').length;
  return {
    dealerId: dealer.ROWID,
    name: dealer.Name,
    region: dealer.Region,
    status: dealer.Status,
    contactPerson: dealer.ContactPerson,
    email: dealer.Email,
    totalLeads: leads.length,
    delivered,
    conversionRate: leads.length ? Math.round((delivered / leads.length) * 100) : 0,
  };
}

async function toolDealerLeads(catalystApp, { dealerName, status } = {}) {
  const dealer = await findDealerByNameOrId(catalystApp, dealerName);
  if (!dealer) return { error: `No dealer found matching "${dealerName}".` };
  const leads = await getLeadsFor(catalystApp, dealer.ROWID, { status });
  return { dealerName: dealer.Name, count: leads.length, leads: leads.slice(0, 30) };
}

async function toolDealerPerformance(catalystApp, { dealerName } = {}) {
  const dealer = await findDealerByNameOrId(catalystApp, dealerName);
  if (!dealer) return { error: `No dealer found matching "${dealerName}".` };
  const leads = await getLeadsFor(catalystApp, dealer.ROWID);
  const byStatus = leads.reduce((acc, l) => {
    acc[l.status || 'unknown'] = (acc[l.status || 'unknown'] || 0) + 1;
    return acc;
  }, {});
  return { dealerName: dealer.Name, totalLeads: leads.length, byStatus };
}

async function toolLeadDetail(catalystApp, { leadIdOrCustomerName } = {}, allowedDealerId = null) {
  const leadsTable = catalystApp.datastore().table(LEADS_TABLE_ID);
  let lead = null;
  try {
    lead = await leadsTable.getRow(leadIdOrCustomerName);
  } catch (_) {
    // not a ROWID — fall back to a name search below
  }
  if (!lead) {
    const rows = await fetchAllRows(leadsTable);
    const needle = (leadIdOrCustomerName || '').toLowerCase();
    lead = rows.find((l) => (l.CustomerName || '').toLowerCase().includes(needle));
  }
  if (!lead) return { error: `No lead found matching "${leadIdOrCustomerName}".` };
  if (allowedDealerId && lead.DealerID !== allowedDealerId) {
    return { error: 'That lead does not belong to your dealership.' };
  }

  let dealerName = 'Unassigned';
  try {
    const dealer = await catalystApp.datastore().table(DEALERS_TABLE_ID).getRow(lead.DealerID);
    dealerName = dealer.Name;
  } catch (_) {
    // leave as Unassigned
  }

  const logs = (await fetchAllRows(catalystApp.datastore().table(LEAD_DELIVERY_LOGS_TABLE_ID)))
    .filter((log) => log.LeadID === lead.ROWID);

  return {
    leadId: lead.ROWID,
    customerName: lead.CustomerName,
    dealerName,
    status: lead.Status,
    deliveryStatus: lead.DeliveryStatus,
    source: lead.Source,
    receivedAt: lead.CREATEDTIME,
    lastUpdatedAt: lead.MODIFIEDTIME,
    deliveryAttempts: logs.map((l) => ({ attempt: l.AttemptNumber, result: l.Results, message: l.Message })),
  };
}

async function toolNetworkSummary(catalystApp) {
  const [dealers, leads] = await Promise.all([
    fetchAllRows(catalystApp.datastore().table(DEALERS_TABLE_ID)),
    fetchAllRows(catalystApp.datastore().table(LEADS_TABLE_ID)),
  ]);
  const byStatus = leads.reduce((acc, l) => {
    acc[l.Status || 'unknown'] = (acc[l.Status || 'unknown'] || 0) + 1;
    return acc;
  }, {});
  return {
    totalDealers: dealers.length,
    activeDealers: dealers.filter((d) => d.Status === 'active').length,
    totalLeads: leads.length,
    leadsByStatus: byStatus,
  };
}

async function toolMyLeads(catalystApp, dealerId, { status } = {}) {
  const leads = await getLeadsFor(catalystApp, dealerId, { status });
  return { count: leads.length, leads: leads.slice(0, 30) };
}

/* ------------------------------------------------------------------ */
/* Gemini tool declarations + dispatcher                               */
/* ------------------------------------------------------------------ */

const ADMIN_TOOLS = [
  { name: 'list_dealers', description: 'Search/list dealers in the network.', parameters: { type: 'OBJECT', properties: { search: { type: 'STRING', description: 'Optional name/region/status filter.' } } } },
  { name: 'get_dealer_detail', description: 'Profile and lead totals for one dealer.', parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' } }, required: ['dealerName'] } },
  { name: 'get_dealer_leads', description: "List a dealer's leads, optionally filtered by status.", parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' }, status: { type: 'STRING', description: 'new|contacted|test_drive|quotation|delivered|lost' } }, required: ['dealerName'] } },
  { name: 'get_dealer_performance', description: 'Lead counts by status and conversion rate for one dealer.', parameters: { type: 'OBJECT', properties: { dealerName: { type: 'STRING' } }, required: ['dealerName'] } },
  { name: 'get_lead_detail', description: 'Look up a single lead by ID or customer name — includes when it came in, when it was last updated, and delivery attempts.', parameters: { type: 'OBJECT', properties: { leadIdOrCustomerName: { type: 'STRING' } }, required: ['leadIdOrCustomerName'] } },
  { name: 'get_network_summary', description: 'Network-wide dealer and lead totals.', parameters: { type: 'OBJECT', properties: {} } },
];

const DEALER_TOOLS = [
  { name: 'get_my_leads', description: "List the current dealer's own leads, optionally filtered by status.", parameters: { type: 'OBJECT', properties: { status: { type: 'STRING' } } } },
  { name: 'get_my_lead_detail', description: "Look up one of the current dealer's own leads by ID or customer name — includes when it came in and when it was last updated.", parameters: { type: 'OBJECT', properties: { leadIdOrCustomerName: { type: 'STRING' } }, required: ['leadIdOrCustomerName'] } },
];

async function runTool(catalystApp, ctx, name, args) {
  if (ctx.role === 'admin') {
    switch (name) {
      case 'list_dealers': return toolListDealers(catalystApp, args);
      case 'get_dealer_detail': return toolDealerDetail(catalystApp, args);
      case 'get_dealer_leads': return toolDealerLeads(catalystApp, args);
      case 'get_dealer_performance': return toolDealerPerformance(catalystApp, args);
      case 'get_lead_detail': return toolLeadDetail(catalystApp, args, null);
      case 'get_network_summary': return toolNetworkSummary(catalystApp);
      default: return { error: `Unknown tool ${name}` };
    }
  }
  if (ctx.role === 'dealer') {
    switch (name) {
      case 'get_my_leads': return toolMyLeads(catalystApp, ctx.dealerId, args);
      case 'get_my_lead_detail': return toolLeadDetail(catalystApp, args, ctx.dealerId);
      default: return { error: `Unknown tool ${name}` };
    }
  }
  return { error: "Could not confirm your account role, so live data lookups aren't available right now." };
}

function systemPromptFor(ctx) {
  const base = 'You are the MG Motor Lead Exchange AI assistant, embedded in the dealer management dashboard. '
    + 'Answer concisely and in plain language, using the tools to fetch real data instead of guessing. '
    + 'Dates from tools are timestamps in the platform\'s stored format — describe them in relative, human terms '
    + '(e.g. "3 days ago") when that helps. If a tool returns an error, say so plainly instead of inventing an answer. '
    + 'Never reveal internal IDs, table names, or API details.';

  if (ctx.role === 'admin') {
    return `${base} You are talking to a network admin. They can ask about any dealer, a dealer's leads and performance, and individual lead timelines (when a lead came in, and when a dealer last updated it).`;
  }
  if (ctx.role === 'dealer') {
    return `${base} You are talking to ${ctx.dealerName || 'a dealer'}. They can only see their own leads — never imply you can show another dealer's data. Also help with general questions about how the portal works (what lead statuses mean, how delivery/sync works, etc.).`;
  }
  return `${base} This user's role could not be confirmed, so data tools are unavailable — help only with general questions about how the portal works.`;
}

/* ------------------------------------------------------------------ */
/* Gemini call loop                                                    */
/* ------------------------------------------------------------------ */

async function callGemini({ systemPrompt, contents, tools }) {
  const res = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
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
    const result = await runTool(catalystApp, ctx, name, args || {});

    // Push the model's turn back exactly as returned — Gemini 3 attaches
    // a thoughtSignature to each functionCall part and rejects the nexttoolListDealers
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
    headers: { 'api-subscription-key': process.env.SARVAM_API_KEY },
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
        'api-subscription-key': process.env.SARVAM_API_KEY,
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

// POST /ai-assistant/query  { message, history?, voice? }
router.post('/ai-assistant/query', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on this function.' });
    }
    const { message, history = [] } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    const catalystApp = res.locals.catalystApp;
    const ctx = await resolveAiContext(catalystApp, res.locals.currentUser);
    const reply = await runAssistant(catalystApp, ctx, message.trim(), history);

    const audio = process.env.SARVAM_API_KEY ? await synthesizeSpeech(reply) : null;
    res.status(200).json({ reply, audio });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /ai-assistant/voice  multipart: audio (file), history (JSON string, optional)
router.post('/ai-assistant/voice', upload.single('audio'), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on this function.' });
    }
    if (!process.env.SARVAM_API_KEY) {
      return res.status(500).json({ error: 'SARVAM_API_KEY is not configured on this function.' });
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