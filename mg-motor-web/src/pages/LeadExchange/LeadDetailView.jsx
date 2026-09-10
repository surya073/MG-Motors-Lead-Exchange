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
  BookmarkIcon,
  ArrowRightIcon,
  NoteIcon,
  ClockIcon,
  PencilIcon,
} from "../../ui/icons";
import mgLogo from "../../assets/images/mg-logo-single.png";
import "./LeadDetailView.css";

const STATUS_TONES = {
  "Not Contacted": "neutral",
  Contacted: "info",
  "In Progress": "warning",
  Converted: "success",
  Lost: "danger",
};

const FIELD_GROUPS = [
  {
    title: "Customer Information",
    icon: UserIcon,
    fields: [
      ["mobile_number", "Mobile"],
      ["email_address", "Email"],
    ],
  },
  {
    title: "Lead Information",
    icon: ClipboardIcon,
    fields: [
      ["vehicle_model", "Vehicle"],
      ["lead_source", "Source"],
      ["lead_status", "Status", "status"],
    ],
  },
  {
    title: "Dealer Information",
    icon: BuildingIcon,
    fields: [
      ["dealer_name", "Dealer"],
      ["dealer_code", "Dealer Code"],
    ],
  },
];

function initials(name) {
  return (name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function CopyIcon(props) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Dot-style status pill matching the mockup — a filled dot + label in
 * a soft tone-tinted rounded pill, distinct from the standard Badge
 * used elsewhere so this page can match the reference design exactly. */
function StatusPill({ status }) {
  const tone = STATUS_TONES[status] || "neutral";
  return (
    <span className={`lead-detail__status-pill lead-detail__status-pill--${tone}`}>
      <span className="lead-detail__status-dot" />
      {status || "—"}
    </span>
  );
}

export default function LeadDetailView({ lead, onBack }) {
  const [copied, setCopied] = useState(null);

  const val = (key) => {
    const v = lead[key];
    return v && String(v).trim() ? v : "—";
  };

  const isRemoved = lead.sync_status === "Removed";
  const mobile = val("mobile_number");
  const email = val("email_address");
  const assignedAt = val("assigned_date");
  const lastUpdatedAt = val("last_status_update");

  const handleCopy = (key, value) => {
    if (!value || value === "—") return;
    navigator.clipboard?.writeText(value);
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="lead-detail">
      <button type="button" className="lead-detail__back" onClick={onBack}>
        <ChevronLeftIcon size={16} />
        Back to Leads
      </button>

      {/* ---------- Hero ---------- */}
      <div className="lead-detail__hero">
        <div className="lead-detail__hero-decor" aria-hidden="true">
          <img src={mgLogo} alt="" className="lead-detail__hero-logo" />
        </div>

        <span className="lead-detail__avatar">{initials(lead.customer_name)}</span>

        <div className="lead-detail__hero-main">
          <div className="lead-detail__hero-top">
            <h1>{lead.customer_name}</h1>
            {isRemoved ? <StatusPill status="Removed" /> : <StatusPill status={lead.lead_status} />}
          </div>

          <div className="lead-detail__hero-meta">
            <span className="lead-detail__meta-item">
              <BuildingIcon size={15} />
              {val("dealer_name")}
            </span>
            <span className="lead-detail__meta-divider" />
            <span className="lead-detail__meta-item">
              <ArrowRightIcon size={14} />
              <span className="lead-detail__meta-label">Dealer Code</span>
              {val("dealer_code")}
            </span>
            <span className="lead-detail__meta-divider" />
            <span className="lead-detail__meta-item">
              <CarIcon size={15} />
              {val("vehicle_model")}
            </span>
            {lead.lead_source && (
              <span className="lead-detail__source-badge">
                <MegaphoneIcon size={13} />
                {lead.lead_source}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ---------- Info strip: Mobile / Email / Lead Status ---------- */}
      <div className="lead-detail__infobar">
        <div className="lead-detail__infobar-item">
          <span className="lead-detail__infobar-icon">
            <PhoneIcon size={18} />
          </span>
          <div className="lead-detail__infobar-body">
            <span className="lead-detail__infobar-label">Mobile</span>
            <span className="lead-detail__infobar-value">
              {mobile}
              {mobile !== "—" && (
                <button
                  type="button"
                  className="lead-detail__copy-btn"
                  onClick={() => handleCopy("mobile", mobile)}
                  aria-label="Copy mobile number"
                >
                  <CopyIcon />
                </button>
              )}
            </span>
            {copied === "mobile" && <span className="lead-detail__copied-tag">Copied</span>}
          </div>
        </div>

        <span className="lead-detail__infobar-divider" />

        <div className="lead-detail__infobar-item">
          <span className="lead-detail__infobar-icon">
            <MailIcon size={18} />
          </span>
          <div className="lead-detail__infobar-body">
            <span className="lead-detail__infobar-label">Email</span>
            <span className="lead-detail__infobar-value">
              {email}
              {email !== "—" && (
                <button
                  type="button"
                  className="lead-detail__copy-btn"
                  onClick={() => handleCopy("email", email)}
                  aria-label="Copy email address"
                >
                  <CopyIcon />
                </button>
              )}
            </span>
            {copied === "email" && <span className="lead-detail__copied-tag">Copied</span>}
          </div>
        </div>

        <span className="lead-detail__infobar-divider" />

        <div className="lead-detail__infobar-item">
          <span className="lead-detail__infobar-icon">
            <BookmarkIcon size={18} />
          </span>
          <div className="lead-detail__infobar-body">
            <span className="lead-detail__infobar-label">Lead Status</span>
            <span className="lead-detail__infobar-value">
              <StatusPill status={lead.lead_status} />
            </span>
          </div>
        </div>
      </div>

      {/* ---------- Field groups ---------- */}
      <div className="lead-detail__groups">
        {FIELD_GROUPS.map((group) => {
          const GroupIcon = group.icon;
          return (
            <section key={group.title} className="lead-detail__group">
              <h3>
                <span className="lead-detail__group-icon">
                  <GroupIcon size={15} />
                </span>
                {group.title}
              </h3>
              <dl>
                {group.fields.map(([key, label, kind]) => (
                  <div key={key} className="lead-detail__row">
                    <dt>{label}</dt>
                    <dd>
                      {kind === "status" ? (
                        <StatusPill status={lead.lead_status} />
                      ) : (
                        <span className="lead-detail__row-value">{val(key)}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>

      {/* ---------- Remarks + Activity timeline ---------- */}
      <div className="lead-detail__footer-groups">
        <section className="lead-detail__group lead-detail__remarks-card">
          <h3>
            <span className="lead-detail__group-icon">
              <NoteIcon size={15} />
            </span>
            Remarks
          </h3>
          <p className="lead-detail__remarks-text">
            {val("dealer_remarks") !== "—" ? val("dealer_remarks") : "No remarks yet."}
          </p>
          {lastUpdatedAt !== "—" && (
            <div className="lead-detail__remarks-footer">
              <ClockIcon size={13} />
              Last updated {lastUpdatedAt}
            </div>
          )}
        </section>

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
                  <p className="lead-detail__timeline-title">Lead Assigned</p>
                  <p className="lead-detail__timeline-time">{assignedAt}</p>
                </div>
              </li>
            )}
            {lastUpdatedAt !== "—" && (
              <li className="lead-detail__timeline-item">
                <span className="lead-detail__timeline-dot">
                  <PencilIcon size={13} />
                </span>
                <div>
                  <p className="lead-detail__timeline-title">Last Updated</p>
                  <p className="lead-detail__timeline-time">{lastUpdatedAt}</p>
                </div>
              </li>
            )}
            {assignedAt === "—" && lastUpdatedAt === "—" && (
              <li className="lead-detail__timeline-empty">No activity recorded yet.</li>
            )}
          </ul>
        </section>
      </div>
    </div>
  );
}