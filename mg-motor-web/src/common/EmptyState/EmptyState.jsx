import "./EmptyState.css";

/**
 * Generic empty state used anywhere a list, table, or search result has
 * nothing to show â€” dealer lists, lead queues, logs, search results, etc.
 * Business modules pass their own title/description/action; this
 * component holds no business logic of its own.
 */
export default function EmptyState({
  title = "Nothing here yet",
  description = "There's no data to display right now.",
  action = null,
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon" aria-hidden="true">
        <svg viewBox="0 0 48 48" width="40" height="40">
          <rect x="6" y="10" width="36" height="28" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M6 18h36" stroke="currentColor" strokeWidth="2" />
          <path d="M16 27h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="empty-state__title">{title}</h3>
      <p className="empty-state__description">{description}</p>
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
}

