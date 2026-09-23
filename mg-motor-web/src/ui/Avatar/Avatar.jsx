import "./Avatar.css";

/**
 * Avatar.jsx
 * -----------------------------------------------------------------------
 * Initials-based avatar â€” no photo upload/storage exists yet, so this
 * derives a two-letter mark from the user's name/email instead of
 * expecting an image URL that doesn't exist.
 */
function getInitials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Avatar({ name, size = "md" }) {
  return (
    <span className={`avatar avatar--${size}`} aria-hidden="true">
      {getInitials(name)}
    </span>
  );
}

