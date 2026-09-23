import "./Badge.css";

export default function Badge({
  children,
  tone = "neutral",
  fixed = false,
}) {
  return (
    <span
      className={`badge badge--${tone} ${fixed ? "badge--fixed" : ""}`}
    >
      <span className="badge__dot" />
      <span className="badge__text">{children}</span>
    </span>
  );
}