import useLiquidPointer from "../hooks/useLiquidPointer";

export default function ActivityFeed({ items, delay = 0 }) {
  const liquidRef = useLiquidPointer();

  return (
    <div ref={liquidRef} className="odd-card odd-liquid odd-activity" style={{ "--odd-reveal-delay": `${delay}ms` }}>
      <div className="odd-chart-panel__head">
        <div>
          <h3 className="odd-chart-panel__title">Activity</h3>
          <p className="odd-chart-panel__subtitle">What's happened across uploads and live data.</p>
        </div>
      </div>

      <ul className="odd-timeline">
        {items.map((item, i) => (
          <li key={item.id} className={`odd-timeline__item odd-timeline__item--${item.tone}`} style={{ "--odd-stagger": `${i * 90}ms` }}>
            <span className="odd-timeline__dot" />
            <p>{item.text}</p>
            <time>{item.time}</time>
          </li>
        ))}
      </ul>
    </div>
  );
}