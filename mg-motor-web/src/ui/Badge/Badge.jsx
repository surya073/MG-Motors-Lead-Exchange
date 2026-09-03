import "./Badge.css";

/**
 * Badge.jsx
 * -----------------------------------------------------------------------
 * Monochrome by design (per the "black and white only" direction) â€” tone
 * is conveyed by a filled vs. outline dot, not by color, so "active" vs
 * "inactive" still reads clearly without reintroducing red/green.
 */
// Badge.jsx
export default function Badge({ children, tone = "neutral", fixed = false }) {
  return (
    <span className={`badge badge--${tone} ${fixed ? "badge--fixed" : ""}`}>
      <span className="badge__dot" />
      <span>{children}</span>
    </span>
  );
}
