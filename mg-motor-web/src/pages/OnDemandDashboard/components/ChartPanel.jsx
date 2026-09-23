import useLiquidPointer from "../hooks/useLiquidPointer";

/**
 * Reusable card shell for any chart: title, optional subtitle/legend,
 * and a children slot for the actual chart (BarChart/LineChart/DonutChart).
 */
export default function ChartPanel({ title, subtitle, legend, children, span, delay = 0 }) {
  const liquidRef = useLiquidPointer();

  return (
    <div
      ref={liquidRef}
      className={`odd-card odd-liquid odd-chart-panel ${span ? `odd-chart-panel--${span}` : ""}`}
      style={{ "--odd-reveal-delay": `${delay}ms` }}
    >
      <div className="odd-chart-panel__head">
        <div>
          <h3 className="odd-chart-panel__title">{title}</h3>
          {subtitle && <p className="odd-chart-panel__subtitle">{subtitle}</p>}
        </div>
        {legend && (
          <div className="odd-legend">
            {legend.map((item) => (
              <span key={item.label} className="odd-legend__item">
                <i style={{ background: item.color }} />
                {item.label}
              </span>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}