
import { useState } from "react";
import Badge from "../../ui/Badge/Badge";
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
import mgLogo from "../../assets/images/mg-logo-single.png";
import "./LeadDetailView.css";

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
  Dropped: "danger",
  "Not Qualified": "danger",
  Rejected: "danger",
  "Dealer Unavailable": "danger",
  "Unattended Alert": "danger",
  Removed: "danger",
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
    outcome:
      "Status moves Update Pending → Not Contacted once the dealer acknowledges receipt.",
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
    ],
    description:
      "Dealer is actively working the lead in their own CRM; each status change syncs back to the OEM automatically.",
    outcome:
      "OEM status mirrors the dealer pipeline in real time, plus a daily reconcile.",
  },
  {
    id: "Happy 3",
    type: "happy",
    title: "Duplicate detected",
    trigger: "Middleware",
    match: ["Duplicate", "Linked"],
    description:
      "An inbound enquiry matched an existing record (same ID, or same email/mobile + name) and was safely linked instead of creating a duplicate.",
    outcome:
      "No duplicate dealer record created; existing record linked with an audit note.",
  },
  {
    id: "Happy 4",
    type: "happy",
    title: "Integration recovery (replay)",
    trigger: "Scheduler",
    match: ["Replayed", "Recovered"],
    description:
      "Connectivity was restored after an outage and queued enquiries were replayed in order without creating duplicates.",
    outcome:
      "All valid enquiries delivered exactly once after recovery.",
  },
  {
    id: "Happy 5",
    type: "happy",
    title: "Data synchronisation (dealer → OEM)",
    trigger: "Dealer CRM",
    match: ["Synced", "Reconciled"],
    description:
      "Dealer-side field updates are mapped back to the OEM using per-field source-of-truth ownership rules.",
    outcome:
      "Both systems reflect the agreed source-of-truth data.",
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
    match: ["Retry Pending", "Retrying"],
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
    match: ["Quarantined", "Data Error", "Validation Failed"],
    description:
      "A mandatory field was missing or failed validation on ingest from the OEM. Not recoverable — no retry.",
    outcome:
      "Rejected / quarantined and logged for correction; the dealer CRM is never called.",
  },
  {
    id: "Unhappy 3",
    type: "unhappy",
    title: "Dealer unavailable",
    trigger: "Scheduler",
    match: ["Dealer Unavailable"],
    description:
      "The mapped dealer is inactive and the 24h retry window has been exhausted.",
    outcome:
      "Moved to a holding queue; status set to Dealer Unavailable; alert raised for admin re-route.",
  },
  {
    id: "Unhappy 4",
    type: "unhappy",
    title: "Status update failure (dealer → OEM)",
    trigger: "Middleware",
    match: ["Sync Failed"],
    description:
      "A dealer update was received but writing it back to the OEM failed.",
    outcome:
      "Retried with backoff and reconciled once successful; alert raised if it persists.",
  },
  {
    id: "Unhappy 5",
    type: "unhappy",
    title: "Wrong / rejected dealer mapping",
    trigger: "Middleware",
    match: ["Routing Exception"],
    description:
      "Postcode routing resolved to no dealer, an ambiguous dealer, or an invalid mapping.",
    outcome:
      "Held as a routing exception until the mapping is corrected, then reprocessed.",
  },
  {
    id: "Unhappy 6",
    type: "unhappy",
    title: "Ownership conflict",
    trigger: "Middleware",
    match: ["Ownership Conflict"],
    description:
      "OEM and dealer updated the same field on the same enquiry at the same time.",
    outcome:
      "Resolved automatically using field-level source-of-truth and timestamp rules.",
  },
  {
    id: "Unhappy 7",
    type: "unhappy",
    title: "Out-of-order events",
    trigger: "Middleware",
    match: ["Pending Sequence"],
    description:
      "A status update arrived before its enquiry-created record existed.",
    outcome:
      "Held in a buffer and released once the prerequisite record exists.",
  },
  {
    id: "Unhappy 8",
    type: "unhappy",
    title: "Consent / privacy mismatch",
    trigger: "Middleware",
    match: ["Consent Hold"],
    description:
      "Consent or privacy data was missing or mismatched.",
    outcome:
      "Held/flagged until consent is validated; marketing-dependent data withheld until then.",
  },
  {
    id: "Unhappy 9",
    type: "unhappy",
    title: "Dealer rejects enquiry",
    trigger: "Dealer CRM",
    match: ["Rejected", "Not Qualified"],
    description:
      "The dealer marked the enquiry as spam or invalid.",
    outcome:
      "Rejection reason captured and mapped to an OEM status.",
  },
  {
    id: "Unhappy 10",
    type: "unhappy",
    title: "SLA breach",
    trigger: "Scheduler",
    match: ["Unattended Alert"],
    description:
      "The dealer received the enquiry but took no action within 24 hours.",
    outcome:
      "Escalated; status set to Unattended Alert; dealer notified to action it.",
  },
  {
    id: "Unhappy 11",
    type: "unhappy",
    title: "Partial transaction",
    trigger: "Middleware",
    match: ["Reconciling"],
    description:
      "The OEM recorded the enquiry but dealer creation failed, leaving a mismatch.",
    outcome:
      "A reconciliation job re-attempts delivery or flags the mismatch for review.",
  },
  {
    id: "Unhappy 12",
    type: "unhappy",
    title: "Dealer CRM migration / offboarding",
    trigger: "Scheduler",
    match: ["Re-routing"],
    description:
      "The dealer changed CRM or left the network while the enquiry was still open.",
    outcome:
      "Re-routed to the next closest dealer without creating duplicates.",
  },
];

