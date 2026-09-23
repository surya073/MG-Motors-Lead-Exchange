import { useEffect, useState } from "react";

/**
 * Minimal dependency-free animated bar chart. Bars grow from 0 to their
 * target height once `active` is true. Kept as plain SVG so this page
 * doesn't require adding a charting library to the project — swap for
 * recharts/visx later if the project already standardizes on one.
 */
export default function BarChart({ data, active = true, height = 180, accent = "var(--odd-red)" }) {
  const [grown, setGrown] = useState(false);

  useEffect(() => {
    if (!active) return undefined;
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, [active]);

  const max = Math.max(...data.map((d) => d.value), 1);
  const barWidth = 100 / data.length;

  return (
    <div className="odd-chart odd-chart--bar" style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="odd-chart__svg">
        {data.map((d, i) => {
          const h = (d.value / max) * 82;
          const x = i * barWidth + barWidth * 0.22;
          const w = barWidth * 0.56;
          const isPeak = d.value === max;
          return (
            <rect
              key={d.label}
              x={x}
              y={grown ? 96 - h : 96}
              width={w}
              height={grown ? h : 0}
              rx="1.4"
              fill={isPeak ? accent : "var(--odd-bar-fill)"}
              style={{
                transition: `y 700ms var(--odd-ease, cubic-bezier(.16,1,.3,1)) ${i * 60}ms, height 700ms var(--odd-ease, cubic-bezier(.16,1,.3,1)) ${i * 60}ms`,
              }}
            />
          );
        })}
      </svg>
      <div className="odd-chart__axis">
        {data.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
    </div>
  );
}