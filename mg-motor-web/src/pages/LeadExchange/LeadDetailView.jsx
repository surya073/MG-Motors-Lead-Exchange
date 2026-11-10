import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { adminDashboardService } from "../../services/api/adminDashboardService";
import { dealerCrmIntegrationService } from "../../services/api/dealerCrmIntegrationService";
import { useAuth } from "../../contexts/AuthContext";
import { useAlerts } from "../../ui/Alerts/Alerts";
import { APP_ROLES } from "../../constants/auth.constants";
import {
  ChevronLeftIcon,
  PhoneIcon,
  MailIcon,
  UserIcon,
  ClipboardIcon,
  BuildingIcon,
  CarIcon,
  MegaphoneIcon,
  ArrowRightIcon,
  NoteIcon,
  ClockIcon,
  PencilIcon,
} from "../../ui/icons";
import { isValidAustralianMobile } from "../../utils/mobileValidation";
import PathBadge from "../../ui/PathBadge/PathBadge";
import { CompactListSkeleton } from "../../ui/Skeleton/PageSkeletons";
import "./LeadDetailView.css";
import "./LeadDetailTabs.css";

/* ----------------------------------------------------------------
   Status -> visual tone
------------------------------------------------------------------ */
const STATUS_TONES = {
  "Update Pending": "neutral",
  "Not Contacted": "neutral",
  Contacted: "info",
  "Follow-up 1": "info",
  "Follow-up 2": "info",
  "In Progress": "warning",
  "Contact in Future": "warning",
  Converted: "success",
  Won: "success",
  Lost: "danger",
  "Lost Lead": "danger",
  Dropped: "danger",
  "Not Qualified": "danger",
  Rejected: "danger",
  "Junk Lead": "danger",
  Junk: "danger",
  Spam: "danger",
  "Dealer Unavailable": "danger",
  "Unattended Alert": "danger",
  Removed: "danger",
  "Consent Hold": "danger",
};

/* ----------------------------------------------------------------
   HAPPY PATHS
------------------------------------------------------------------ */
const HAPPY_PATHS = [
  {
    id: "Happy 1",
    type: "happy",
    title: "New enquiry routed successfully",
    trigger: "OEM CRM",
    match: ["Update Pending", "Not Contacted"],
    description:
      "Enquiry created in the OEM, mandatory fields validated, dealer resolved by postcode, and pushed to the dealer CRM successfully.",
    outcome: "Status moves Update Pending → Not Contacted once the dealer acknowledges receipt.",
  },
  {
    id: "Happy 2",
    type: "happy",
    title: "Dealer progresses enquiry (status sync)",
    trigger: "Dealer CRM",
    match: [
      "Follow-up 1",
      "Follow-up 2",
      "Contacted",
      "Contact in Future",
      "Not Qualified",
      "Dropped",
      "Lost",
      "Lost Lead",
      "Converted",
      "Won",
      "Delivered",
    ],
    description:
      "Dealer is actively working the lead in their own CRM; each status change syncs back to the OEM automatically.",
    outcome: "OEM status mirrors the dealer pipeline in real time, plus a daily reconcile.",
  },
  {
    id: "Happy 3",
    type: "happy",
    title: "Duplicate detected",
    trigger: "Middleware",
    match: ["Duplicate", "Linked", "DUPLICATE_LINKED"],
    description:
      "A new enquiry matched every configured mandatory business field for the same dealer within 15 minutes and was safely linked instead of being sent twice.",
    outcome: "No duplicate dealer record created; existing record linked with an audit note.",
  },
  {
    id: "Happy 4",
    type: "happy",
    title: "Integration recovery (replay)",
    trigger: "Scheduler",
    match: ["Replayed", "Recovered"],
    description:
      "Connectivity was restored after an outage and queued enquiries were replayed in order without creating duplicates.",
    outcome: "All valid enquiries delivered exactly once after recovery.",
  },
  {
    id: "Happy 5",
    type: "happy",
    title: "Data synchronisation (dealer → OEM)",
    trigger: "Dealer CRM",
    match: ["Synced", "Reconciled"],
    description:
      "Dealer-side field updates are mapped back to the OEM using per-field source-of-truth ownership rules.",
    outcome: "Both systems reflect the agreed source-of-truth data.",
  },
];

