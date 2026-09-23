import { useEffect, useState } from "react";
import { CheckIcon, SparklesIcon } from "./icons";

const STEPS = {
  upload: ["Reading uploaded file", "Extracting rows & columns", "Running AI analysis", "Building KPIs & charts"],
  app: ["Connecting to MG Motor app data", "Fetching leads & dealers", "Aggregating metrics", "Building KPIs & charts"],
};

/**
 * GeneratingOverlay
 * -----------------------------------------------------------------------
 * Purely presentational step sequence — the actual work (file parsing /
 * live fetch) will eventually happen behind this same UI. For now it
 * advances on a timer; swap the timer for real await points once
 * services/aiService.js and the live-data fetch are implemented.
 */
export default function GeneratingOverlay({ source, onComplete }) {
  const steps = STEPS[source] || STEPS.app;
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (activeIndex >= steps.length) {
      const t = setTimeout(onComplete, 450);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setActiveIndex((i) => i + 1), 550);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  return (
    <div className="odd-generating">
      <div className="odd-generating__icon">
        <SparklesIcon size={22} />
      </div>
      <h2>Generating your dashboard</h2>
      <ul className="odd-generating__steps">
        {steps.map((label, i) => {
          const done = i < activeIndex;
          const active = i === activeIndex;
          return (
            <li key={label} className={`odd-generating__step ${done ? "is-done" : ""} ${active ? "is-active" : ""}`}>
              <span className="odd-generating__dot">{done && <CheckIcon size={11} />}</span>
              {label}
            </li>
          );
        })}
      </ul>
      <div className="odd-generating__bar">
        <div className="odd-generating__bar-fill" style={{ width: `${(Math.min(activeIndex, steps.length) / steps.length) * 100}%` }} />
      </div>
    </div>
  );
}