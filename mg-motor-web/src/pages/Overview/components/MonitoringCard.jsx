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

// Plain-language label for the status pill. Presentation only — the tone
// itself is still decided by healthTone() above.
const STATUS_LABELS = {
  success: "Healthy",
  warning: "Watch",
  danger: "Action needed",
  info: "Info",
  neutral: "No data",
};

/**
 * MonitoringCard — the shared shell for the three "live operational
 * monitoring" cards (Dealer Health, SLA Monitoring, Duplicate Leads).
 * All three share one fixed height so they line up in a row:
 *
 *   header   icon badge + title + supporting metric, status pill on the right
 *   KPI      the headline percentage and its label
 *   trend    a full-width wave chart (or a same-sized placeholder when there
 *            is not enough real data to draw one — never a fabricated line)
 *   details  a scrollable area for each card's own list / note
 */
export default function MonitoringCard({
  title,
  icon,
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
  const hasTrend = trendPoints && trendPoints.length > 1;

  return (
    <Tag
      type={onClick ? "button" : undefined}
      className={`monitoring-card monitoring-card--${tone}${onClick ? " monitoring-card--clickable" : ""}`}
      onClick={onClick}
    >
      <div className="monitoring-card__header">
        <span className="monitoring-card__title-group">
          {icon && <span className={`monitoring-card__icon monitoring-card__icon--${tone}`}>{icon}</span>}
          <span className="monitoring-card__title-text">
            <h3>{title}</h3>
            {supporting && <span className="monitoring-card__supporting">{supporting}</span>}
          </span>
        </span>
        <span className={`monitoring-card__pill monitoring-card__pill--${tone}`}>
          <span className="monitoring-card__pill-dot" aria-hidden="true" />
          {STATUS_LABELS[tone] || STATUS_LABELS.neutral}
        </span>
      </div>

      <div className="monitoring-card__kpi">
        <span className="monitoring-card__kpi-value">{kpiValue}</span>
        <span className="monitoring-card__kpi-label">{kpiLabel}</span>
      </div>

      <div className="monitoring-card__trend">
        {hasTrend ? (
          <>
            <TrendArea points={trendPoints} tone={tone === "neutral" ? "info" : tone} width={320} height={64} />
            {trendCaption && <span className="monitoring-card__trend-caption">{trendCaption}</span>}
          </>
        ) : (
          <div className="monitoring-card__trend-empty">
            <span className="monitoring-card__trend-empty-line" aria-hidden="true" />
            <span>Not enough data for a trend yet</span>
          </div>
        )}
      </div>

      {children && <div className="monitoring-card__body">{children}</div>}
    </Tag>
  );
}