/* ----------------------------------------------------------------
   UNHAPPY PATHS
------------------------------------------------------------------ */
const UNHAPPY_PATHS = [
  {
    id: "Unhappy 1",
    type: "unhappy",
    title: "API / integration failure",
    trigger: "Middleware",
    match: ["Retry Pending", "Retrying", "DELIVERY_FAILED", "RETRY_EXHAUSTED"],
    description:
      "Push to the dealer failed with a timeout, 5xx, or connection error — a recoverable failure.",
    outcome:
      "Kept and retried with backoff for up to 24h; IT/FI alerted; included in the 12pm error report.",
  },
  {
    id: "Unhappy 2",
    type: "unhappy",
    title: "Invalid / missing data",
    trigger: "Middleware",
    match: ["Quarantined", "Data Error", "Validation Failed", "VALIDATION_HOLD"],
    description:
      "A mandatory field was missing or failed validation on ingest from the OEM. Not recoverable — no retry.",
    outcome: "Rejected / quarantined and logged for correction; the dealer CRM is never called.",
  },
  {
    id: "Unhappy 3",
    type: "unhappy",
    title: "Dealer unavailable",
    trigger: "Scheduler",
    match: ["Dealer Unavailable"],
    description: "The mapped dealer is inactive and the 24h retry window has been exhausted.",
    outcome:
      "Moved to a holding queue; status set to Dealer Unavailable; alert raised for admin re-route.",
  },
  {
    id: "Unhappy 4",
    type: "unhappy",
    title: "Status update failure (dealer → OEM)",
    trigger: "Middleware",
    match: ["Sync Failed"],
    description: "A dealer update was received but writing it back to the OEM failed.",
    outcome: "Retried with backoff and reconciled once successful; alert raised if it persists.",
  },
  {
    id: "Unhappy 5",
    type: "unhappy",
    title: "Wrong / rejected dealer mapping",
    trigger: "Middleware",
    match: ["Routing Exception", "ROUTING_HOLD"],
    description:
      "Postcode routing resolved to no dealer, an ambiguous dealer, or an invalid mapping.",
    outcome: "Held as a routing exception until the mapping is corrected, then reprocessed.",
  },
  {
    id: "Unhappy 6",
    type: "unhappy",
    title: "Ownership conflict",
    trigger: "Middleware",
    match: ["Ownership Conflict", "OWNERSHIP_CONFLICT"],
    description: "OEM and dealer updated the same field on the same enquiry at the same time.",
    outcome: "Resolved automatically using field-level source-of-truth and timestamp rules.",
  },
  {
    id: "Unhappy 7",
    type: "unhappy",
    title: "Out-of-order events",
    trigger: "Middleware",
    match: ["Pending Sequence", "PENDING_SEQUENCE"],
    description: "A status update arrived before its enquiry-created record existed.",
    outcome: "Held in a buffer and released once the prerequisite record exists.",
  },
  {
    id: "Unhappy 8",
    type: "unhappy",
    title: "Consent / privacy mismatch",
    trigger: "Middleware",
    match: ["Consent Hold", "CONSENT_HOLD"],
    description: "Consent or privacy data was missing or mismatched.",
    outcome:
      "Held/flagged until consent is validated; marketing-dependent data withheld until then.",
  },
  {
    id: "Unhappy 9",
    type: "unhappy",
    title: "Dealer rejects enquiry",
    trigger: "Dealer CRM",
    match: ["Junk", "Junk Lead", "Spam", "Junk Lead / Spam"],
    description: "The dealer explicitly marked the enquiry as spam or junk.",
    outcome: "MG status is set to Not Qualified; the dealer's own rejection wording is retained and shown in the activity log below, and alerts support.",
  },
  {
    id: "Unhappy 10",
    type: "unhappy",
    title: "SLA breach",
    trigger: "Scheduler",
    match: ["Unattended Alert"],
    description: "The dealer received the enquiry but took no action within 24 hours.",
    outcome: "Escalated; status set to Unattended Alert; dealer notified to action it.",
  },
  {
    id: "Unhappy 11",
    type: "unhappy",
    title: "Partial transaction",
    trigger: "Middleware",
    match: ["Reconciling", "ACK_UNRESOLVED"],
    description: "The OEM recorded the enquiry but dealer creation failed, leaving a mismatch.",
    outcome: "A reconciliation job re-attempts delivery or flags the mismatch for review.",
  },
  {
    id: "Unhappy 12",
    type: "unhappy",
    title: "Dealer CRM migration / offboarding",
    trigger: "Scheduler",
    match: ["Re-routing"],
    description: "The dealer changed CRM or left the network while the enquiry was still open.",
    outcome: "Re-routed to the next closest dealer without creating duplicates.",
  },
];

/* ----------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */

