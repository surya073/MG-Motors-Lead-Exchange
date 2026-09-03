import { useEffect, useState } from "react";
import mgLogo from "../../../assets/images/ogLogoPng.jpg";

/**
 * EntranceOverlay
 * -----------------------------------------------------------------------
 * Full-screen brand moment shown once on mount:
 *   1. dark stage fades in with a faint radar grid
 *   2. logo pulls into focus (blur + scale) while a ring sweeps around it
 *   3. brand text reveals letter by letter
 *   4. overlay exits via a center-out mask wipe
 * Calls onDone() when finished so the parent can start section reveal +
 * KPI count-up animations exactly as the dashboard becomes visible.
 */
export default function EntranceOverlay({ onDone }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const exitTimer = setTimeout(() => setExiting(true), 1900);
    const doneTimer = setTimeout(() => onDone?.(), 2500);
    return () => {
      clearTimeout(exitTimer);
      clearTimeout(doneTimer);
    };
  }, [onDone]);

  return (
    <div className={`odd-entrance ${exiting ? "odd-entrance--exit" : ""}`}>
      <div className="odd-entrance__grid" />

      <div className="odd-entrance__stage">
        <div className="odd-entrance__ring" />
        <div className="odd-entrance__ring odd-entrance__ring--delay" />
        <img src={mgLogo} alt="MG Motor" className="odd-entrance__logo" />
      </div>

      <div className="odd-entrance__text">
        <span>MG MOTOR</span>
        <em>On-Demand Analytics</em>
      </div>
    </div>
  );
}