import "./paths.css";

/**
 * ProgressRing — single-value SVG ring (distinct from the multi-segment
 * DonutChart used elsewhere on Overview, which fills annular wedges for
 * several categories at once). This is one value out of 100, so a plain
 * stroke-dasharray with pathLength="100" is safe here — the multi-wedge
 * DonutChart avoided that technique because rotating several independent
 * segments is what broke; a single whole-<svg> rotation to start the arc
 * at 12 o'clock has none of that risk.
 *
 * `percent` must already be a real, computed value — this component does
 * no calculation and invents nothing.
 */
export default function ProgressRing({
  percent,
  size = 96,
  strokeWidth = 10,
  tone = "success",
  centerValue,
  centerLabel,
}) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const radius = size / 2 - strokeWidth / 2;
  const center = size / 2;

  return (
    <div className={`progress-ring progress-ring--${tone}`} style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="progress-ring__svg"
        role="img"
        aria-label={centerLabel ? `${centerLabel}: ${Math.round(clamped)}%` : `${Math.round(clamped)}%`}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          className="progress-ring__track"
          strokeWidth={strokeWidth}
          fill="none"
        />
        <circle
          cx={center}
          cy={center}
          r={radius}
          className="progress-ring__value"
          strokeWidth={strokeWidth}
          fill="none"
          pathLength="100"
          strokeDasharray={`${clamped} ${100 - clamped}`}
          strokeLinecap="round"
        />
      </svg>
      <div className="progress-ring__center">
        <span className="progress-ring__percent">{centerValue != null ? centerValue : `${Math.round(clamped)}%`}</span>
        {centerLabel && <span className="progress-ring__label">{centerLabel}</span>}
      </div>
    </div>
  );
}
