import Skeleton from "./Skeleton";
import "./Skeleton.css";
import "./PageSkeletons.css";

/**
 * PageSkeletons.jsx
 * -----------------------------------------------------------------------
 * Composed loading layouts built from the shared <Skeleton /> shimmer.
 * Each one mirrors the footprint of the content it stands in for so the
 * page doesn't shift when real data lands. Purely presentational — no
 * data, no side effects.
 */

const BAR_HEIGHTS = [45, 70, 55, 85, 60, 95, 75, 50, 80, 65];

/** Stand-in for the Overview hero banner. */
export function HeroSkeleton() {
  return (
    <div className="pg-skel__hero" aria-hidden="true">
      <Skeleton width={110} height={11} />
      <Skeleton width="min(320px, 70%)" height={30} />
      <Skeleton width="min(220px, 55%)" height={30} />
      <Skeleton width="min(280px, 60%)" height={13} />
      <div className="pg-skel__hero-stats">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} width={112} height={40} radius="var(--radius-full)" />
        ))}
      </div>
    </div>
  );
}

/** Row of KPI stat-card placeholders. */
export function KpiRowSkeleton({ count = 4 }) {
  return (
    <div className="pg-skel__kpis" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div className="pg-skel__kpi" key={i}>
          <div className="pg-skel__kpi-top">
            <Skeleton width={34} height={34} radius="var(--radius-md)" />
            <Skeleton width={42} height={18} radius="var(--radius-full)" />
          </div>
          <Skeleton width="55%" height={11} />
          <Skeleton width="38%" height={24} />
        </div>
      ))}
    </div>
  );
}

/** Rows with a leading avatar/icon chip, a two-line body and a trailing pill. */
export function ListSkeleton({ rows = 4 }) {
  return (
    <div className="pg-skel__rows" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="pg-skel__row" key={i}>
          <Skeleton width={36} height={36} radius="50%" />
          <div className="pg-skel__row-body">
            <Skeleton width={`${70 - (i % 3) * 12}%`} height={13} />
            <Skeleton width={`${45 - (i % 2) * 10}%`} height={10} />
          </div>
          <Skeleton width={58} height={20} radius="var(--radius-full)" />
        </div>
      ))}
    </div>
  );
}

/** Bar-chart style block, used where a trend/volume chart will render. */
export function ChartSkeleton() {
  return (
    <div className="pg-skel__chart" aria-hidden="true">
      {BAR_HEIGHTS.map((h, i) => (
        <Skeleton key={i} width="100%" height={`${h}%`} radius="var(--radius-sm)" />
      ))}
    </div>
  );
}

/**
 * Titled card shell. `variant` picks the body: "list" (default),
 * "chart", "donut", or "lines". `minHeight` keeps it the same footprint
 * as the loaded card.
 */
export function PanelSkeleton({ variant = "list", rows = 4, minHeight, showMeta = true }) {
  let body;
  if (variant === "chart") {
    body = <ChartSkeleton />;
  } else if (variant === "donut") {
    body = (
      <div className="pg-skel__donut-row">
        <Skeleton width={176} height={176} radius="50%" />
        <div className="pg-skel__rows" style={{ flex: 1, minWidth: 160 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} width={`${90 - i * 8}%`} height={13} />
          ))}
        </div>
      </div>
    );
  } else if (variant === "lines") {
    body = (
      <div className="pg-skel__rows">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} width={`${95 - (i % 3) * 14}%`} height={14} />
        ))}
      </div>
    );
  } else {
    body = <ListSkeleton rows={rows} />;
  }

  return (
    <div className="pg-skel__panel" style={minHeight ? { minHeight } : undefined} aria-hidden="true">
      <div className="pg-skel__panel-head">
        <Skeleton width="38%" height={16} />
        {showMeta && <Skeleton width={84} height={12} />}
      </div>
      {body}
    </div>
  );
}

/** Full Overview-style page: hero, KPI row, a wide panel, then a two-up row. */
export function DashboardSkeleton({ kpiCount = 4, withHero = true }) {
  return (
    <div className="pg-skel" role="status" aria-label="Loading dashboard" aria-busy="true">
      {withHero && <HeroSkeleton />}
      <KpiRowSkeleton count={kpiCount} />
      <PanelSkeleton variant="donut" minHeight={260} />
      <div className="pg-skel__split">
        <PanelSkeleton variant="list" rows={5} />
        <PanelSkeleton variant="list" rows={5} />
      </div>
    </div>
  );
}

/** Two-column record detail page (summary fields + side timeline). */
export function DetailSkeleton() {
  return (
    <div className="pg-skel" role="status" aria-label="Loading details" aria-busy="true">
      <div className="pg-skel__panel">
        <div className="pg-skel__row">
          <Skeleton width={52} height={52} radius="50%" />
          <div className="pg-skel__row-body">
            <Skeleton width="40%" height={18} />
            <Skeleton width="25%" height={11} />
          </div>
          <Skeleton width={84} height={26} radius="var(--radius-full)" />
        </div>
      </div>
      <div className="pg-skel__detail-grid">
        <div className="pg-skel__panel">
          <Skeleton width={140} height={14} />
          <div className="pg-skel__fields">
            {Array.from({ length: 8 }).map((_, i) => (
              <div className="pg-skel__field" key={i}>
                <Skeleton width={70} height={10} />
                <Skeleton width="80%" height={14} />
              </div>
            ))}
          </div>
        </div>
        <PanelSkeleton variant="list" rows={4} showMeta={false} />
      </div>
    </div>
  );
}

/** Small list skeleton for dropdowns / timelines. */
export function CompactListSkeleton({ rows = 3 }) {
  return (
    <div className="pg-skel pg-skel--compact" role="status" aria-label="Loading" aria-busy="true">
      <ListSkeleton rows={rows} />
    </div>
  );
}
