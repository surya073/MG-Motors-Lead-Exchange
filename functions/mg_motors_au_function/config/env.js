'use strict';

const REQUIRED_VARS = [
  'ZOHO_CLIENT_ID',
  'ZOHO_CLIENT_SECRET',
  'ZOHO_REFRESH_TOKEN',
  'ZOHO_API_DOMAIN',
  'ZOHO_ACCOUNTS_DOMAIN',
  'ZOHO_WEBHOOK_TOKEN'
];

function getZohoConfig() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
      `Set these in Catalyst Console → mg_motors_au_function → Environment Variables.`
    );
  }

  return {
    clientId: process.env.ZOHO_CLIENT_ID,
    clientSecret: process.env.ZOHO_CLIENT_SECRET,
    refreshToken: process.env.ZOHO_REFRESH_TOKEN,
    apiDomain: process.env.ZOHO_API_DOMAIN,
    accountsDomain: process.env.ZOHO_ACCOUNTS_DOMAIN,
    webhookToken: process.env.ZOHO_WEBHOOK_TOKEN,
  };
}

/**
 * Optional lower bound (ISO 8601, e.g. 2026-10-08T00:00:00+11:00) on the OEM
 * lead Created_Time that lead sync pulls. MG's OEM org holds ~72k historical
 * leads that must not be mirrored or pushed to dealers; unset means "all
 * leads". Returns a Date or null.
 */
function getLeadSyncSince() {
  const raw = (process.env.LEAD_SYNC_SINCE || '').trim();
  if (!raw) return null;
  const since = new Date(raw);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`Invalid LEAD_SYNC_SINCE "${raw}" — expected an ISO 8601 date/time`);
  }
  return since;
}

/**
 * Kept as a SEPARATE function from getZohoConfig() deliberately — this
 * key is only needed by integrationAuthService.js when a dealer's
 * EXTERNAL_CRM integration actually saves/reads a credential. Bundling
 * it into REQUIRED_VARS above would mean every existing Zoho sync call
 * (which has nothing to do with dealer CRM integrations) starts failing
 * for shops that haven't set this var yet.
 *
 * Must be 32 raw bytes, base64-encoded, e.g. generated once via:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * and stored in Catalyst Console → mg_motors_au_function → Environment
 * Variables as INTEGRATION_CREDENTIALS_KEY.
 */
function getIntegrationCredentialsKey() {
  const key = process.env.INTEGRATION_CREDENTIALS_KEY;
  if (!key) {
    throw new Error(
      'Missing required environment variable: INTEGRATION_CREDENTIALS_KEY. ' +
      'Set this in Catalyst Console → mg_motors_au_function → Environment Variables ' +
      '(32 random bytes, base64-encoded).'
    );
  }
  return key;
}

/**
 * Not added to REQUIRED_VARS / not throwing when missing — the AI
 * assistant routes already degrade gracefully (a clear "not configured"
 * error response) when these are absent, unlike Zoho config which every
 * sync call depends on.
 *
 * Names/casing here MUST match catalyst-config.json exactly
 * (`gemini_api_key`, `Sarvam_api_key`) — process.env keys are
 * case-sensitive, and a mismatch here previously made the AI assistant
 * 500 on every request despite the keys being configured.
 */
function getAiAssistantConfig() {
  return {
    geminiApiKey: process.env.gemini_api_key,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    sarvamApiKey: process.env.Sarvam_api_key,
  };
}

/**
 * Optional shared inbound-webhook secret for dealers whose CRM cannot hold a
 * per-dealer secret from this app (e.g. Fusion SD). It applies ONLY to the
 * dealer codes listed in FUSION_WEBHOOK_DEALER_CODES (comma-separated), and is
 * accepted in addition to the dealer's own secret. Unset = feature off.
 */
function getSharedWebhookConfig() {
  const secret = (process.env.FUSION_WEBHOOK_SECRET || '').trim();
  const dealerCodes = new Set(
    (process.env.FUSION_WEBHOOK_DEALER_CODES || '')
      .split(',')
      .map((code) => code.trim().toLowerCase())
      .filter(Boolean)
  );
  return { secret, dealerCodes };
}

/**
 * Outbound retry and escalation switches (FUSION_REMEDIATION_PLAN.md,
 * Batch 3). Read on every call. Unset variables keep today's behaviour:
 *   OUTBOUND_RETRY_POLICY         'classified' retries only TRANSIENT/LOCAL
 *                                 failures, with capped exponential backoff
 *                                 and the dealer's Retry-After; AUTH and
 *                                 PERMANENT failures, and retries past the
 *                                 limits below, stop as RETRY_EXHAUSTED.
 *                                 Anything else (default): every failure is
 *                                 retried at OUTBOUND_RETRY_INTERVAL_MINUTES,
 *                                 without limit.
 *   OUTBOUND_RETRY_MAX_ATTEMPTS   classified only; default 10.
 *   OUTBOUND_RETRY_MAX_AGE_HOURS  classified only; default 48.
 *   FAST_RECOVER_HONOUR_SCHEDULE  'true': /cron/fast-recover waits for each
 *                                 lead's next_retry_at.
 *   ESCALATION_TRANSIENT_ONLY     'true': only TRANSIENT failures of leads the
 *                                 dealer has not received escalate to Dealer
 *                                 Unavailable.
 */
