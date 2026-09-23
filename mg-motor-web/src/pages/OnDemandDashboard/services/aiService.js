/**
 * aiService.js
 * -----------------------------------------------------------------------
 * Talks to the real backend: functions/mg_motors_au_function's
 * onDemandDashboardRoutes.js (GET /on-demand/summary,
 * POST /on-demand/analyze-file, POST /on-demand/chat).
 *
 * ON_DEMAND_API_BASE below is a guess — point it at whatever base path
 * your other pages already use to call this same Catalyst function
 * (e.g. wherever DealerListPage/SyncLogsPage call `/admin/dealers`,
 * `/admin/sync-logs`, etc. from). If your project already has a shared
 * axios instance or fetch wrapper for that, use it here instead of the
 * raw fetch() calls below — this file just needs apiGet/apiPost to hit
 * the right host with the auth cookie attached.
 */

const ON_DEMAND_API_BASE = "/server/mg_motors_au_function"; // TODO: confirm/replace with your real base path

async function apiGet(path) {
  const res = await fetch(`${ON_DEMAND_API_BASE}${path}`, {
    credentials: "include", // backend auth relies on the session cookie (getCurrentUser)
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Request to ${path} failed (${res.status})`);
  }
  return data;
}

async function apiPost(path, body) {
  const res = await fetch(`${ON_DEMAND_API_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `Request to ${path} failed (${res.status})`);
  }
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Live app-data snapshot (dealers/leads/sync_logs), straight from
 * adminDashboardService.getDashboardSummary via GET /on-demand/summary.
 * No AI involved — this data's shape is already known.
 * @returns {Promise<object>} the summary object
 */
export async function fetchAppDataSummary() {
  const { summary } = await apiGet("/on-demand/summary");
  return summary;
}

/**
 * Uploads a PDF/Excel/CSV file for AI analysis.
 * @param {File} file
 * @returns {Promise<{summary: string, insights: string[], suggestedKpis: object[], charts: object[]}>}
 */
export async function analyzeUploadedFile(file) {
  const fileData = await fileToBase64(file);
  return apiPost("/on-demand/analyze-file", { fileData, fileName: file.name });
}

/**
 * Sends a natural-language question to the assistant.
 * @param {string} message
 * @param {{appDataSummary?: object, uploadedFileSummary?: string, history?: {role: string, text: string}[]}} [context]
 * @returns {Promise<{reply: string}>}
 */
export async function askAssistant(message, context = {}) {
  const { reply } = await apiPost("/on-demand/chat", {
    question: message,
    appDataSummary: context.appDataSummary,
    uploadedFileSummary: context.uploadedFileSummary,
    history: context.history,
  });
  return { reply };
}