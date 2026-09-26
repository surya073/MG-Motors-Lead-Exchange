import "./monitoring.css";

/** Simple midpoint-quadratic smoothing — a wavy line through real points
 * without needing a curve-fitting library. Safe for any point count ≥ 2. */
function smoothPath(coords) {
  let d = `M ${coords[0].x} ${coords[0].y}`;
  for (let i = 0; i < coords.length - 1; i++) {
    const c = coords[i];
    const n = coords[i + 1];
    const midX = (c.x + n.x) / 2;
    const midY = (c.y + n.y) / 2;
    d += ` Q ${c.x} ${c.y} ${midX} ${midY}`;
  }
  const last = coords[coords.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/**
 * TrendArea — a wave/area-style sparkline. `points` must already be a
 * real, aggregated series (e.g. real dated events bucketed by day) —
 * this component draws exactly what it's given and never invents,
 * interpolates, or estimates a missing value.
 */
export default function TrendArea({ points, tone = "info", height = 56, width = 240 }) {
  if (!points || points.length < 2) return null;

  const max = Math.max(1, ...points.map((p) => p.value));
  const padY = 6;
  const stepX = width / (points.length - 1);
  const yFor = (v) => padY + (1 - v / max) * (height - padY * 2);
  const coords = points.map((p, i) => ({ x: i * stepX, y: yFor(p.value) }));

  const linePath = smoothPath(coords);
  const last = coords[coords.length - 1];
  const areaPath = `${linePath} L ${last.x} ${height} L ${coords[0].x} ${height} Z`;
  const gradientId = `trend-area-fill-${tone}`;

  return (
    <svg
      className={`trend-area trend-area--${tone}`}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Trend across ${points.length} ${points.length === 1 ? "point" : "points"}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="trend-area__stop-start" />
          <stop offset="100%" className="trend-area__stop-end" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path d={linePath} className="trend-area__line" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r={3} className="trend-area__dot" />
    </svg>
  );
}
