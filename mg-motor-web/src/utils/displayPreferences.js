/**
 * Display preferences chosen on the Settings page. Each one is stored in
 * localStorage and mirrored onto <html> as a data attribute, which plain
 * CSS in styles/variables.css reacts to — so no component logic changes.
 *   settings:tableDensity -> data-table-density  ("comfortable" | "compact")
 *   settings:highContrast -> data-contrast       ("high" when on)
 */
export const TABLE_DENSITY_KEY = "settings:tableDensity";
export const HIGH_CONTRAST_KEY = "settings:highContrast";

export function readTableDensity() {
  try {
    return localStorage.getItem(TABLE_DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function readHighContrast() {
  try {
    return localStorage.getItem(HIGH_CONTRAST_KEY) === "true";
  } catch {
    return false;
  }
}

export function applyTableDensity(value) {
  const next = value === "compact" ? "compact" : "comfortable";
  try {
    localStorage.setItem(TABLE_DENSITY_KEY, next);
  } catch {
    // Storage unavailable — the attribute below still applies this session.
  }
  if (next === "compact") document.documentElement.setAttribute("data-table-density", "compact");
  else document.documentElement.removeAttribute("data-table-density");
}

export function applyHighContrast(enabled) {
  try {
    localStorage.setItem(HIGH_CONTRAST_KEY, String(!!enabled));
  } catch {
    // see above
  }
  if (enabled) document.documentElement.setAttribute("data-contrast", "high");
  else document.documentElement.removeAttribute("data-contrast");
}

/** Re-applies saved choices on app load (attributes reset on refresh). */
export function restoreDisplayPreferences() {
  if (readTableDensity() === "compact") document.documentElement.setAttribute("data-table-density", "compact");
  if (readHighContrast()) document.documentElement.setAttribute("data-contrast", "high");
}
