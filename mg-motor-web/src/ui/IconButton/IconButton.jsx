import "./IconButton.css";

/**
 * IconButton.jsx
 * -----------------------------------------------------------------------
 * A plain, generic icon-only button â€” no business logic, reused for the
 * hamburger toggle, notification bell, theme switch, and settings link.
 */
export default function IconButton({ icon: IconComponent, label, active = false, className = "", ...props }) {
  const classes = ["icon-button", active && "icon-button--active", className].filter(Boolean).join(" ");

  return (
    <button className={classes} aria-label={label} title={label} {...props}>
      <IconComponent size={19} />
    </button>
  );
}

