import { Frown, Smile } from "lucide-react";
import "./PathBadge.css";

/**
 * PathBadge — the one badge every page uses for a Happy / Unhappy path.
 * Happy paths get a smiling face, Unhappy paths a sad face, and every
 * scenario number keeps its own colour (the --scenario-* tokens in
 * styles/variables.css), so "Happy 3" and "Unhappy 10" look the same on
 * every page.
 *
 *   <PathBadge name="Unhappy 4" />
 *   <PathBadge path="happy" number={2} count={3} size="md" />
 *
 * `name` accepts "Happy 3", "happy-3" or "Unhappy 10". Anything that is
 * not a Happy/Unhappy path renders as plain text instead of a badge.
 */
const PATH_PATTERN = /^\s*(happy|unhappy)[\s_-]*(\d+)?/i;

export function parsePathName(name) {
  const match = PATH_PATTERN.exec(String(name || ""));
  if (!match) return null;
  return { path: match[1].toLowerCase(), number: match[2] ? Number(match[2]) : null };
}

export default function PathBadge({
  name,
  path,
  number,
  count,
  guessed = false,
  current = false,
  size = "sm",
  title,
  className = "",
  children,
}) {
  const parsed = name ? parsePathName(name) : path ? { path: String(path).toLowerCase(), number: number ?? null } : null;
  if (!parsed || (parsed.path !== "happy" && parsed.path !== "unhappy")) {
    return name ? <span>{name}</span> : null;
  }

  const isHappy = parsed.path === "happy";
  const Icon = isHappy ? Smile : Frown;
  const tokenNumber = parsed.number || 1;
  const label = children ?? `${isHappy ? "Happy" : "Unhappy"}${parsed.number ? ` ${parsed.number}` : ""}`;

  return (
    <span
      className={[
        "path-badge",
        `path-badge--${parsed.path}`,
        `path-badge--${size}`,
        guessed ? "path-badge--guessed" : "",
        current ? "path-badge--current" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        "--pb-bg": `var(--scenario-${parsed.path}-${tokenNumber}-bg, var(--scenario-${parsed.path}-1-bg))`,
        "--pb-fg": `var(--scenario-${parsed.path}-${tokenNumber}-text, var(--scenario-${parsed.path}-1-text))`,
      }}
      title={title}
    >
      <span className="path-badge__face" aria-hidden="true">
        <Icon size={size === "md" ? 14 : 12} strokeWidth={2.4} />
      </span>
      <span className="path-badge__label">{label}</span>
      {count > 1 && <span className="path-badge__count">×{count}</span>}
    </span>
  );
}
