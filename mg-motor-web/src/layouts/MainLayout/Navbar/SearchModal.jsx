import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { NAV_ICONS } from "../../../ui/icons";
import { ROUTES } from "../../../constants/routes.constants";
import "./SearchModal.css";

const SECTIONS = [
  { to: ROUTES.DASHBOARD, icon: NAV_ICONS.dashboard, label: "Dashboard" },
  { to: ROUTES.DEALERS, icon: NAV_ICONS.dealers, label: "Dealers" },
  { to: ROUTES.LEAD_EXCHANGE, icon: NAV_ICONS.leadExchange, label: "Lead Exchange" },
  { to: ROUTES.MAPPINGS, icon: NAV_ICONS.mappings, label: "Mappings" },
  { to: ROUTES.LOGS, icon: NAV_ICONS.logs, label: "Logs" },
  { to: ROUTES.SETTINGS, icon: NAV_ICONS.settings, label: "Settings" },
];

export default function SearchModal({ onClose }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = SECTIONS.filter((section) =>
    section.label.toLowerCase().includes(query.trim().toLowerCase())
  );

  const goTo = (to) => {
    navigate(to);
    onClose();
  };

  return createPortal(
    <div className="search-modal__backdrop" onMouseDown={onClose}>
      <div className="search-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-modal__input-row">
          <svg className="search-modal__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className="search-modal__input"
            type="text"
            placeholder="Search dealers, leads, mappings, logs..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="search-modal__body">
          <h2 className="search-modal__title">Jump to a section</h2>
          <p className="search-modal__subtitle">Search across the platform, or go straight to any module below.</p>

          <div className="search-modal__grid">
            {filtered.map(({ to, icon: Icon, label }) => (
              <button key={to} type="button" className="search-modal__card" onClick={() => goTo(to)}>
                <Icon size={22} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
