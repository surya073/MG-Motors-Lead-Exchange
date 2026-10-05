import { AVATAR_COLORS, AVATAR_GLYPHS, useAvatarPreference } from "../../utils/profilePreferences";
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

const ICON_SIZES = { sm: 14, md: 20, lg: 28 };

export default function Avatar({ name, size = "md" }) {
  // Glyph + colour chosen on the Settings page (per browser).
  const { glyph, color } = useAvatarPreference();
  const GlyphIcon = AVATAR_GLYPHS.find((g) => g.id === glyph)?.icon;
  const bg = AVATAR_COLORS.find((c) => c.id === color)?.value;

  return (
    <span
      className={`avatar avatar--${size}`}
      style={bg ? { backgroundColor: bg, color: "#fff" } : undefined}
      aria-hidden="true"
    >
      {GlyphIcon ? <GlyphIcon size={ICON_SIZES[size] || 20} strokeWidth={2.2} /> : getInitials(name)}
    </span>
  );
}

