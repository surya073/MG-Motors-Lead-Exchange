import { Frown, Smile } from "lucide-react";
import { parsePathName } from "../../../ui/PathBadge/PathBadge";
import "./PathEmptyState.css";

/**
 * Shown on Lead Exchange when a Happy/Unhappy path (reached from an Overview
 * path card or the path filters) has no leads to list. A big, light icon in
 * that path's own colour, so the empty page still feels tied to the card the
 * user clicked.
 *
 *   <PathEmptyState label="Unhappy 3" onClear={...} />
 */
export default function PathEmptyState({ label, onClear }) {
  const parsed = parsePathName(label) || { path: "happy", number: null };
  const isHappy = parsed.path === "happy";
  const Icon = isHappy ? Smile : Frown;
  const n = parsed.number || 1;

  return (
    <div
      className="path-empty"
      style={{
        "--pe-bg": `var(--scenario-${parsed.path}-${n}-bg, var(--scenario-${parsed.path}-1-bg))`,
        "--pe-fg": `var(--scenario-${parsed.path}-${n}-text, var(--scenario-${parsed.path}-1-text))`,
      }}
    >
      <span className="path-empty__icon" aria-hidden="true">
        <Icon size={64} strokeWidth={1.4} />
      </span>
      <h3 className="path-empty__title">{label} path has no leads!</h3>
      <p className="path-empty__text">
        None of your leads are on the {label} path right now. They will show up here as soon as one is.
      </p>
      {onClear && (
        <button type="button" className="path-empty__button" onClick={onClear}>
          Show all leads
        </button>
      )}
    </div>
  );
}
