import TrendArea from "./TrendArea";
import "./monitoring.css";

/**
 * Buckets a list of real, dated events (each must have a `.date` field —
 * a Catalyst "YYYY-MM-DD ..." timestamp string) into a real per-day count
 * series, suitable for TrendArea. Never invents a day that has no events;
 * a day with zero events in the source list simply isn't a point. This is
 * plain aggregation of already-fetched data, not a new calculation.
 */
export function bucketByDay(events) {
  const counts = new Map();
  (events || []).forEach((e) => {
    const day = String(e?.date || "").slice(0, 10);
    if (!day || day.length !== 10) return;
    counts.set(day, (counts.get(day) || 0) + 1);
  });
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({ label: day.slice(5), value }));
}

/**
 * Maps a real percentage to a semantic tone using fixed thresholds. This
 * is a presentation decision (how to color-code an existing number), not
 * new data — the same way STATUS_TONES elsewhere maps a status STRING to
 * a color.
 *
 * `higherIsBetter: true` — e.g. "% dealers active": tone is success once
 * percent >= goodThreshold, warning once >= warnThreshold, else danger.
 * `higherIsBetter: false` — e.g. "% SLA breach rate": tone is success
 * once percent <= goodThreshold, warning once <= warnThreshold, else danger.
 */
export function healthTone(percent, { goodThreshold = 80, warnThreshold = 50, higherIsBetter = true } = {}) {
  if (percent == null || Number.isNaN(percent)) return "neutral";
  if (higherIsBetter) {
    if (percent >= goodThreshold) return "success";
    if (percent >= warnThreshold) return "warning";
    return "danger";
  }
  if (percent <= goodThreshold) return "success";
  if (percent <= warnThreshold) return "warning";
  return "danger";
}

/**
 * MonitoringCard — the shared shell for the three "live operational
 * monitoring" cards (Dealer Health, SLA Monitoring, Duplicate Leads):
 * a status dot + title, a prominent KPI with a small real supporting
 * metric next to it (never a fabricated vs.-last-period delta, since no
 * prior-period baseline exists in the data), a wave/area trend, and a
 * slot for whatever list/note each card already showed.
 */
export default function MonitoringCard({
  title,
  tone = "neutral",
  kpiValue,
  kpiLabel,
  supporting,
  trendPoints,
  trendCaption,
  onClick,
  children,
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`monitoring-card monitoring-card--${tone}${onClick ? " monitoring-card--clickable" : ""}`}
      onClick={onClick}
    >
      <div className="monitoring-card__header">
        <span className="monitoring-card__title-group">
          <span className={`monitoring-card__status-dot monitoring-card__status-dot--${tone}`} aria-hidden="true" />
          <h3>{title}</h3>
        </span>
        {supporting && <span className="monitoring-card__supporting">{supporting}</span>}
      </div>

      <div className="monitoring-card__kpi-row">
        <div className="monitoring-card__kpi">
          <span className="monitoring-card__kpi-value">{kpiValue}</span>
          <span className="monitoring-card__kpi-label">{kpiLabel}</span>
        </div>
        {trendPoints && trendPoints.length > 1 && (
          <div className="monitoring-card__trend">
            <TrendArea points={trendPoints} tone={tone === "neutral" ? "info" : tone} />
            {trendCaption && <span className="monitoring-card__trend-caption">{trendCaption}</span>}
          </div>
        )}
      </div>

      {children && <div className="monitoring-card__body">{children}</div>}
    </Tag>
  );
}
