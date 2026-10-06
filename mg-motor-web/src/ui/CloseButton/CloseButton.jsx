import { X } from "lucide-react";
import "./CloseButton.css";

/**
 * CloseButton.jsx
 * -----------------------------------------------------------------------
 * The one close control for every offcanvas / drawer / side panel, so they
 * all look and behave identically. Its design is the Dealer Details
 * offcanvas close button: a 34px round button, 18px X icon, and a quarter
 * turn on hover.
 *
 *   variant="default" — theme-aware (light/dark) for normal panel headers
 *   variant="glass"   — translucent white, for sitting on a dark photo/hero
 *
 * Position it with `className` (e.g. absolute top/right on a hero) —
 * the button itself carries no positioning.
 */
export default function CloseButton({ onClick, label = "Close", variant = "default", className = "" }) {
  return (
    <button
      type="button"
      className={`close-btn close-btn--${variant} ${className}`}
      onClick={onClick}
      aria-label={label}
    >
      <X size={18} />
    </button>
  );
}
