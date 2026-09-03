// src/ui/Offcanvas/DealerDetailsOffcanvas.jsx
import { useEffect, useRef, useState } from "react";
import Badge from "../Badge/Badge";
import "./DealerDetailsOffcanvas.css";
import { XIcon } from "../../ui/icons";

const FIELD_GROUPS = [
  {
    title: "Dealer",
    fields: [
      ["dealer_code", "Dealer code"],
      ["dealer_name", "Dealer name"],
      ["region", "Region"],
      ["city", "City"],
      ["state", "State"],
    ],
  },
  {
    title: "Contact",
    fields: [
      ["email_address", "Email"],
      ["phone_number", "Phone"],
    ],
  },
  {
    title: "Sync",
    fields: [
      ["sync_status", "Sync status"],
      ["last_synced_at", "Last synced"],
      ["lead_count", "Lead count"],
    ],
  },
];

// Matches --transition-base (260ms) in variables.css. Kept as a JS
// constant since we need to know when the CSS transition finishes to
// safely unmount â€” if this ever changes in CSS, update it here too.

// Continue working on the MG Motor On-Demand Dashboard.
// Work on the required backend functionality and data flow.
// Integrate the backend response with the dashboard components.
// Check the end-to-end flow from data input to dashboard response.
// Validate dynamic dashboard creation based on the received data.
// Test the complete flow and fix any issues identified during integration.

const CLOSE_ANIMATION_MS = 260;

export default function DealerDetailsOffcanvas({ dealer, onClose }) {
  // Keeps rendering the last dealer while the close transition plays,
  // instead of unmounting the instant `dealer` becomes null.
  const [renderedDealer, setRenderedDealer] = useState(dealer);
  const [closing, setClosing] = useState(false);
  const closeTimeoutRef = useRef(null);

  useEffect(() => {
    if (dealer) {
      clearTimeout(closeTimeoutRef.current);
      setRenderedDealer(dealer);
      setClosing(false);
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

  const val = (key) => {
    const v = renderedDealer[key];
    return v && String(v).trim() ? v : "—";
  };

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
        <header className="offcanvas__header">
          <div>
            <h2>{renderedDealer.dealer_name}</h2>
            <span className="offcanvas__subtitle">{renderedDealer.dealer_code}</span>
          </div>
          <button className="offcanvas__close" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

        <div className="offcanvas__status-row">
          {renderedDealer.sync_status === "Removed" ? (
            <Badge tone="danger">Removed from CRM</Badge>
          ) : (
            <Badge tone="active">{renderedDealer.sync_status || "Synced"}</Badge>
          )}
          <Badge tone="neutral">{renderedDealer.region || "—"}</Badge>
        </div>

        <div className="offcanvas__body">
          {FIELD_GROUPS.map((group) => (
            <section key={group.title} className="offcanvas__group">
              <h3>{group.title}</h3>
              <dl>
                {group.fields.map(([key, label]) => (
                  <div key={key} className="offcanvas__row">
                    <dt>{label}</dt>
                    <dd>{val(key)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}