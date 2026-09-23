// src/ui/Offcanvas/DealerDetailsOffcanvas.jsx
import { useEffect, useRef, useState } from "react";
import {
  Search,
  RefreshCw,
  Mail,
  Users,
  Building2,
  MapPin,
  CheckCircle2,
  Clock,
  FileText,
  Plus,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import Badge from "../Badge/Badge";
import "./DealerDetailsOffcanvas.css";
import { XIcon } from "../../ui/icons";
import bannerImg from "../../assets/banners/bgbanner2.jpg";
import mgLogo from "../../assets/images/mg-logo-single.png";

const TABS = ["Overview", "Contact", "Sync Details", "Lead Activity", "Logs"];
const CLOSE_ANIMATION_MS = 260;

function cellText(v) {
  return v && String(v).trim() ? v : "—";
}

function statusTone(status) {
  if (status === "Removed" || status === "Error") return "danger";
  if (status === "Synced" || status === "Active") return "active";
  if (status === "Pending" || status === "Syncing") return "pending";
  return "neutral";
}

/**
 * onSyncNow / onSendInvitation / onViewLeads are optional — pass handlers
 * from the parent page if you want Quick Actions to actually do something.
 * Left unwired, the buttons render but no-op.
 */
export default function DealerDetailsOffcanvas({
  dealer,
  onClose,
  onSyncNow,
  onSendInvitation,
  onViewLeads,
}) {
  const [renderedDealer, setRenderedDealer] = useState(dealer);
  const [closing, setClosing] = useState(false);
  const [activeTab, setActiveTab] = useState("Overview");
  const closeTimeoutRef = useRef(null);

  useEffect(() => {
    if (dealer) {
      clearTimeout(closeTimeoutRef.current);
      setRenderedDealer(dealer);
      setClosing(false);
      setActiveTab("Overview");
      return undefined;
    }
    if (renderedDealer) {
      setClosing(true);
      closeTimeoutRef.current = setTimeout(() => {
        setRenderedDealer(null);
        setClosing(false);
      }, CLOSE_ANIMATION_MS);
    }
    return () => clearTimeout(closeTimeoutRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealer]);

  useEffect(() => {
    if (!renderedDealer) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [renderedDealer, onClose]);

  if (!renderedDealer) return null;

  const val = (key) => cellText(renderedDealer[key]);
  const code = val("dealer_code").toUpperCase();

  // No confirmed CRM URL pattern from the backend yet — only render the
  // link when crm_record_id exists, and treat the href as a placeholder
  // until you confirm the real Zoho CRM deep-link format for this org.
  const crmUrl = renderedDealer.crm_record_id
    ? `https://crm.zoho.com/crm/org/tab/Accounts/${renderedDealer.crm_record_id}`
    : null;

  return (
    <>
      <div
        className={`offcanvas__backdrop ${closing ? "" : "offcanvas__backdrop--open"}`}
        onClick={onClose}
      />
      <aside
        className={`offcanvas ${closing ? "" : "offcanvas--open"}`}
        role="dialog"
        aria-label="Dealer details"
      >
        <button className="offcanvas__close" onClick={onClose} aria-label="Close">
          <XIcon size={18} />
        </button>

        <header
          className="offcanvas__hero"
          style={{ backgroundImage: `url(${bannerImg})` }}
        >
          <div className="offcanvas__hero-overlay" />
          <img src={mgLogo} alt="" className="offcanvas__hero-logo" />

          <div className="offcanvas__hero-meta">
            <span className="offcanvas__hero-code">
              <MapPin size={12} /> {code}
            </span>
            <h2 className="offcanvas__hero-title">{val("dealer_name")}</h2>
            <span className="offcanvas__hero-sub">
              <MapPin size={12} />
              Australia{renderedDealer.region ? ` · ${renderedDealer.region}` : ""}
            </span>
          </div>

          <div className="offcanvas__hero-actions">
            <Badge tone={statusTone(renderedDealer.sync_status)} fixed>
              {renderedDealer.sync_status || "Synced"}
            </Badge>
            {crmUrl && (
              
             <a  className="offcanvas__crm-link"
                href={crmUrl}
                target="_blank"
                rel="noreferrer"
              >
                View in Zoho CRM <ExternalLink size={13} />
              </a>
            )}
          </div>
        </header>

        <nav className="offcanvas__tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`offcanvas__tab ${activeTab === tab ? "offcanvas__tab--active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>

        <div className="offcanvas__content">
          <div className="offcanvas__main">
            {activeTab === "Overview" && (
              <>
                <div className="offcanvas__stat-row">
                  <div className="offcanvas__stat-card">
                    <span className="offcanvas__stat-icon">
                      <Building2 size={16} />
                    </span>
                    <div>
                      <span className="offcanvas__stat-label">Dealer code</span>
                      <span className="offcanvas__stat-value">{code}</span>
                    </div>
                  </div>
                  <div className="offcanvas__stat-card">
                    <span className="offcanvas__stat-icon">
                      <MapPin size={16} />
                    </span>
                    <div>
                      <span className="offcanvas__stat-label">Region</span>
                      <span className="offcanvas__stat-value">{val("region")}</span>
                    </div>
                  </div>
                  <div className="offcanvas__stat-card offcanvas__stat-card--status">
                    <span className="offcanvas__stat-icon">
                      <CheckCircle2 size={16} />
                    </span>
                    <div>
                      <span className="offcanvas__stat-label">Status</span>
                      <span className="offcanvas__stat-value">
                        {renderedDealer.sync_status || "Synced"}
                      </span>
                    </div>
                  </div>
                </div>

                <section className="offcanvas__group">
                  <h3>
                    <Building2 size={14} /> Dealer information
                  </h3>
                  <dl>
                    <div className="offcanvas__row">
                      <dt>Dealer code</dt>
                      <dd>{code}</dd>
                    </div>
                    <div className="offcanvas__row">
                      <dt>Dealer name</dt>
                      <dd>{val("dealer_name")}</dd>
                    </div>
                    <div className="offcanvas__row">
                      <dt>Region</dt>
                      <dd>{val("region")}</dd>
                    </div>
                    <div className="offcanvas__row">
                      <dt>City</dt>
                      <dd>{val("city")}</dd>
                    </div>
                    <div className="offcanvas__row">
                      <dt>State</dt>
                      <dd>{val("state")}</dd>
                    </div>
                  </dl>
                </section>

                <section className="offcanvas__group">
                  <h3>
                    <Users size={14} /> Contact information
                  </h3>
                  <dl>
                    <div className="offcanvas__row">
                      <dt>Email</dt>
                      <dd>
                        {renderedDealer.email_address ? (
                          <a href={`mailto:${renderedDealer.email_address}`}>
                            {renderedDealer.email_address}
                          </a>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                    <div className="offcanvas__row">
                      <dt>Phone</dt>
                      <dd>
                        {renderedDealer.phone_number ? (
                          <a href={`tel:${renderedDealer.phone_number}`}>
                            {renderedDealer.phone_number}
                          </a>
                        ) : (
                          "—"
                        )}
                      </dd>
                    </div>
                    <div className="offcanvas__row">
                      <dt>Sync status</dt>
                      <dd>
                        <Badge tone={statusTone(renderedDealer.sync_status)} fixed>
                          {renderedDealer.sync_status || "Synced"}
                        </Badge>
                      </dd>
                    </div>
                    <div className="offcanvas__row">
                      <dt>Last synced</dt>
                      <dd>{val("last_synced_at")}</dd>
                    </div>
                    <div className="offcanvas__row">
                      <dt>Lead count</dt>
                      <dd>{renderedDealer.lead_count ?? 0}</dd>
                    </div>
                  </dl>
                </section>
              </>
            )}

            {activeTab === "Contact" && (
              <section className="offcanvas__group">
                <h3>
                  <Users size={14} /> Contact information
                </h3>
                <dl>
                  <div className="offcanvas__row">
                    <dt>Email</dt>
                    <dd>{val("email_address")}</dd>
                  </div>
                  <div className="offcanvas__row">
                    <dt>Phone</dt>
                    <dd>{val("phone_number")}</dd>
                  </div>
                  <div className="offcanvas__row">
                    <dt>City</dt>
                    <dd>{val("city")}</dd>
                  </div>
                  <div className="offcanvas__row">
                    <dt>State</dt>
                    <dd>{val("state")}</dd>
                  </div>
                </dl>
              </section>
            )}

            {activeTab === "Sync Details" && (
              <section className="offcanvas__group">
                <h3>
                  <RefreshCw size={14} /> Sync details
                </h3>
                <dl>
                  <div className="offcanvas__row">
                    <dt>Sync status</dt>
                    <dd>{val("sync_status")}</dd>
                  </div>
                  <div className="offcanvas__row">
                    <dt>Last synced</dt>
                    <dd>{val("last_synced_at")}</dd>
                  </div>
                  <div className="offcanvas__row">
                    <dt>Created</dt>
                    <dd>{val("CREATEDTIME")}</dd>
                  </div>
                  <div className="offcanvas__row">
                    <dt>Modified</dt>
                    <dd>{val("MODIFIEDTIME")}</dd>
                  </div>
                  <div className="offcanvas__row">
                    <dt>CRM record ID</dt>
                    <dd>{val("crm_record_id")}</dd>
                  </div>
                </dl>
              </section>
            )}

            {activeTab === "Lead Activity" && (
              <div className="offcanvas__empty-state">
                <Users size={22} />
                <p>
                  Lead activity isn't wired up yet — this needs a per-dealer leads
                  endpoint to populate.
                </p>
              </div>
            )}

            {activeTab === "Logs" && (
              <div className="offcanvas__empty-state">
                <FileText size={22} />
                <p>
                  Sync logs aren't wired up yet — this needs a per-dealer sync-log
                  endpoint to populate.
                </p>
              </div>
            )}
          </div>

          <div className="offcanvas__side">
            <section className="offcanvas__side-card offcanvas__side-card--dark">
              <h3>Quick actions</h3>
              <button className="offcanvas__action-row" onClick={() => setActiveTab("Overview")}>
                <span>
                  <Search size={14} /> View dealer details
                </span>
                <ChevronRight size={14} />
              </button>
              <button
                className="offcanvas__action-row"
                onClick={() => onSyncNow?.(renderedDealer)}
              >
                <span>
                  <RefreshCw size={14} /> Sync now
                </span>
                <ChevronRight size={14} />
              </button>
              <button
                className="offcanvas__action-row"
                onClick={() => onSendInvitation?.(renderedDealer)}
              >
                <span>
                  <Mail size={14} /> Send invitation
                </span>
                <ChevronRight size={14} />
              </button>
              <button
                className="offcanvas__action-row"
                onClick={() => onViewLeads?.(renderedDealer)}
              >
                <span>
                  <Users size={14} /> View leads
                </span>
                <ChevronRight size={14} />
              </button>
            </section>

            <section className="offcanvas__side-card">
              <h3>
                <FileText size={14} /> Dealer notes
              </h3>
              <p className="offcanvas__notes-empty">No additional notes available.</p>
              <button className="offcanvas__add-note-btn" type="button">
                <Plus size={14} /> Add note
              </button>
            </section>

            <section className="offcanvas__side-card">
              <h3>
                <Clock size={14} /> Recent activity
              </h3>
              <div className="offcanvas__activity-item">
                <span className="offcanvas__activity-dot" />
                <div>
                  <span className="offcanvas__activity-title">Dealers synced</span>
                  <span className="offcanvas__activity-time">{val("last_synced_at")}</span>
                </div>
              </div>
            </section>
          </div>
        </div>
      </aside>
    </>
  );
}