import ProgressRing from "./ProgressRing";
import "./paths.css";

/**
 * The Lead Exchange pipeline, as a fixed sequence of stages every
 * Happy/Unhappy scenario can be placed on (see the `stage` field added to
 * SCENARIO_META in Overview.jsx). This is a DISPLAY-ONLY categorisation —
 * there is no per-stage pass/fail count anywhere in integration_logs, so
 * the timeline below only ever shows WHICH stage a scenario concerns, not
 * invented counts at each step.
 */
export const PIPELINE_STAGES = [
  { key: "ingested", label: "Ingested" },
  { key: "validated", label: "Validated" },
  { key: "routed", label: "Routed" },
  { key: "delivered", label: "Delivered" },
  { key: "synced", label: "Synced" },
];

function stageStatus(stageKey, focusStageKey, type) {
  const focusIdx = PIPELINE_STAGES.findIndex((s) => s.key === focusStageKey);
  const idx = PIPELINE_STAGES.findIndex((s) => s.key === stageKey);
  if (focusIdx === -1 || idx === -1) return "pending";
  if (type === "unhappy") {
    if (idx < focusIdx) return "done";
    if (idx === focusIdx) return "failed";
    return "pending";
  }
  // Happy path: every stage up to and including the focus stage completed.
  return idx <= focusIdx ? "done" : "pending";
}

function CheckGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function WarnGlyph() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="8" x2="12" y2="13" />
      <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * ProcessTimeline — horizontal step row. `compact` (used inline on the
 * card) hides stage labels and shrinks nodes; the expanded form (used in
 * the details offcanvas) shows full labels stacked under each node.
 */
export function ProcessTimeline({ focusStage, type, compact = false }) {
  return (
    <div className={`process-timeline${compact ? " process-timeline--compact" : ""}`}>
      {PIPELINE_STAGES.map((stage, i) => {
        const status = stageStatus(stage.key, focusStage, type);
        return (
          <div className="process-timeline__step" key={stage.key}>
            <div className="process-timeline__node-row">
              <span className={`process-timeline__node process-timeline__node--${status}`}>
                {status === "done" && <CheckGlyph />}
                {status === "failed" && <WarnGlyph />}
              </span>
              {i < PIPELINE_STAGES.length - 1 && (
                <span
                  className={`process-timeline__connector process-timeline__connector--${
                    status === "done" ? "active" : "pending"
                  }`}
                />
              )}
            </div>
            {!compact && (
              <span className={`process-timeline__label process-timeline__label--${status}`}>{stage.label}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function StatusChip({ type, children }) {
  return <span className={`status-chip status-chip--${type}`}>{children}</span>;
}

/** Drops the milliseconds off a Catalyst "YYYY-MM-DD HH:MM:SS:mmm" timestamp. */
export function formatOccurrence(value) {
  if (!value) return "—";
  return String(value).replace(/:\d{1,3}$/, "");
}

/**
 * ProcessPathCard — one Happy/Unhappy scenario as a process-monitoring
 * card: badge + occurrence count, a compact stage timeline showing where
 * in the pipeline this scenario sits, a share-of-category ring, and the
 * real supporting metrics (dealers affected, last occurrence). Every
 * number here comes straight from the `scenario` object the backend
 * already returns (see summarizeScenarios in adminDashboardService.js) —
 * `shareOfCategory` is the only derived value, and it's a plain
 * count/total the caller computes from two other real numbers.
 */
export default function ProcessPathCard({ scenario, meta, shareOfCategory, dealersTotal, onOpenDetails }) {
  const isHappy = scenario.type === "happy";
  const tone = isHappy ? "success" : "danger";
  const ringLabel = isHappy ? "of successful" : "of failed";

  return (
    <button
      type="button"
      className={`process-path-card process-path-card--${tone}`}
      onClick={() => onOpenDetails(scenario)}
    >
      <div className="process-path-card__top">
        <div className="process-path-card__badge-group">
          <StatusChip type={tone}>{scenario.name}</StatusChip>
          {meta?.trigger && <span className="process-path-card__trigger">{meta.trigger}</span>}
        </div>
        <div className="process-path-card__count-group">
          <span className="process-path-card__count">{scenario.count.toLocaleString()}</span>
          <span className="process-path-card__count-label">occurrences</span>
        </div>
      </div>

      <p className="process-path-card__title">{scenario.message || meta?.description || scenario.name}</p>

      <ProcessTimeline focusStage={meta?.stage} type={scenario.type} compact />

      <div className="process-path-card__foot">
        <div className="process-path-card__metrics">
          <div className="process-path-card__metric">
            <span className="process-path-card__metric-value">{scenario.dealersAffected}</span>
            <span className="process-path-card__metric-label">
              Dealer{scenario.dealersAffected === 1 ? "" : "s"}{dealersTotal ? ` of ${dealersTotal}` : ""}
            </span>
          </div>
          <div className="process-path-card__metric">
            <span className="process-path-card__metric-value process-path-card__metric-value--mono">
              {formatOccurrence(scenario.lastOccurrence)}
            </span>
            <span className="process-path-card__metric-label">Last occurrence</span>
          </div>
        </div>

        {shareOfCategory != null && (
          <ProgressRing
            percent={shareOfCategory}
            size={56}
            strokeWidth={6}
            tone={tone}
            centerValue={`${Math.round(shareOfCategory)}%`}
          />
        )}
      </div>
      {shareOfCategory != null && (
        <span className="process-path-card__ring-caption">{ringLabel} exchanges</span>
      )}
    </button>
  );
}
