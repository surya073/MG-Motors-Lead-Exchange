import { useEffect, useState } from "react";

/**
 * Dependency-free animated donut chart. Each segment animates its
 * stroke-dasharray in on reveal. Circumference math uses r=15.9155 so
 * the total circumference is exactly 100 (percent = arc length).
 */
export default function DonutChart({ data, active = true, size = 148 }) {
  const [drawn, setDrawn] = useState(false);
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const radius = 15.9155;
  const circumference = 2 * Math.PI * radius;

  useEffect(() => {
    if (!active) return undefined;
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, [active]);

  let cumulative = 0;

  return (
    <div className="odd-donut" style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="odd-donut__svg">
        <circle cx="18" cy="18" r={radius} fill="none" stroke="var(--odd-border)" strokeWidth="3.4" />
        {data.map((d, i) => {
          const pct = (d.value / total) * 100;
          const dash = drawn ? (pct / 100) * circumference : 0;
          const gap = circumference - dash;
          const offset = -((cumulative / 100) * circumference) + circumference * 0.25;
          cumulative += pct;
          return (
            <circle
              key={d.label}
              cx="18"
              cy="18"
              r={radius}
              fill="none"
              stroke={d.color}
              strokeWidth="3.4"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${gap}`}
              strokeDashoffset={offset}
              style={{ transition: `stroke-dasharray 900ms var(--odd-ease, cubic-bezier(.16,1,.3,1)) ${i * 140}ms` }}
            />
          );
        })}
      </svg>
      <div className="odd-donut__center">
        <span className="odd-donut__value">{total}</span>
        <span className="odd-donut__label">files</span>
      </div>
    </div>
  );
}