function formatFieldName(key) {
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatBoolean(value) {
  if (value === true || value === "true") return "Yes";
  if (value === false || value === "false") return "No";
  return "—";
}

function parseFieldChanges(entry) {
  if (!entry.field_changes) return [];
  try {
    const parsed = JSON.parse(entry.field_changes);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The human-readable half of an error_message.
 *
 * The backend records "CODE: detail" — e.g.
 *   LEAD_VALIDATION_FAILED: postcode is empty — Must be a valid four-digit
 *   Australian postcode
 * The code is for logs; the operator needs the part after it, which names
 * the field, what it holds and the rule it broke. A bare code with no
 * detail is not worth surfacing, so it is dropped.
 */
function errorDetailText(entry) {
  const raw = (entry.error_message || "").trim();
  if (!raw) return null;
  const separator = raw.indexOf(": ");
  if (separator === -1) return null;
  const detail = raw.slice(separator + 2).trim();
  return detail || null;
}

// Entries describing the dealer's response rather than a field change.
const DEALER_NOTE_FIELDS = new Set(["dealer_error", "dealer_response"]);

// What the dealer CRM said about an outbound attempt, as recorded by the
// adapter: what it did with an update (e.g. Fusion parked it for a person to
// accept, or ignored unmapped fields), or its error (status, problem
// title/detail, reference id, Retry-After).
function dealerNotes(changes) {
  const notes = [];
  const response = changes.find((c) => c.field === "dealer_response");
  if (response?.update_mode === "manual") notes.push("Awaiting dealer acceptance");
  if (response?.enquiry_linked === false) notes.push("Not yet in the dealer's pipeline");
  if (response?.ignored_fields?.length) notes.push(`Dealer ignored: ${response.ignored_fields.join(", ")}`);
  const error = changes.find((c) => c.field === "dealer_error");
  if (error) {
    const said = [error.title, error.detail].filter(Boolean).join(" — ");
    const ref = error.instance ? ` (ref ${error.instance})` : "";
    notes.push(`Dealer${error.status ? ` HTTP ${error.status}` : ""}: ${said || "error"}${ref}`);
    if (error.retryAfter != null) notes.push(`retry after ${error.retryAfter} s`);
  }
  return notes;
}

function timelineDetailText(entry) {
  const changes = parseFieldChanges(entry);
  // A failure usually carries no field changes - nothing was written. The
  // reason it failed is the only useful detail, and without this the
  // timeline showed the generic scenario title and nothing else, leaving
  // "Invalid / missing data" with no indication of WHICH field.
  if (changes.length === 0) return errorDetailText(entry);

  const deliveryTiming = changes.find((c) => c.field === "delivery_timing");
  if (deliveryTiming) {
    const notes = dealerNotes(changes);
    // A FAILED attempt's timing alone never says why it failed — e.g.
    // DEALER_ACK_MISSING_ID carries a diagnostic naming the dealer
    // response's actual field names, which is far more actionable than a
    // duration number. A successful attempt (acknowledged_at set) has no
    // error detail anyway, so it keeps showing timing as before.
    if (deliveryTiming.failed_at) {
      const detail = errorDetailText(entry);
      if (detail || notes.length > 0) return [detail, ...notes].filter(Boolean).join(" · ");
    }
    const resultTime = deliveryTiming.acknowledged_at || deliveryTiming.failed_at || "—";
    return [
      `Sent ${deliveryTiming.sent_at || "—"} · result ${resultTime} · ${deliveryTiming.duration_ms ?? "—"} ms`,
      ...notes,
    ].join(" · ");
  }

  const duplicateLink = changes.find((c) => c.field === "duplicate_link");
  if (duplicateLink) {
    const gap = duplicateLink.gap_minutes == null ? "unknown" : Number(duplicateLink.gap_minutes).toFixed(1);
    return `Linked ${duplicateLink.to || "—"} to ${duplicateLink.from || "—"} · ${gap} min gap`;
  }

  const statusChange = changes.find((c) => c.field === "lead_status");
  const otherChanges = changes.filter((c) => c.field !== "lead_status" && !DEALER_NOTE_FIELDS.has(c.field));

  // A dealer edit can change the status and other fields together; show
  // every field that changed, not just the status.
  const parts = [];
  if (statusChange) {
    parts.push(`Status changed: ${statusChange.from || "—"} → ${statusChange.to || "—"}`);
    // Unhappy 9: MG status is normalized to "Not Qualified" regardless of
    // the dealer's own wording (Junk Lead / Spam / etc.), so surface that
    // original wording here as the rejection reason — otherwise it would
    // only be visible in the entry's title, not the detail line.
    if (
      /^unhappy 9/i.test(entry.happy_unhappy_path_name || "") &&
      statusChange.raw_dealer_value &&
      statusChange.raw_dealer_value !== statusChange.to
    ) {
      parts.push(`Dealer rejection reason: "${statusChange.raw_dealer_value}"`);
    }
  }
  otherChanges.forEach((c) => {
    parts.push(`${formatFieldName(c.field)}: "${c.from || "—"}" → "${c.to || "—"}"`);
  });
  // A skipped update carries only what the dealer said (no timing).
  parts.push(...dealerNotes(changes));

  return parts.length > 0 ? parts.join(" · ") : null;
}

function scenarioFromLog(entry) {
  const name = (entry.happy_unhappy_path_name || "").trim();
  const isHappy = /^happy/i.test(name);
  const isUnhappy = /^unhappy/i.test(name);
  return {
    id: name || null,
    tone: isHappy ? "happy" : isUnhappy ? "unhappy" : "neutral",
    label: entry.happy_unhappy_path_message || name || entry.operation || "Activity",
  };
}

// Every distinct Happy/Unhappy scenario this lead has passed through,
// in the order it first happened — used to show the lead's full
// "journey" (e.g. Happy 1 → Happy 2 → Happy 5) rather than only its
// current/latest state.
function getDistinctPaths(timeline) {
  const seen = new Map();
  timeline.forEach((entry) => {
    const name = (entry.happy_unhappy_path_name || "").trim();
    if (!name || seen.has(name)) return;
    seen.set(name, {
      id: name,
      type: /^happy/i.test(name) ? "happy" : "unhappy",
      message: entry.happy_unhappy_path_message || name,
    });
  });
  return Array.from(seen.values());
}

function ActivityTimeline({ timeline, loading }) {
  if (loading) {
    return (
      <li className="lead-detail__timeline-empty" aria-busy="true" style={{ listStyle: "none", padding: 0 }}>
        <CompactListSkeleton rows={3} />
      </li>
    );
  }
  if (!timeline || timeline.length === 0) {
    return <li className="lead-detail__timeline-empty">No activity recorded yet.</li>;
  }
  return timeline.map((entry, idx) => {
    const scenario = scenarioFromLog(entry);
    const detailText = timelineDetailText(entry);
    return (
      <li
        className={`lead-detail__timeline-item lead-detail__timeline-item--${scenario.tone}`}
        key={entry.ROWID || idx}
      >
        <span className={`lead-detail__timeline-dot lead-detail__timeline-dot--${scenario.tone}`}>
          {scenario.tone === "happy" ? (
            <CheckCircleIcon />
          ) : scenario.tone === "unhappy" ? (
            <AlertCircleIcon />
          ) : (
            <DotsCircleIcon />
          )}
        </span>
        <div>
          <div className="lead-detail__timeline-title-row">
            <p className="lead-detail__timeline-title">{scenario.label}</p>
            {scenario.id && (
              <PathBadge name={scenario.id} />
            )}
          </div>
          {detailText && <p className="lead-detail__timeline-detail">{detailText}</p>}
          <p className="lead-detail__timeline-time">{entry.created_at || "—"}</p>
        </div>
      </li>
    );
  });
}

function normalize(value) {
  return (value ?? "").toString().trim().toLowerCase().replace(/[-_]+/g, " ");
}

function findScenarioForStatus(status, scenarios) {
  const normalizedTarget = normalize(status);
  if (!normalizedTarget) return null;

  return (
    scenarios.find((scenario) =>
      scenario.match.some((candidate) => normalize(candidate) === normalizedTarget)
    ) || null
  );
}

function matchPathScenario(lead) {
  const all = [...UNHAPPY_PATHS, ...HAPPY_PATHS];

  return (
    findScenarioForStatus(lead.lead_status, all) || findScenarioForStatus(lead.sync_status, all)
  );
}

/**
 * The scenario implied by the lead's SYNC state alone.
 *
 * lead_status is the business status (Not Contacted, Contacted, Lost...),
 * sync_status is the integration state (VALIDATION_HOLD, CONSENT_HOLD...).
 * A lead can legitimately hold both at once: the dealer has not actioned it
 * yet AND delivery is blocked on a bad mobile number. Only the sync state
 * describes the integration path, so a held lead must be resolved from it.
 */
function matchSyncScenario(lead) {
  return findScenarioForStatus(lead.sync_status, [...UNHAPPY_PATHS, ...HAPPY_PATHS]);
}

function classifyPath(lead) {
  const match = matchPathScenario(lead);

  if (match) {
    return match;
  }

  return {
    id: "Unclassified",
    type: "neutral",
    title: "Status not yet mapped",
    trigger: "—",
    description: `Neither lead_status ("${lead.lead_status || "—"}") nor sync_status ("${
      lead.sync_status || "—"
    }") matches a known Happy/Unhappy scenario yet.`,
    outcome:
      "Update the match lists in LeadDetailView.jsx once the real backend status values are confirmed.",
  };
}

/**
 * Resolves which Integration Path scenario to display for this lead.
 *
 * FIX: previously this trusted lead.happy_unhappy_path_name unconditionally
 * whenever it was non-empty — but that field is written by a SEPARATE
 * backend call (writeLog's mirror block) from the one that sets
 * lead_status (handleConsentMismatch / recordOutboundFailureAndCheckEscalation
 * etc write lead_status directly). If the mirror write ever lags, fails
 * silently, or simply hasn't run yet for the lead's CURRENT status, the
 * stored name goes stale — e.g. lead_status correctly says "Consent Hold"
 * but happy_unhappy_path_name still holds an old "Unhappy 1" from a
 * previous failed attempt. Since a stale string is still truthy, the old
 * code would display the wrong badge even though the pill (driven by
 * lead_status directly) was correct.
 *
 * Explicit hold states take priority so a stale audit mirror cannot hide
 * an active fault. Otherwise the backend's stored scenario is authoritative;
 * this preserves outcomes such as Happy 4 recovery even when the business
 * status itself has already returned to Not Contacted.
 */
function resolveDisplayPath(lead) {
  const liveMatch = matchPathScenario(lead);
  const urgentSyncStates = new Set([
    "validation hold",
    "consent hold",
    "routing hold",
    "delivery failed",
    "failed critical",
    "sla breach",
    "reconcile mismatch",
    "held",
    "retry exhausted",
    "ack unresolved",
  ]);

  // BUG THIS FIXES: this branch used to return `liveMatch`, but
  // matchPathScenario resolves lead_status FIRST — and "Not Contacted" is
  // Happy 1's own MG status. So a lead held on VALIDATION_HOLD with
  // lead_status "Not Contacted" was displayed as Happy 1: the guard meant to
  // surface an active fault was announcing a successful delivery instead,
  // overriding the correct Unhappy 2 the backend had already recorded.
  // A held lead must be described by its SYNC state, never its business
  // status, so resolve from sync_status and fall back to the stored
  // scenario rather than to lead_status.
  if (urgentSyncStates.has(normalize(lead.sync_status))) {
    const heldMatch = matchSyncScenario(lead);
    if (heldMatch) return heldMatch;

    const storedHeld = [...HAPPY_PATHS, ...UNHAPPY_PATHS].find(
      (scenario) => scenario.id === lead.happy_unhappy_path_name
    );
    if (storedHeld) return storedHeld;
  }

  if (lead.happy_unhappy_path_name) {
    const configured = [...HAPPY_PATHS, ...UNHAPPY_PATHS].find(
      (scenario) => scenario.id === lead.happy_unhappy_path_name
    );
    if (configured) return configured;
    return {
      id: lead.happy_unhappy_path_name,
      type: /^happy/i.test(lead.happy_unhappy_path_name) ? "happy" : "unhappy",
      title: lead.happy_unhappy_path_message || lead.happy_unhappy_path_name,
      trigger: "—",
      description: lead.happy_unhappy_path_message || "",
    };
  }

  if (liveMatch) return liveMatch;

  return classifyPath(lead);
}

function initials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

/* ----------------------------------------------------------------
   Inline Icons
------------------------------------------------------------------ */
function CopyIcon(props) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckCircleIcon(props) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function AlertCircleIcon(props) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function DotsCircleIcon(props) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="8" cy="12" r="0.6" fill="currentColor" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
      <circle cx="16" cy="12" r="0.6" fill="currentColor" />
    </svg>
  );
}

/* ----------------------------------------------------------------
   Status Pill
------------------------------------------------------------------ */
function StatusPill({ status }) {
  const tone = STATUS_TONES[status] || "neutral";

  return (
    <span className={`lead-detail__status-pill lead-detail__status-pill--${tone}`}>
      <span className="lead-detail__status-dot" />
      {status || "—"}
    </span>
  );
}

/* ----------------------------------------------------------------
   Path Chips — every distinct scenario this lead's journey has
   passed through, shown together in the hero and Integration Path
   card. The current/latest scenario is visually emphasized.
------------------------------------------------------------------ */
function PathChips({ paths, currentId }) {
  if (!paths || paths.length === 0) return null;

  return (
    <div className="lead-detail__path-chips">
      {paths.map((p) => {
        const isCurrent = p.id === currentId;
        return <PathBadge key={p.id} name={p.id} current={isCurrent} size="md" title={p.message} />;
      })}
    </div>
  );
}

/* ----------------------------------------------------------------
   Integration Path Card
------------------------------------------------------------------ */
function IntegrationPathCard({ path, journeyPaths, failureDetail }) {
  return (
    <section className={`lead-detail__group lead-detail__path-card lead-detail__path-card--${path.type}`}>
      <h3>
        <span className="lead-detail__group-icon">
          <ClipboardIcon size={15} />
        </span>
        Integration Path
      </h3>

      {journeyPaths.length > 1 && (
        <div className="lead-detail__journey">
          <span className="lead-detail__journey-label">This lead's journey:</span>
          <div className="lead-detail__journey-chips">
            {journeyPaths.map((p, idx) => (
              <span key={p.id} className="lead-detail__journey-step">
                <PathBadge name={p.id} title={p.message} />
                {idx < journeyPaths.length - 1 && (
                  <ArrowRightIcon size={12} className="lead-detail__journey-arrow" />
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="lead-detail__path-card-body">
        <PathBadge name={path.id} size="md" className="lead-detail__path-id" />

        <div className="lead-detail__path-card-text">
          <p className="lead-detail__path-card-title">{path.title}</p>

          {path.trigger && path.trigger !== "—" && (
            <p className="lead-detail__path-card-trigger">Trigger source: {path.trigger}</p>
          )}

          <p className="lead-detail__path-card-desc">{path.description}</p>

          {path.outcome && (
            <p className="lead-detail__path-card-outcome">
              <strong>Expected outcome:</strong> {path.outcome}
            </p>
          )}

          {/* The scenario description explains the PATH; this explains why
              THIS lead is on it. Without it an operator sees "Invalid /
              missing data" and still has to guess which field is at fault. */}
          {failureDetail && (
            <p className="lead-detail__path-card-reason">
              <strong>What needs fixing:</strong> {failureDetail}
            </p>
          )}

        </div>
      </div>
    </section>
  );
}

function MoreDetailsCard({ val, lead }) {
  // Confirms the dealer CRM actually accepted and created the record for
  // this enquiry (Happy 1). Written once the outbound push succeeds and
  // cleared if reconciliation later finds the dealer no longer has it, so
  // an operator can tell "delivered" apart from "dealer never got this".
  const dealerCrmRecordId = lead.dealer_crm_record_id;

  const [copiedKey, setCopiedKey] = useState(null);
  const copyValue = (key, value) => {
    if (!value) return;
    navigator.clipboard?.writeText(String(value));
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  // Grouped so the long record IDs sit together, apart from the lead facts and
  // the consent flags. `mono` = identifier styling, `copy` = copy button.
  const sections = [
    {
      title: "Record IDs",
      className: "lead-detail__more-details-grid--ids",
      items: [
        { key: "crm", label: "CRM Record ID", value: val("crm_record_id"), icon: ClipboardIcon, mono: true, copy: true },
        {
          key: "dealer",
          label: "Dealer CRM Record ID",
          value: dealerCrmRecordId || "Not yet confirmed by dealer",
          valueClass: dealerCrmRecordId
            ? "lead-detail__more-details-value--confirmed"
            : "lead-detail__more-details-value--pending",
          icon: ClipboardIcon,
          mono: Boolean(dealerCrmRecordId),
          copy: Boolean(dealerCrmRecordId),
          rawValue: dealerCrmRecordId,
        },
        { key: "enquiry", label: "Enquiry ID", value: val("enquiry_id"), icon: ClipboardIcon, mono: true, copy: true },
      ],
    },
    {
      title: "Lead Info",
      items: [
        { key: "source", label: "Lead Source", value: val("lead_source"), icon: MegaphoneIcon },
        { key: "postcode", label: "Postcode", value: val("postcode"), icon: BuildingIcon },
        { key: "assigned", label: "Assigned Date", value: val("assigned_date"), icon: ClockIcon },
        { key: "status", label: "Last Status Update", value: val("last_status_update"), icon: ClockIcon },
        { key: "followup", label: "Next Follow-up", value: val("next_followup_date"), icon: ClockIcon },
      ],
    },
    {
      title: "Consent",
      items: [
        { key: "privacy", label: "Privacy Policy Accepted", value: formatBoolean(lead.accept_privacy_policy), icon: UserIcon, pill: true },
        { key: "marketing", label: "Marketing Opt-in", value: formatBoolean(lead.receive_marketing_updates), icon: MegaphoneIcon, pill: true },
      ],
    },
  ];

  return (
    <section className="lead-detail__group lead-detail__more-details-card">
      <h3>
        <span className="lead-detail__group-icon">
          <ClipboardIcon size={15} />
        </span>
        More Details
      </h3>
      {sections.map((section) => (
        <div className="lead-detail__more-details-section" key={section.title}>
          <h4 className="lead-detail__more-details-section-title">{section.title}</h4>
          <div className={`lead-detail__more-details-grid ${section.className || ""}`}>
            {section.items.map(({ key, label, value, valueClass, icon: Icon, mono, copy, pill, rawValue }) => (
              <div className="lead-detail__more-details-item" key={key}>
                <span className="lead-detail__more-details-icon">
                  <Icon size={15} />
                </span>
                <div>
                  <span className="lead-detail__more-details-label">{label}</span>
                  <span className="lead-detail__more-details-valuewrap">
                    {pill ? (
                      <span
                        className={`lead-detail__more-details-pill ${
                          value === "Yes" ? "lead-detail__more-details-pill--yes" : "lead-detail__more-details-pill--no"
                        }`}
                      >
                        {value}
                      </span>
                    ) : (
                      <span
                        className={`lead-detail__more-details-value ${mono ? "lead-detail__more-details-value--mono" : ""} ${valueClass || ""}`}
                        title={typeof value === "string" ? value : undefined}
                      >
                        {value}
                      </span>
                    )}
                    {copy && (rawValue ?? value) && (rawValue ?? value) !== "—" && (
                      <button
                        type="button"
                        className="lead-detail__copy-btn"
                        onClick={() => copyValue(key, rawValue ?? value)}
                        aria-label={`Copy ${label}`}
                      >
                        <CopyIcon />
                      </button>
                    )}
                    {copiedKey === key && <span className="lead-detail__copied-tag">Copied</span>}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

/* ----------------------------------------------------------------
   Delivery actions (admins): a lead whose delivery stopped.
     ACK_UNRESOLVED   the dealer accepted it without returning its id, so it
                      is never sent again; link the id from the dealer's CRM.
     RETRY_EXHAUSTED  automatic retries stopped; retry the delivery now.
------------------------------------------------------------------ */
function DeliveryActions({ lead, onDone }) {
  const { user } = useAuth();
  const [externalLeadId, setExternalLeadId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const state = String(lead.sync_status || "").toUpperCase();
  const isAdmin = [APP_ROLES.ADMIN, APP_ROLES.SUPER_ADMIN].includes(user?.appRole);
  if (!isAdmin || !["ACK_UNRESOLVED", "RETRY_EXHAUSTED"].includes(state)) return null;

  const run = async (action, done) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      setMessage({ tone: "success", text: done });
      // The action itself worked; a failed reload afterwards must not read as an action error.
      Promise.resolve(onDone?.()).catch(() => {});
    } catch (err) {
      setMessage({ tone: "error", text: err?.response?.data?.error || "The action failed. Try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="lead-detail__group lead-detail__delivery-actions">
      <h3>Delivery needs attention</h3>
      {state === "ACK_UNRESOLVED" ? (
        <>
          <p>
            The dealer accepted this lead but returned no lead id, so it is not sent again. Find the lead in
            the dealer's CRM and enter its id to link it.
          </p>
          <div className="lead-detail__delivery-form">
            <input
              type="text"
              value={externalLeadId}
              onChange={(e) => setExternalLeadId(e.target.value)}
              placeholder="Dealer lead id, e.g. lead_01…"
              aria-label="Dealer lead id"
            />
            <button
              type="button"
              className="lead-detail__action-btn lead-detail__action-btn--mail"
              disabled={busy || !externalLeadId.trim()}
              onClick={() =>
                run(
                  () => dealerCrmIntegrationService.linkLead(lead.dealer_code, lead.crm_record_id, externalLeadId.trim()),
                  "Linked to the dealer's lead."
                )
              }
            >
              Link dealer lead id
            </button>
          </div>
        </>
      ) : (
        <>
          <p>Automatic retries for this lead have stopped. Retry the delivery once the cause is fixed.</p>
          <button
            type="button"
            className="lead-detail__action-btn lead-detail__action-btn--mail"
            disabled={busy}
            onClick={() =>
              run(() => dealerCrmIntegrationService.replayLead(lead.dealer_code, lead.crm_record_id), "Delivery retried.")
            }
          >
            Retry delivery
          </button>
        </>
      )}
      {message && (
        <p className={`lead-detail__delivery-message lead-detail__delivery-message--${message.tone}`}>{message.text}</p>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------
   Lead Detail
------------------------------------------------------------------ */
/* A Data Store UTC datetime ("2026-11-10 07:03:53") as Australian local time. */
function formatAuDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "—";
  const parsed = new Date(`${text.replace(" ", "T").slice(0, 19)}Z`);
  if (Number.isNaN(parsed.getTime())) return text;
  return parsed.toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney" });
}

/* ----------------------------------------------------------------
   A contact line in the side card: label, value, copy, quick action
------------------------------------------------------------------ */
function ContactRow({ icon, label, value, copied, onCopy, href, actionLabel, actionIcon, warning }) {
  const empty = value === "—";
  return (
    <div className="ld-contact">
      <span className="ld-contact__icon">{icon}</span>
      <div className="ld-contact__body">
        <span className="ld-contact__label">{label}</span>
        <span className="ld-contact__value">
          {value}
          {!empty && (
            <button type="button" className="lead-detail__copy-btn" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`}>
              <CopyIcon />
            </button>
          )}
          {copied && <span className="lead-detail__copied-tag">Copied</span>}
        </span>
        {warning && (
          <span className="lead-detail__mobile-warning" title={warning}>
            <AlertCircleIcon /> {warning}
          </span>
        )}
      </div>
      {!empty && href && (
        <a href={href} className="ld-contact__action">
          {actionIcon}
          {actionLabel}
        </a>
      )}
    </div>
  );
}

export default function LeadDetailView({ lead, onBack, onLeadChanged }) {
  const [copied, setCopied] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [tab, setTab] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(() => new Date());
  const { showAlert } = useAlerts();

  // quiet = a refresh: keep showing the current timeline instead of the skeleton.
  const loadTimeline = useCallback(async ({ quiet = false } = {}) => {
    if (!lead.crm_record_id) {
      setTimelineLoading(false);
      return;
    }
    if (!quiet) setTimelineLoading(true);
    try {
      const rows = await adminDashboardService.getLeadTimeline(lead.crm_record_id);
      setTimeline(rows || []);
    } catch (err) {
      if (!quiet) setTimeline([]);
      else throw err;
    } finally {
      setTimelineLoading(false);
    }
  }, [lead.crm_record_id]);

  useEffect(() => {
    loadTimeline().catch(() => {});
  }, [loadTimeline]);

  // Reloads the lead (and the list behind it) and its activity timeline.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([onLeadChanged?.(), loadTimeline({ quiet: true })]);
      setUpdatedAt(new Date());
    } catch (err) {
      showAlert("error", "Couldn't refresh this lead. Try again.");
    } finally {
      setRefreshing(false);
    }
  };

  const val = (key) => {
    const value = lead[key];
    return value && String(value).trim() ? value : "—";
  };

  const isRemoved = normalize(lead.sync_status) === "removed";

  const mobile = val("mobile_number");
  const email = val("email_address");
  // UI-only flag: an invalid/non-Australian mobile number is never blocked
  // from the dealer CRM push or the normal Happy Path — it's just
  // highlighted here so an operator can follow up if needed.
  const mobileIsInvalid = mobile !== "—" && !isValidAustralianMobile(mobile);

  // FIX: was `lead.happy_unhappy_path_name ? {...} : classifyPath(lead)`,
  // which trusted a possibly-stale stored name over the lead's live
  // status. See resolveDisplayPath's comment above for why.
  const path = resolveDisplayPath(lead);

  const journeyPaths = getDistinctPaths(timeline);

  // The reason behind the CURRENT path, taken from the most recent failure
  // on this lead. getLeadActivityTimeline returns oldest-first, so the last
  // failing entry is the live one. Only shown while the lead is actually on
  // an unhappy path - a recovered lead should not still display the fault
  // that has since been fixed.
  const latestFailureDetail = (() => {
    if (!path || path.type !== "unhappy") return null;
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const detail = errorDetailText(timeline[i]);
      if (detail) return detail;
    }
    return null;
  })();

  const handleCopy = (key, value) => {
    if (!value || value === "—") return;
    navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  // Opens on the Integration tab when the lead is on an unhappy path, so the thing that
  // needs attention is the first thing seen.
  const activeTab = tab || (path.type === "unhappy" ? "integration" : "overview");
  const TABS = [
    { id: "overview", label: "Overview" },
    { id: "integration", label: "Integration", alert: path.type === "unhappy" },
    { id: "timeline", label: "Timeline", count: timeline.length || null },
    { id: "details", label: "Details" },
  ];

  return (
    <div className={`lx${refreshing ? " lx--refreshing" : ""}`}>
      <div className="lx-topbar">
        <button type="button" className="lx-back" onClick={onBack}>
          <ChevronLeftIcon size={16} />
          Leads
        </button>

        <div className="lx-topbar__end">
          <span className="lx-updated" aria-live="polite">
            {refreshing
              ? "Refreshing..."
              : `Updated ${updatedAt.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", second: "2-digit" })}`}
          </span>
          <button
            type="button"
            className={`lx-refresh${refreshing ? " lx-refresh--spinning" : ""}`}
            onClick={handleRefresh}
            disabled={refreshing}
            aria-label="Refresh this lead"
            title="Reload this lead and its activity timeline"
          >
            <RefreshCw size={15} strokeWidth={2.2} />
            Refresh
          </button>
        </div>
        <div className="lx-loadbar" aria-hidden="true" />
      </div>

      {/* ====================================================== HEADER ====================================================== */}
      <header className="lx-header">
        <div className="lx-header__top">
          <span className="lx-avatar">{initials(lead.customer_name)}</span>
          <div className="lx-header__id">
            <div className="lx-header__title">
              <h1>{lead.customer_name || "Unnamed Customer"}</h1>
              {isRemoved ? <StatusPill status="Removed" /> : <StatusPill status={lead.lead_status} />}
            </div>
            <div className="lx-header__meta">
              <BuildingIcon size={14} />
              <span>{val("dealer_name")}</span>
              <span className="lx-dot" />
              <span>Code {val("dealer_code")}</span>
              {lead.lead_source && (
                <>
                  <span className="lx-dot" />
                  <MegaphoneIcon size={13} />
                  <span>{lead.lead_source}</span>
                </>
              )}
            </div>
          </div>
          <PathChips paths={journeyPaths.length > 0 ? journeyPaths : [path]} currentId={path.id} />
        </div>

        <dl className="lx-facts">
          <div className="lx-facts__cell">
            <dt>Vehicle</dt>
            <dd>{val("vehicle_model")}</dd>
          </div>
          <div className="lx-facts__cell">
            <dt>Enquiry ID</dt>
            <dd className="lx-mono">
              {val("enquiry_id")}
              {val("enquiry_id") !== "\u2014" && (
                <button type="button" className="lx-copy" onClick={() => handleCopy("enquiry", val("enquiry_id"))} aria-label="Copy enquiry ID">
                  <CopyIcon />
                </button>
              )}
              {copied === "enquiry" && <span className="lx-copied">Copied</span>}
            </dd>
          </div>
          <div className="lx-facts__cell">
            <dt>Created</dt>
            <dd>{formatAuDateTime(lead.assigned_date)}</dd>
          </div>
          <div className="lx-facts__cell">
            <dt>Last status update</dt>
            <dd>{formatAuDateTime(lead.last_status_update)}</dd>
          </div>
        </dl>
      </header>

      {/* ====================================================== TABS ====================================================== */}
      <nav className="lx-tabs" role="tablist" aria-label="Lead sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`lx-tab-${t.id}`}
            aria-selected={activeTab === t.id}
            aria-controls={`lx-panel-${t.id}`}
            className={`lx-tab${activeTab === t.id ? " lx-tab--active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.alert && <span className="lx-tab__alert" aria-label="needs attention" />}
            {t.count ? <span className="lx-tab__count">{t.count}</span> : null}
          </button>
        ))}
      </nav>

      <div className="lx-panel" role="tabpanel" id={`lx-panel-${activeTab}`} aria-labelledby={`lx-tab-${activeTab}`}>
        {activeTab === "overview" && (
          <div className="lx-overview">
            <button type="button" className={`lx-callout lx-callout--${path.type}`} onClick={() => setTab("integration")}>
              <PathBadge name={path.id} size="md" />
              <span className="lx-callout__text">
                <strong>{path.title}</strong>
                {latestFailureDetail && <span>{latestFailureDetail}</span>}
              </span>
              <span className="lx-callout__go">
                View integration <ArrowRightIcon size={14} />
              </span>
            </button>

            <div className="lx-cards">
              <section className="lead-detail__group lx-card">
                <h3>
                  <span className="lead-detail__group-icon">
                    <UserIcon size={15} />
                  </span>
                  Contact
                </h3>
                <ContactRow
                  icon={<PhoneIcon size={16} />}
                  label="Mobile"
                  value={mobile}
                  copied={copied === "mobile"}
                  onCopy={() => handleCopy("mobile", mobile)}
                  href={`tel:${mobile}`}
                  actionLabel="Call"
                  actionIcon={<PhoneIcon size={13} />}
                  warning={mobileIsInvalid ? "Invalid Australian Mobile" : null}
                />
                <ContactRow
                  icon={<MailIcon size={16} />}
                  label="Email"
                  value={email}
                  copied={copied === "email"}
                  onCopy={() => handleCopy("email", email)}
                  href={`mailto:${email}`}
                  actionLabel="Email"
                  actionIcon={<MailIcon size={13} />}
                />
              </section>

              <section className="lead-detail__group lx-card">
                <h3>
                  <span className="lead-detail__group-icon">
                    <CarIcon size={15} />
                  </span>
                  Enquiry
                </h3>
                <dl className="lx-kv">
                  <div><dt>Lead source</dt><dd>{val("lead_source")}</dd></div>
                  <div><dt>Dealer</dt><dd>{val("dealer_name")}</dd></div>
                  <div><dt>Dealer code</dt><dd>{val("dealer_code")}</dd></div>
                  <div><dt>Postcode</dt><dd>{val("postcode")}</dd></div>
                </dl>
              </section>

              <section className="lead-detail__group lx-card">
                <h3>
                  <span className="lead-detail__group-icon">
                    <NoteIcon size={15} />
                  </span>
                  Customer Message
                </h3>
                <p className="lead-detail__remarks-text">
                  {val("customer_message") !== "\u2014" ? val("customer_message") : "No message from customer yet."}
                </p>
              </section>

              <section className="lead-detail__group lx-card">
                <h3>
                  <span className="lead-detail__group-icon">
                    <PencilIcon size={15} />
                  </span>
                  Dealer Remarks
                </h3>
                <p className="lead-detail__remarks-text">
                  {val("dealer_remarks") !== "\u2014" ? val("dealer_remarks") : "No remarks yet."}
                </p>
              </section>
            </div>
          </div>
        )}

        {activeTab === "integration" && (
          <div className="lx-stack">
            <IntegrationPathCard path={path} journeyPaths={journeyPaths} failureDetail={latestFailureDetail} />
            <DeliveryActions lead={lead} onDone={onLeadChanged} />
          </div>
        )}

        {activeTab === "timeline" && (
          <section className="lead-detail__group lx-card lx-timeline">
            <h3>
              <span className="lead-detail__group-icon">
                <ClockIcon size={15} />
              </span>
              Activity Timeline
            </h3>
            <ul className="lead-detail__timeline">
              <ActivityTimeline timeline={timeline} loading={timelineLoading} />
            </ul>
          </section>
        )}

        {activeTab === "details" && <MoreDetailsCard val={val} lead={lead} />}
      </div>
    </div>
  );
}