/* ----------------------------------------------------------------
   Helpers
------------------------------------------------------------------ */
function normalize(value) {
  return (value ?? "").toString().trim().toLowerCase();
}

function matchPathScenario(lead) {
  const leadStatus = normalize(lead.lead_status);
  const syncStatus = normalize(lead.sync_status);

  const all = [...UNHAPPY_PATHS, ...HAPPY_PATHS];

  for (const scenario of all) {
    const hit = scenario.match.some((status) => {
      const normalizedStatus = normalize(status);

      return (
        normalizedStatus === leadStatus ||
        normalizedStatus === syncStatus
      );
    });

    if (hit) {
      return scenario;
    }
  }

  return null;
}

function classifyPath(lead) {
  if (normalize(lead.sync_status) === "removed") {
    const base = UNHAPPY_PATHS.find(
      (scenario) => scenario.id === "Unhappy 3"
    );

    return {
      ...base,
      assumed: true,
    };
  }

  const match = matchPathScenario(lead);

  if (match) {
    return match;
  }

  return {
    id: "Unclassified",
    type: "neutral",
    title: "Status not yet mapped",
    trigger: "—",
    description: `Neither lead_status ("${
      lead.lead_status || "—"
    }") nor sync_status ("${
      lead.sync_status || "—"
    }") matches a known Happy/Unhappy scenario yet.`,
    outcome:
      "Update the match lists in LeadDetailView.jsx once the real backend status values are confirmed.",
  };
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
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckCircleIcon(props) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function AlertCircleIcon(props) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

function DotsCircleIcon(props) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
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
    <span
      className={`lead-detail__status-pill lead-detail__status-pill--${tone}`}
    >
      <span className="lead-detail__status-dot" />
      {status || "—"}
    </span>
  );
}

/* ----------------------------------------------------------------
   Path Badge
------------------------------------------------------------------ */
function PathBadge({ path }) {
  const Icon =
    path.type === "happy"
      ? CheckCircleIcon
      : path.type === "unhappy"
        ? AlertCircleIcon
        : DotsCircleIcon;

  return (
    <span
      className={`lead-detail__path-badge lead-detail__path-badge--${path.type}`}
      title={path.title}
    >
      <Icon />
      {path.id}
    </span>
  );
}

