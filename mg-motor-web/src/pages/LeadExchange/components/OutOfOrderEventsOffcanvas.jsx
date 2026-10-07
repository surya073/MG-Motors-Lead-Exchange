import { useEffect } from "react";
import { Store, Hash, Clock, AlertTriangle, Link2 } from "lucide-react";
import Badge from "../../../ui/Badge/Badge";
import PathBadge from "../../../ui/PathBadge/PathBadge";
import CloseButton from "../../../ui/CloseButton/CloseButton";
import "./OutOfOrderEventsOffcanvas.css";

const OUT_OF_ORDER_STATES = {
  HELD: { label: "Held", tone: "pending", note: "Waiting for its MG enquiry" },
  EXPIRED: { label: "Expired", tone: "danger", note: "Retention passed — not applied to MG" },
  RELEASED: { label: "Released", tone: "success", note: "Applied to MG once the enquiry was linked" },
};

function formatSystemTimestamp(value) {
  if (!value) return "—";
  // Catalyst system timestamp "YYYY-MM-DD HH:MM:SS:mmm" — drop milliseconds.
  return String(value).replace(/:\d{1,3}$/, "");
}

/**
 * OutOfOrderEventsOffcanvas — the full Unhappy 7 event list, moved out of
 * the main Lead Exchange page and into a right-side panel. Purely a
 * presentation change: `events` is the exact same array
 * OutOfOrderEventsPanel already fetches via
 * adminDashboardService.listOutOfOrderEvents() — no new data, no new
 * calculation, just a roomier place to read it. Opening/closing this
 * only touches its own `open` state; it never reads or sets the lead
 * list's search/filter/pagination/detail-view state.
 */
export default function OutOfOrderEventsOffcanvas({ open, onClose, events, heldCount }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  return (
    <>
      <div
        className={`ooo-offcanvas__backdrop ${open ? "ooo-offcanvas__backdrop--open" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`ooo-offcanvas ${open ? "ooo-offcanvas--open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Out-of-order events"
      >
        <div className="ooo-offcanvas__header">
          <div className="ooo-offcanvas__header-icon">
            <AlertTriangle size={18} />
          </div>
          <div className="ooo-offcanvas__header-text">
            <div className="ooo-offcanvas__title-row">
              <h2>Out-of-Order Events</h2>
              <PathBadge name="Unhappy 7" size="md" />
            </div>
            <p>
              {events.length === 0
                ? "No events in range"
                : `${heldCount} held · ${events.length} total`}
            </p>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        <div className="ooo-offcanvas__body">
          {events.length === 0 ? (
            <p className="ooo-offcanvas__empty">Nothing held right now.</p>
          ) : (
            <ul className="ooo-offcanvas__list">
              {events.map((event) => {
                const meta = OUT_OF_ORDER_STATES[event.state] || OUT_OF_ORDER_STATES.HELD;
                return (
                  <li className="ooo-offcanvas__card" key={`${event.dealerCode}:${event.externalLeadId}`}>
                    <div className="ooo-offcanvas__card-top">
                      <span className="ooo-offcanvas__card-name">
                        {event.customerName || (event.dealerRecordMissing ? "Not found at dealer" : "—")}
                      </span>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>

                    <p className="ooo-offcanvas__card-note">{meta.note}</p>

                    <div className="ooo-offcanvas__meta-grid">
                      <div className="ooo-offcanvas__meta-item">
                        <Store size={13} className="ooo-offcanvas__meta-icon" />
                        <div>
                          <span className="ooo-offcanvas__meta-label">Dealer</span>
                          <span className="ooo-offcanvas__meta-value">{event.dealerCode || "—"}</span>
                        </div>
                      </div>
                      <div className="ooo-offcanvas__meta-item">
                        <Hash size={13} className="ooo-offcanvas__meta-icon" />
                        <div>
                          <span className="ooo-offcanvas__meta-label">Dealer record ID</span>
                          <span className="ooo-offcanvas__meta-value mono">{event.externalLeadId || "—"}</span>
                        </div>
                      </div>
                      <div className="ooo-offcanvas__meta-item">
                        <Clock size={13} className="ooo-offcanvas__meta-icon" />
                        <div>
                          <span className="ooo-offcanvas__meta-label">Held since</span>
                          <span className="ooo-offcanvas__meta-value mono">{formatSystemTimestamp(event.heldSince)}</span>
                        </div>
                      </div>
                      <div className="ooo-offcanvas__meta-item">
                        <AlertTriangle size={13} className="ooo-offcanvas__meta-icon" />
                        <div>
                          <span className="ooo-offcanvas__meta-label">Dealer status</span>
                          <span className="ooo-offcanvas__meta-value">{event.dealerStatus || "—"}</span>
                        </div>
                      </div>
                      {event.zohoLeadId && (
                        <div className="ooo-offcanvas__meta-item">
                          <Link2 size={13} className="ooo-offcanvas__meta-icon" />
                          <div>
                            <span className="ooo-offcanvas__meta-label">Linked MG lead</span>
                            <span className="ooo-offcanvas__meta-value mono">{event.zohoLeadId}</span>
                          </div>
                        </div>
                      )}
                      {event.heldEvents != null && (
                        <div className="ooo-offcanvas__meta-item">
                          <Clock size={13} className="ooo-offcanvas__meta-icon" />
                          <div>
                            <span className="ooo-offcanvas__meta-label">Held events</span>
                            <span className="ooo-offcanvas__meta-value">{event.heldEvents}</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {event.reason && (
                      <div className="ooo-offcanvas__reason">
                        <span className="ooo-offcanvas__reason-label">Reason</span>
                        <p>{event.reason}</p>
                        {event.expiredAt && (
                          <span className="ooo-offcanvas__expired-note">
                            Expired {formatSystemTimestamp(event.expiredAt)}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
