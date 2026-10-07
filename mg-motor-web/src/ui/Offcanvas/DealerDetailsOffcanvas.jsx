// src/ui/Offcanvas/DealerDetailsOffcanvas.jsx
import { useEffect, useRef, useState } from "react";
import {
  MapPin,
  ExternalLink,
} from "lucide-react";
import Badge from "../Badge/Badge";
import {
  ContactTab,
  LeadActivityTab,
  LogsTab,
  OverviewTab,
  SyncDetailsTab,
  useDealerActivity,
} from "./DealerDetailsTabs";
import "./DealerDetailsOffcanvas.css";
import CloseButton from "../CloseButton/CloseButton";
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

export default function DealerDetailsOffcanvas({ dealer, onClose }) {
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

  const activity = useDealerActivity(renderedDealer?.dealer_code);

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
        <CloseButton variant="glass" className="offcanvas__close" onClick={onClose} />

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
            {activeTab === "Overview" && <OverviewTab dealer={renderedDealer} activity={activity} />}
            {activeTab === "Contact" && <ContactTab dealer={renderedDealer} />}
            {activeTab === "Sync Details" && <SyncDetailsTab dealer={renderedDealer} />}
            {activeTab === "Lead Activity" && <LeadActivityTab activity={activity} />}
            {activeTab === "Logs" && <LogsTab activity={activity} />}
          </div>

        </div>
      </aside>
    </>
  );
}