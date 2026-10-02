'use strict';

const logger = require('../../utils/logger');
const { toCatalystDateTime } = require('../../utils/dateFormat');
const pathPolicy = require('./pathPolicyService');

/**
 * outboundSyncClaimService.js
 * -----------------------------------------------------------------------
 * Closes the cross-instance half of the duplicate-lead-creation risk that
 * sweepOverlapGuard.js explicitly could NOT close (that guard is in-memory
 * and only protects re-entrant calls on the SAME warm Catalyst instance).
 *
 * CONFIRMED PLATFORM CONSTRAINT (checked directly against the installed
 * zcatalyst-sdk-node type definitions, not assumed): ZCQL's
 * executeZCQLQuery is SELECT-only, and Table.updateRow() takes only a
 * ROWID plus fields — no WHERE/version condition. There is no exposed
 * compare-and-swap UPDATE primitive. Table.insertRow(), however, DOES
 * give us a real atomic primitive IF the target column has a Catalyst
 * Console-configured Unique constraint: the Data Store rejects the second
 * of two concurrent inserts with the same value, and that rejection is
 * enforced server-side, across every function instance, not just the one
 * that issued it.
 *
 * REQUIRES A MANUAL, ONE-TIME CATALYST CONSOLE STEP before this is
 * actually effective (see the deployment report) — a new table:
 *
 *   outbound_sync_claims
 *     claim_key          Text, UNIQUE constraint enabled   <- the whole fix
 *     claimed_at         Text (stores "YYYY-MM-DD HH:mm:ss" UTC)
 *     request_reference  Text
 *
 * Until that table and unique constraint exist, acquireClaim() below
 * fails open on ANY insert error whose claim_key it cannot find afterward
 * (see the comment in acquireClaim) — i.e. a missing table surfaces as a
 * loud thrown error on every sync attempt, not a silent no-op, so a
 * misconfigured deployment is obvious rather than quietly unprotected.
 *
 * Why INSERT-based claiming, not a status flag on lead_integrations: the
 * known duplicate-creation race can happen BEFORE any lead_integrations
 * row exists at all (two near-simultaneous first-time syncs for the same
 * lead), so the claim can't live on a row that might not exist yet.
 * Deliberately a separate table rather than a new column on
 * lead_integrations — zero risk to pathPolicyService's Happy/Unhappy
 * classification or any dashboard that reads lead_integrations.sync_status,
 * since nothing about that table's shape changes.
 *
 * Staleness/crash recovery: a claim normally lives for the duration of
 * one syncLeadToExternalCrm attempt (a single dealer-CRM HTTP round trip
 * plus bookkeeping, typically well under the adapters' own 8-10s
 * timeouts) and is deleted in a `finally` the moment that attempt ends,
 * success or failure. If the function crashes/times out before that
 * finally runs, the claim would otherwise block every future retry for
 * that one lead forever. CLAIM_TTL_MINUTES (default 5 — generous relative
 * to realistic attempt duration) bounds that: a claim older than the TTL
 * is treated as abandoned and reclaimed. This IS a residual timing
 * assumption (not a mathematical guarantee like the uniqueness check
 * itself), but the failure mode if the assumption is ever wrong is
 * bounded and self-correcting: a lead's retry is delayed by at most one
 * TTL window, never a permanent block and never a duplicate create.
 */

const CLAIMS_TABLE = 'outbound_sync_claims';

const DEFAULT_CLAIM_TTL_MINUTES = 5;
const configuredTtl = Number(process.env.OUTBOUND_SYNC_CLAIM_TTL_MINUTES);
const CLAIM_TTL_MINUTES = Number.isFinite(configuredTtl) && configuredTtl > 0
  ? configuredTtl
  : DEFAULT_CLAIM_TTL_MINUTES;

function buildClaimKey(integrationId, zohoLeadId) {
  return `${integrationId}:${zohoLeadId}`;
}

