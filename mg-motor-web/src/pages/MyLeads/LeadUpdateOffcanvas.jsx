import { useEffect, useState } from "react";
import {
  X,
  Mail,
  Phone,
  Loader2,
  CircleDot,
  PhoneCall,
  Car,
  FileText,
  PackageCheck,
  XCircle,
  Megaphone,
  Globe,
  Footprints,
  Users,
  Share2,
  Tag,
  SquarePen,
} from "lucide-react";
import { dealerPortalService } from "../../services/api/dealerPortalService";
import DatePicker from "../../ui/DatePicker/DatePicker";
import Badge from "../../ui/Badge/Badge";
import { useAlerts } from "../../ui/Alerts/Alerts";
import sedanIcon from "../../assets/images/sedan.png";
import "./LeadUpdateOffcanvas.css";

const STATUS_OPTIONS = [
  { key: "New", icon: CircleDot, tone: "info" },
  { key: "Contacted", icon: PhoneCall, tone: "warning" },
  { key: "Test Drive", icon: Car, tone: "warning" },
  { key: "Quotation", icon: FileText, tone: "warning" },
  { key: "Delivered", icon: PackageCheck, tone: "success" },
  { key: "Lost", icon: XCircle, tone: "danger" },
];

const STATUS_TONES = {
  New: "info",
  Contacted: "warning",
  "Test Drive": "warning",
  Quotation: "warning",
  Delivered: "success",
  Lost: "danger",
};

const SOURCE_ICONS = {
  "google ads": Megaphone,
  website: Globe,
  "walk-in": Footprints,
  referral: Users,
  facebook: Share2,
  phone: Phone,
};

function SourceIcon({ source }) {
  const Icon = SOURCE_ICONS[(source || "").toLowerCase()] || Tag;
  return <Icon size={13} strokeWidth={2} />;
}

/**
 * initialMode: "view" | "edit" — controls what the offcanvas opens
 * into. Clicking a table row opens "view" (read-only, no inputs);
 * clicking the row's Update button opens "edit" directly. From view
 * mode, the footer's Edit button switches to edit mode in place
 * without closing/reopening the panel.
 * 
 * 
 * Explore the Dealer CRM workflow and configuration to understand the overall process and data flow.
Review the dealer-related CRM integration, status handling, and configuration requirements.
Start working on the Google Drive ↔ Zoho WorkDrive middleware application.
Explore and define the middleware architecture, sync flow, and initial integration setup
 */