/* ----------------------------------------------------------------
   Integration Path Card
------------------------------------------------------------------ */
function IntegrationPathCard({ path }) {
  return (
    <section
      className={`lead-detail__group lead-detail__path-card lead-detail__path-card--${path.type}`}
    >
      <h3>
        <span className="lead-detail__group-icon">
          <ClipboardIcon size={15} />
        </span>
        Integration Path
      </h3>

      <div className="lead-detail__path-card-body">
        <span
          className={`lead-detail__path-id lead-detail__path-id--${path.type}`}
        >
          {path.id}
        </span>

        <div className="lead-detail__path-card-text">
          <p className="lead-detail__path-card-title">
            {path.title}
          </p>

          {path.trigger && path.trigger !== "—" && (
            <p className="lead-detail__path-card-trigger">
              Trigger source: {path.trigger}
            </p>
          )}

          <p className="lead-detail__path-card-desc">
            {path.description}
          </p>

          {path.outcome && (
            <p className="lead-detail__path-card-outcome">
              <strong>Expected outcome:</strong> {path.outcome}
            </p>
          )}

          {path.assumed && (
            <p className="lead-detail__path-card-note">
              Inferred from sync_status = "Removed" — confirm this
              maps to Unhappy 3 for your real data.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------
   Lead Detail
------------------------------------------------------------------ */
export default function LeadDetailView({ lead, onBack }) {
  const [copied, setCopied] = useState(null);

  const val = (key) => {
    const value = lead[key];

    return value && String(value).trim() ? value : "—";
  };

  const isRemoved =
    normalize(lead.sync_status) === "removed";

  const mobile = val("mobile_number");
  const email = val("email_address");
  const assignedAt = val("assigned_date");
  const lastUpdatedAt = val("last_status_update");

  const path = classifyPath(lead);

  const handleCopy = (key, value) => {
    if (!value || value === "—") {
      return;
    }

    navigator.clipboard?.writeText(value);

    setCopied(key);

    setTimeout(() => {
      setCopied(null);
    }, 1500);
  };

  return (
    <div className="lead-detail">
      {/* ---------- Back ---------- */}
      <button
        type="button"
        className="lead-detail__back"
        onClick={onBack}
      >
        <ChevronLeftIcon size={16} />
        Back to Leads
      </button>

      {/* ==========================================================
          HERO
      ========================================================== */}
      <div className="lead-detail__hero">
        <div
          className="lead-detail__hero-decor"
          aria-hidden="true"
        >
          <img
            src={mgLogo}
            alt=""
            className="lead-detail__hero-logo"
          />
        </div>

        {/* Customer avatar */}
        <span className="lead-detail__avatar">
          {initials(lead.customer_name)}
        </span>

        {/* Customer information */}
        <div className="lead-detail__hero-main">
          <div className="lead-detail__hero-top">
            <h1>{lead.customer_name || "Unnamed Customer"}</h1>

            {isRemoved ? (
              <StatusPill status="Removed" />
            ) : (
              <StatusPill status={lead.lead_status} />
            )}

            <PathBadge path={path} />
          </div>

          <div className="lead-detail__hero-meta">
            <span className="lead-detail__meta-item">
              <BuildingIcon size={15} />
              {val("dealer_name")}
            </span>

            <span className="lead-detail__meta-divider" />

            <span className="lead-detail__meta-item">
              <ArrowRightIcon size={14} />

              <span className="lead-detail__meta-label">
                Dealer Code
              </span>

              {val("dealer_code")}
            </span>

            {lead.lead_source && (
              <>
                <span className="lead-detail__meta-divider" />

                <span className="lead-detail__source-badge">
                  <MegaphoneIcon size={13} />
                  {lead.lead_source}
                </span>
              </>
            )}
          </div>
        </div>

        {/* ========================================================
            VEHICLE HIGHLIGHT
        ======================================================== */}
        <div className="lead-detail__vehicle-highlight">
          <span className="lead-detail__vehicle-icon">
            <CarIcon size={21} />
          </span>

          <div className="lead-detail__vehicle-content">
            <span className="lead-detail__vehicle-label">
              Vehicle
            </span>

            <span className="lead-detail__vehicle-model">
              {val("vehicle_model")}
            </span>
          </div>
        </div>
      </div>

      {/* ==========================================================
          CONTACT INFO
      ========================================================== */}
      <div className="lead-detail__infobar">
        {/* Mobile */}
        <div className="lead-detail__infobar-item">
          <span className="lead-detail__infobar-icon">
            <PhoneIcon size={18} />
          </span>

          <div className="lead-detail__infobar-body">
            <span className="lead-detail__infobar-label">
              Mobile
            </span>

            <span className="lead-detail__infobar-value">
              {mobile}

              {mobile !== "—" && (
                <button
                  type="button"
                  className="lead-detail__copy-btn"
                  onClick={() =>
                    handleCopy("mobile", mobile)
                  }
                  aria-label="Copy mobile number"
                >
                  <CopyIcon />
                </button>
              )}

              {copied === "mobile" && (
                <span className="lead-detail__copied-tag">
                  Copied
                </span>
              )}
            </span>

            {mobile !== "—" && (
              <a
                href={`tel:${mobile}`}
                className="lead-detail__action-btn lead-detail__action-btn--call"
              >
                <PhoneIcon size={13} />
                Call Now
              </a>
            )}
          </div>
        </div>

        <span className="lead-detail__infobar-divider" />

        {/* Email */}
        <div className="lead-detail__infobar-item">
          <span className="lead-detail__infobar-icon">
            <MailIcon size={18} />
          </span>

          <div className="lead-detail__infobar-body">
            <span className="lead-detail__infobar-label">
              Email
            </span>

            <span className="lead-detail__infobar-value">
              {email}

              {email !== "—" && (
                <button
                  type="button"
                  className="lead-detail__copy-btn"
                  onClick={() =>
                    handleCopy("email", email)
                  }
                  aria-label="Copy email address"
                >
                  <CopyIcon />
                </button>
              )}

              {copied === "email" && (
                <span className="lead-detail__copied-tag">
                  Copied
                </span>
              )}
            </span>

            {email !== "—" && (
              <a
                href={`mailto:${email}`}
                className="lead-detail__action-btn lead-detail__action-btn--mail"
              >
                <MailIcon size={13} />
                Send Mail
              </a>
            )}
          </div>
        </div>
      </div>

      {/* ==========================================================
          INTEGRATION PATH
      ========================================================== */}
      <IntegrationPathCard path={path} />

      {/* ==========================================================
          REMARKS + TIMELINE
      ========================================================== */}
      <div className="lead-detail__footer-groups">
        {/* Remarks */}
        <section className="lead-detail__group lead-detail__remarks-card">
          <h3>
            <span className="lead-detail__group-icon">
              <NoteIcon size={15} />
            </span>
            Remarks
          </h3>

          <p className="lead-detail__remarks-text">
            {val("dealer_remarks") !== "—"
              ? val("dealer_remarks")
              : "No remarks yet."}
          </p>
        </section>

        {/* Timeline */}
        <section className="lead-detail__group lead-detail__timeline-card">
          <h3>
            <span className="lead-detail__group-icon">
              <ClockIcon size={15} />
            </span>
            Activity Timeline
          </h3>

          <ul className="lead-detail__timeline">
            {assignedAt !== "—" && (
              <li className="lead-detail__timeline-item">
                <span className="lead-detail__timeline-dot">
                  <UserIcon size={13} />
                </span>

                <div>
                  <p className="lead-detail__timeline-title">
                    Lead Assigned
                  </p>

                  <p className="lead-detail__timeline-time">
                    {assignedAt}
                  </p>
                </div>
              </li>
            )}

            {lastUpdatedAt !== "—" && (
              <li className="lead-detail__timeline-item">
                <span className="lead-detail__timeline-dot">
                  <PencilIcon size={13} />
                </span>

                <div>
                  <p className="lead-detail__timeline-title">
                    Last Updated
                  </p>

                  <p className="lead-detail__timeline-time">
                    {lastUpdatedAt}
                  </p>
                </div>
              </li>
            )}

            {assignedAt === "—" &&
              lastUpdatedAt === "—" && (
                <li className="lead-detail__timeline-empty">
                  No activity recorded yet.
                </li>
              )}
          </ul>
        </section>
      </div>
    </div>
  );
}

