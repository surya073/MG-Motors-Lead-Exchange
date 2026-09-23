import { useEffect, useRef, useState } from "react";

/**
 * Dependency-free animated line chart. The path "draws itself" on
 * reveal via a stroke-dasharray/dashoffset trick, and points fade in
 * after. viewBox is a fixed 0-100/0-100 space so it scales responsively.
 */
export default function LineChart({ data, active = true, height = 180 }) {
  const pathRef = useRef(null);
  const [length, setLength] = useState(0);
  const [drawn, setDrawn] = useState(false);

  const max = Math.max(...data.map((d) => d.value));
  const min = Math.min(...data.map((d) => d.value));
  const range = max - min || 1;
  const step = 100 / (data.length - 1 || 1);

  const points = data.map((d, i) => {
    const x = i * step;
    const y = 92 - ((d.value - min) / range) * 76;
    return { x, y, ...d };
  });

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const areaPath = `${linePath} L 100 96 L 0 96 Z`;

  useEffect(() => {
    if (pathRef.current) setLength(pathRef.current.getTotalLength());
  }, [data]);

  useEffect(() => {
    if (!active) return undefined;
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, [active]);

  return (
    <div className="odd-chart odd-chart--line" style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="odd-chart__svg">
        <defs>
          <linearGradient id="odd-line-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--odd-red)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--odd-red)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill="url(#odd-line-fill)" opacity={drawn ? 1 : 0} style={{ transition: "opacity 900ms ease 400ms" }} />
        <path
          ref={pathRef}
          d={linePath}
          fill="none"
          stroke="var(--odd-red)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={length}
          strokeDashoffset={drawn ? 0 : length}
          style={{ transition: "stroke-dashoffset 1100ms var(--odd-ease, cubic-bezier(.16,1,.3,1))" }}
        />
        {points.map((p, i) => (
          <circle
            key={p.label}
            cx={p.x}
            cy={p.y}
            r="1.6"
            fill="var(--odd-white)"
            opacity={drawn ? 1 : 0}
            style={{ transition: `opacity 400ms ease ${600 + i * 90}ms` }}
          />
        ))}
      </svg>
      <div className="odd-chart__axis">
        {data.map((d) => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
    </div>
  );
}