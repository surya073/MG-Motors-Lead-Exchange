/**
 * Skeleton.jsx
 * -----------------------------------------------------------------------
 * Base shimmer placeholder primitive. Compose these into row/card/stat
 * skeletons rather than hand-rolling shimmer CSS per component.
 */
export default function Skeleton({ width = "100%", height = 14, radius = "var(--radius-sm)", className = "" }) {
  return (
    <span
      className={`skeleton ${className}`}
      style={{ width, height, borderRadius: radius }}
      aria-hidden="true"
    />
  );
}