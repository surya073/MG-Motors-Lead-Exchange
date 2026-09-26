import { useEffect, useState } from "react";
import { adminDashboardService } from "../../../services/api/adminDashboardService";
import ProgressRing from "./ProgressRing";
import { ProcessTimeline, StatusChip, formatOccurrence } from "./ProcessPathCard";
import "./paths.css";

/**
 * PathDetailsOffcanvas — the rich content rendered inside the existing
 * generic <Drawer> (see Overview.jsx's openDrawer/Drawer) when a Happy or
 * Unhappy path card is clicked. Reuses the Drawer shell (backdrop, close
 * button, slide animation, ESC-to-close, mobile width) rather than
 * building a second offcanvas primitive.
 *
 * Every field shown here already exists on `scenario`/`health`/`meta` —
 * see ProcessPathCard.jsx's header comment for what summarizeScenarios
 * actually returns. The one exception is "Recent Activity": that's a
 * fresh, scenario-filtered call to the SAME getIntegrationLogs endpoint
 * ErrorReportTable already uses elsewhere on this page, scoped to
 * whichever path was clicked — a legitimate on-demand detail fetch, not
 * a duplicate of any request already in flight, and not new backend
 * functionality (the scenarioCode filter already existed).
 */
export default function PathDetailsOffcanvas({ scenario, meta, shareOfCategory, dealersTotal, filters }) {
  const isHappy = scenario.type === "happy";
  const tone = isHappy ? "success" : "danger";

  const [recent, setRecent] = useState(null);
  const [recentError, setRecentError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setRecent(null);
    setRecentError(null);
    adminDashboardService
      .getIntegrationLogs({
        fromDate: filters?.fromDate,
        toDate: filters?.toDate,
        dealerCode: filters?.dealerCode || undefined,
        scenarioCode: scenario.name,
        page: 1,
        pageSize: 5,
      })
      .then((result) => { if (!cancelled) setRecent(result.logs || []); })
      .catch((err) => {
        if (!cancelled) setRecentError(err?.response?.data?.error || "Couldn't load recent activity.");
      });
    return () => { cancelled = true; };
  }, [scenario.name, filters?.fromDate, filters?.toDate, filters?.dealerCode]);

  return (
    <div className="path-details">
      <div className="path-details__section path-details__section--overview">
        <div className="path-details__heading-row">
          <StatusChip type={tone}>{scenario.name}</StatusChip>
          {meta?.trigger && <span className="process-path-card__trigger">{meta.trigger}</span>}
        </div>
        <p className="path-details__title">{scenario.message || meta?.description || scenario.name}</p>
        {meta?.description && scenario.message && meta.description !== scenario.message && (
          <p className="path-details__desc">{meta.description}</p>
        )}

        <div className="path-details__overview-row">
          {shareOfCategory != null && (
            <ProgressRing
              percent={shareOfCategory}
              size={104}
              strokeWidth={11}
              tone={tone}
              centerValue={`${Math.round(shareOfCategory)}%`}
              centerLabel={isHappy ? "of successful" : "of failed"}
            />
          )}
          <div className="drawer-stats path-details__stats">
            <div className="drawer-stat">
              <span className="drawer-stat__value">{scenario.count.toLocaleString()}</span>
              <span className="drawer-stat__label">Occurrences</span>
            </div>
            <div className="drawer-stat">
              <span className="drawer-stat__value">
                {scenario.dealersAffected}{dealersTotal ? ` / ${dealersTotal}` : ""}
              </span>
              <span className="drawer-stat__label">Dealers affected</span>
            </div>
            <div className="drawer-stat">
              <span className="drawer-stat__value mono">{formatOccurrence(scenario.lastOccurrence)}</span>
              <span className="drawer-stat__label">Last occurrence</span>
            </div>
          </div>
        </div>
      </div>

      <div className="path-details__section">
        <h4 className="path-details__section-title">Process Timeline</h4>
        <ProcessTimeline focusStage={meta?.stage} type={scenario.type} />
      </div>

      {meta?.trigger && (
        <div className="path-details__section">
          <h4 className="path-details__section-title">Trigger Source</h4>
          <p className="drawer-note">{meta.trigger}</p>
        </div>
      )}

      <div className="path-details__section">
        <h4 className="path-details__section-title">Recent Activity</h4>
        {recentError ? (
          <p className="overview__state overview__state--error">{recentError}</p>
        ) : recent === null ? (
          <div className="skeleton-block" style={{ height: 80 }} />
        ) : recent.length === 0 ? (
          <p className="overview__empty-note">No logged events for this path in the selected range.</p>
        ) : (
          <ul className="task-list">
            {recent.map((log) => (
              <li className="task-list__item" key={log.ROWID}>
                <span className="task-list__icon">
                  <span className={`path-details__status-dot path-details__status-dot--${log.status === "SUCCESS" ? "success" : "danger"}`} />
                </span>
                <span className="task-list__title">
                  {log.dealerCode ? `${log.dealerCode}${log.dealerName ? ` — ${log.dealerName}` : ""}` : "—"}
                  {log.customerName ? ` · ${log.customerName}` : ""}
                </span>
                <span className="task-list__time mono">{formatOccurrence(log.date)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