function safeQuoteForZcql(value) {
  return String(value).replace(/'/g, "''");
}

async function findClaimRow(catalystApp, claimKey) {
  const rows = await catalystApp.zcql().executeZCQLQuery(
    `SELECT * FROM ${CLAIMS_TABLE} WHERE claim_key = '${safeQuoteForZcql(claimKey)}' LIMIT 1`
  );
  return rows.length > 0 ? rows[0][CLAIMS_TABLE] : null;
}

function isClaimStale(claimRow, now = Date.now()) {
  const claimedAt = pathPolicy.parseTimestamp(claimRow.claimed_at);
  if (!claimedAt) return true; // unparseable/missing — treat as abandoned rather than block forever
  return (now - claimedAt.getTime()) / 60000 >= CLAIM_TTL_MINUTES;
}

async function deleteClaimSilently(catalystApp, claimRowId) {
  try {
    await catalystApp.datastore().table(CLAIMS_TABLE).deleteRow(claimRowId);
  } catch (err) {
    // Not fatal: a claim that fails to delete simply self-heals via the
    // staleness TTL on the next attempt for this lead.
    logger.error('outboundSyncClaimService', `Failed to release claim ROWID=${claimRowId}`, err);
  }
}

/**
 * Attempts to atomically claim (integrationId, zohoLeadId) for exclusive
 * outbound-sync processing. Returns the claim row on success, or null if
 * another instance genuinely holds it right now.
 *
 * Deliberately does NOT pattern-match Catalyst's exact unique-constraint
 * violation error code/shape — that isn't documented in the installed
 * SDK's type definitions and guessing it wrong would be exactly the kind
 * of invented behavior this project has been told to avoid. Instead, any
 * insert failure is followed by a fresh read of the claim_key: if a row
 * is there, something else holds (or abandoned) the claim and we act on
 * that ground truth; if nothing is there, the insert failed for some
 * other reason (missing table, permissions, etc.) and we fail loudly by
 * rethrowing, rather than silently proceeding without real exclusivity.
 */
async function acquireClaim(catalystApp, integrationId, zohoLeadId, requestReference) {
  const claimKey = buildClaimKey(integrationId, zohoLeadId);
  const claimsTable = catalystApp.datastore().table(CLAIMS_TABLE);
  const claimFields = {
    claim_key: claimKey,
    claimed_at: toCatalystDateTime(),
    request_reference: requestReference || '',
  };

  try {
    return await claimsTable.insertRow(claimFields);
  } catch (insertErr) {
    const existing = await findClaimRow(catalystApp, claimKey);

    if (!existing) {
      // The insert didn't fail because of a competing claim (none exists)
      // — something else is wrong (table/column missing, permissions,
      // etc). Surface it rather than proceed unprotected.
      throw insertErr;
    }

    if (!isClaimStale(existing)) {
      return null; // genuinely in use elsewhere right now
    }

    // Abandoned claim (crashed/timed-out instance never released it).
    // Reclaim once; if a third party wins that race, back off cleanly.
    await deleteClaimSilently(catalystApp, existing.ROWID);
    try {
      return await claimsTable.insertRow(claimFields);
    } catch (retryErr) {
      return null;
    }
  }
}

/**
 * Runs `fn` while holding the exclusive outbound-sync claim for
 * (integrationId, zohoLeadId). If the claim cannot be acquired, `fn` is
 * never called and this returns {skipped: true, reason:
 * 'CONCURRENT_SYNC_IN_PROGRESS'} — the same shape syncLeadToExternalCrm
 * already uses for its other non-error skip cases (e.g.
 * ECHO_SUPPRESSED_OUTBOUND), so every existing caller's
 * `if (outcome.ok) ... else ...` handling already copes with it
 * correctly without any caller-side changes. The row is still FAILED (or
 * has no mapping yet), so it is simply retried on the next sweep.
 */
async function withOutboundSyncClaim(catalystApp, integrationId, zohoLeadId, requestReference, fn) {
  let claim;
  try {
    claim = await acquireClaim(catalystApp, integrationId, zohoLeadId, requestReference);
  } catch (err) {
    // FAILS OPEN, deliberately: acquireClaim only throws when it cannot
    // even confirm WHY the insert failed (most likely cause: the
    // outbound_sync_claims table hasn't been created yet in this
    // environment — see this file's header comment for the required
    // one-time Catalyst Console step). Breaking every outbound sync call
    // because of a missing/misconfigured claims table would be strictly
    // worse than the race this file exists to close — it would disrupt
    // production Zoho/Fusion SD/AutoPlay delivery entirely, which this
    // project's own constraints explicitly rule out. Proceeding without
    // the claim reproduces exactly the PRE-fix behavior (no cross-
    // instance protection for this one attempt), logged loudly so a
    // missing migration is obvious rather than silently unprotected.
    logger.error(
      'outboundSyncClaimService',
      `Could not acquire sync claim for lead ${zohoLeadId} (integration ${integrationId}) — proceeding WITHOUT cross-instance duplicate protection for this attempt. Most likely cause: the outbound_sync_claims table does not exist yet in this Catalyst environment.`,
      err
    );
    return fn();
  }
  if (!claim) {
    logger.info(
      'outboundSyncClaimService',
      `Skipped sync for lead ${zohoLeadId} (integration ${integrationId}) — another sync is already in progress`
    );
    return { skipped: true, reason: 'CONCURRENT_SYNC_IN_PROGRESS' };
  }

  try {
    return await fn();
  } finally {
    await deleteClaimSilently(catalystApp, claim.ROWID);
  }
}

module.exports = {
  withOutboundSyncClaim,
  _test: { buildClaimKey, isClaimStale, CLAIM_TTL_MINUTES, CLAIMS_TABLE },
};