export default function LeadUpdateOffcanvas({ lead, initialMode = "edit", onClose, onSaved }) {
  const { showAlert } = useAlerts();

  const [mode, setMode] = useState(initialMode); // "view" | "edit"
  const [leadStatus, setLeadStatus] = useState(lead.lead_status || "New");
  const [remarks, setRemarks] = useState(lead.dealer_remarks || "");
  const [followupDate, setFollowupDate] = useState(lead.next_followup_date || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [closing, setClosing] = useState(false);

  const readOnly = mode === "view";

  // Lets the slide-out animation finish before the parent unmounts this.
  const handleClose = () => {
    setClosing(true);
    setTimeout(onClose, 220);
  };

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape") handleClose();
    };
    document.addEventListener("keydown", handleEscape);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.body.style.overflow = "";
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await dealerPortalService.updateLead(lead.ROWID, {
        lead_status: leadStatus,
        dealer_remarks: remarks,
        next_followup_date: followupDate || undefined,
      });
      onSaved(updated);
    } catch (err) {
      const message = err?.response?.data?.error || "Couldn't save changes. Try again.";
      setError(message);
      showAlert("error", message, { title: "Update failed" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`lead-offcanvas__backdrop ${closing ? "lead-offcanvas__backdrop--closing" : ""}`} onClick={handleClose}>
      <div
        className={`lead-offcanvas__panel ${closing ? "lead-offcanvas__panel--closing" : ""}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lead-offcanvas__header">
          <h2>{lead.customer_name}</h2>
          <button type="button" className="lead-offcanvas__close" onClick={handleClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="lead-offcanvas__body">
          <div className="lead-offcanvas__info-grid">
            <div className="lead-offcanvas__info-item">
              <span className="lead-offcanvas__info-label">Vehicle</span>
              <div className="lead-offcanvas__vehicle">
                <img src={sedanIcon} alt="" className="lead-offcanvas__vehicle-icon" />
                <span>{lead.vehicle_model || "—"}</span>
              </div>
            </div>

            <div className="lead-offcanvas__info-item">
              <span className="lead-offcanvas__info-label">Source</span>
              {lead.lead_source ? (
                <span className="lead-offcanvas__source-badge">
                  <SourceIcon source={lead.lead_source} />
                  {lead.lead_source}
                </span>
              ) : (
                <span>—</span>
              )}
            </div>

            <div className="lead-offcanvas__info-item">
              <span className="lead-offcanvas__info-label">Mobile</span>
              {lead.mobile_number ? (
                <a href={`tel:${lead.mobile_number}`} className="lead-offcanvas__contact-badge lead-offcanvas__contact-badge--tel">
                  <Phone size={13} strokeWidth={2.5} />
                  {lead.mobile_number}
                </a>
              ) : (
                <span>—</span>
              )}
            </div>

            <div className="lead-offcanvas__info-item">
              <span className="lead-offcanvas__info-label">Email</span>
              {lead.email_address ? (
                <a href={`mailto:${lead.email_address}`} className="lead-offcanvas__contact-badge lead-offcanvas__contact-badge--mail">
                  <Mail size={13} strokeWidth={2.5} />
                  {lead.email_address}
                </a>
              ) : (
                <span>—</span>
              )}
            </div>
          </div>

          <div className="lead-offcanvas__field">
            <label>Lead status</label>
            {readOnly ? (
              <Badge tone={STATUS_TONES[leadStatus] || "neutral"}>{leadStatus}</Badge>
            ) : (
              <div className="lead-offcanvas__status-grid">
                {STATUS_OPTIONS.map(({ key, icon: Icon, tone }) => {
                  const active = leadStatus === key;
                  return (
                    <button
                      type="button"
                      key={key}
                      className={`lead-offcanvas__status-btn lead-offcanvas__status-btn--${tone} ${
                        active ? "lead-offcanvas__status-btn--active" : ""
                      }`}
                      onClick={() => setLeadStatus(key)}
                    >
                      <Icon size={16} strokeWidth={2} />
                      {key}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="lead-offcanvas__field">
            <label>Next follow-up date</label>
            {readOnly ? (
              <span className="lead-offcanvas__readonly-value">{followupDate || "—"}</span>
            ) : (
              <DatePicker value={followupDate} onChange={setFollowupDate} placeholder="Pick a date" />
            )}
          </div>

          <div className="lead-offcanvas__field">
            <label htmlFor="lead-remarks">Dealer remarks</label>
            {readOnly ? (
              <p className="lead-offcanvas__readonly-value lead-offcanvas__readonly-value--block">
                {remarks || "No remarks yet."}
              </p>
            ) : (
              <textarea
                id="lead-remarks"
                rows={4}
                value={remarks}
                onChange={(event) => setRemarks(event.target.value)}
                placeholder="Add notes about this lead…"
              />
            )}
          </div>

          {error && <div className="lead-offcanvas__error">{error}</div>}
        </div>

        <div className="lead-offcanvas__actions">
          {readOnly ? (
            <>
              <button className="lead-offcanvas__button lead-offcanvas__button--ghost" onClick={handleClose}>
                Close
              </button>
              <button className="lead-offcanvas__button lead-offcanvas__button--save" onClick={() => setMode("edit")}>
                <SquarePen size={14} strokeWidth={2.5} />
                Edit
              </button>
            </>
          ) : (
            <>
              <button className="lead-offcanvas__button lead-offcanvas__button--ghost" onClick={handleClose} disabled={saving}>
                Cancel
              </button>
              <button className="lead-offcanvas__button lead-offcanvas__button--save" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 size={15} strokeWidth={2.5} className="lead-offcanvas__spinner" />}
                {saving ? "Saving…" : "Save changes"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}