function getOutboundRetryConfig() {
  const positiveNumber = (name, fallback) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const isOn = (name) => String(process.env[name] || '').trim().toLowerCase() === 'true';
  return {
    classified: String(process.env.OUTBOUND_RETRY_POLICY || '').trim().toLowerCase() === 'classified',
    maxAttempts: Math.floor(positiveNumber('OUTBOUND_RETRY_MAX_ATTEMPTS', 10)),
    maxAgeHours: positiveNumber('OUTBOUND_RETRY_MAX_AGE_HOURS', 48),
    fastRecoverHonourSchedule: isOn('FAST_RECOVER_HONOUR_SCHEDULE'),
    escalationTransientOnly: isOn('ESCALATION_TRANSIENT_ONLY'),
  };
}

/**
 * LEAD_NAME_PARTS=true: the lead sync also stores MG's First_Name and
 * Last_Name in the `leads` table's first_name / last_name columns, so Fusion
 * gets the customer's first and last name separately (Q2, Batch 4). Add both
 * columns (text) in the Catalyst console BEFORE setting this, or every lead
 * write fails. Unset: nothing new is stored and Fusion gets the full name as
 * its first name, as before. Read on every call.
 */
function isLeadNamePartsEnabled() {
  return String(process.env.LEAD_NAME_PARTS || '').trim().toLowerCase() === 'true';
}

/**
 * FUSION_INBOUND_V2=true turns on Fusion SD's Standard Webhooks receiver
 * (FUSION_REMEDIATION_PLAN.md, Batch 5): the signed-webhook check and the
 * translation of Fusion's flat lead body. Fusion SD dealers only. Unset keeps
 * today's inbound path. Read on every call.
 */
function isFusionInboundV2Enabled() {
  return String(process.env.FUSION_INBOUND_V2 || '').trim().toLowerCase() === 'true';
}

/**
 * INBOUND_EVENT_STORE=true stores each Fusion SD webhook, encrypted, before
 * it is processed, so a failed or interrupted event can be processed again
 * and a held one replayed (FUSION_REMEDIATION_PLAN.md, Batch 6; Q22: Fusion
 * SD only). Needs the webhook_events columns payload_encrypted,
 * external_lead_id, attempt_count and lease_until; until they exist events
 * are recorded as before. Read on every call.
 */
function isInboundEventStoreEnabled() {
  return String(process.env.INBOUND_EVENT_STORE || '').trim().toLowerCase() === 'true';
}

/**
 * WEBHOOK_EVENT_RETENTION_DAYS: SUCCESS webhook_events rows older than this
 * many days are deleted (FUSION_REMEDIATION_PLAN.md, Batch 6, audit S9).
 * Unset, or not a positive whole number, keeps every row (Q23). Read on
 * every call.
 */
function getWebhookEventRetentionDays() {
  const text = String(process.env.WEBHOOK_EVENT_RETENTION_DAYS || '').trim();
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  return days > 0 ? days : null;
}

/**
 * SLA_DEALER_ACTION_CLOCK=true runs the dealer-action SLA (Unhappy 10) from
 * lead_integrations.last_dealer_action_at (first delivery, then each dealer
 * change applied to MG) instead of last_synced_at, which MG's own updates
 * and retries also rewrite (FUSION_REMEDIATION_PLAN.md, Batch 7, Q25). Add
 * the column first. Read on every call.
 */
function isSlaDealerActionClockEnabled() {
  return String(process.env.SLA_DEALER_ACTION_CLOCK || '').trim().toLowerCase() === 'true';
}

/**
 * ZOHO_API_TIMEOUT_MS bounds every call to MG's Zoho CRM (and its token
 * endpoint), in milliseconds (FUSION_REMEDIATION_PLAN.md, Batch 8, Q30;
 * suggested 15000). Unset, or not a positive whole number, means no timeout,
 * as before. Read on every call.
 */
function getZohoApiTimeoutMs() {
  const text = String(process.env.ZOHO_API_TIMEOUT_MS || '').trim();
  if (!/^\d+$/.test(text)) return undefined;
  const ms = Number(text);
  return ms > 0 ? ms : undefined;
}

/** The axios option for getZohoApiTimeoutMs(): `{ timeout }`, or nothing. */
function zohoTimeoutOption() {
  const timeout = getZohoApiTimeoutMs();
  return timeout ? { timeout } : {};
}

module.exports = {
  getZohoConfig,
  getIntegrationCredentialsKey,
  getAiAssistantConfig,
  getLeadSyncSince,
  getSharedWebhookConfig,
  getOutboundRetryConfig,
  isLeadNamePartsEnabled,
  isFusionInboundV2Enabled,
  isInboundEventStoreEnabled,
  getWebhookEventRetentionDays,
  isSlaDealerActionClockEnabled,
  getZohoApiTimeoutMs,
  zohoTimeoutOption,
};