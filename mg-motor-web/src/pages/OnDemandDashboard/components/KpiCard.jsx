import useCountUp from "../hooks/useCountUp";
import useLiquidPointer from "../hooks/useLiquidPointer";
import { GridIcon, LayersIcon, SparklesIcon, TrendDownIcon, TrendUpIcon, ZapIcon } from "./icons";

const ICONS = { grid: GridIcon, layers: LayersIcon, sparkles: SparklesIcon, zap: ZapIcon };

export default function KpiCard({ kpi, active, delay = 0 }) {
  const liquidRef = useLiquidPointer();
  const value = useCountUp(kpi.value, { active, decimals: kpi.decimals || 0, delay });
  const Icon = ICONS[kpi.icon] || GridIcon;
  const isUp = kpi.direction === "up";
  const max = Math.max(...kpi.spark);

  return (
    <div ref={liquidRef} className="odd-card odd-liquid odd-kpi" style={{ "--odd-reveal-delay": `${delay}ms` }}>
      <div className="odd-kpi__top">
        <span className="odd-kpi__icon">
          <Icon size={17} />
        </span>
        <span className={`odd-trend odd-trend--${isUp ? "up" : "down"}`}>
          {isUp ? <TrendUpIcon size={12} /> : <TrendDownIcon size={12} />}
          {Math.abs(kpi.delta)}%
        </span>
      </div>

      <div className="odd-kpi__value">
        {kpi.displayValue ?? value}
        {kpi.displayValue ? "" : kpi.suffix}
      </div>
      <div className="odd-kpi__label">{kpi.label}</div>

      <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="odd-kpi__spark">
        <polyline
          points={kpi.spark.map((v, i) => `${(i / (kpi.spark.length - 1)) * 100},${28 - (v / max) * 24}`).join(" ")}
          fill="none"
          stroke={isUp ? "var(--odd-red)" : "var(--odd-muted)"}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}