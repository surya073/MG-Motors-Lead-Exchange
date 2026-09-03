/**
 * auth.constants.js
 * -----------------------------------------------------------------------
 * Fixed values used by the authentication module. Kept out of AuthContext
 * and LoginPage so nothing about the Catalyst SDK integration is
 * hardcoded inline in a component.
 */

import { APP_BASE_PATH } from "./routes.constants";

// The DOM element Catalyst's signIn() call injects its credential iframe
// into. Must be unique on the login page.
export const CATALYST_SIGNIN_ELEMENT_ID = "mglx-catalyst-signin";

// Passed as the second argument to catalyst.auth.signIn(elementId, config).
// css_url points at our own stylesheet so the embedded iframe follows the
// MG Motor theme instead of Catalyst's default styling â€” see
// public/embedded-auth.css. Must include APP_BASE_PATH: Catalyst's Web
// Client Hosting serves static files under /app/, not domain root, so a
// root-relative path here 404s (confirmed by the same pattern with
// logo.svg 404ing at /app/logo.svg, not /logo.svg).
export const CATALYST_SIGNIN_CONFIG = {
  css_url: `${APP_BASE_PATH}/embedded-auth.css`,
};

// How often an already-authenticated session is re-validated in the
// background, so an expired/revoked session is caught even if the user
// never triggers a 401 by calling an API.
export const SESSION_REVALIDATE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Add to the existing file â€” do not remove SESSION_REVALIDATE_INTERVAL_MS etc.

/**
 * Normalized app-level roles. Everything else in the app should check
 * against these, never against a raw Catalyst role_id or role_name â€”
 * that mapping lives in exactly one place: normalizeRole() in AuthContext.
 */
export const APP_ROLES = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  DEALER: "DEALER",
  UNKNOWN: "UNKNOWN",
};

/**
 * Maps Catalyst Console role IDs to app roles. Role IDs came from the
 * Console screenshot (Jul 29, 2026) â€” if roles are ever recreated or
 * IDs change, update only here.
 */
export const CATALYST_ROLE_ID_MAP = {
  "37148000000359008": APP_ROLES.SUPER_ADMIN, // App Administrator
  "37148000000430003": APP_ROLES.ADMIN,        // Admin
  "37148000000430005": APP_ROLES.DEALER,       // Dealer
  // "37148000000359009" (App User / Default) intentionally unmapped â€”
  // falls through to UNKNOWN, which gets no sidebar items and no routes.
};

/**
 * Fallback matcher by role_name, in case role_details ever comes back
 * with a name but a missing/renamed role_id.
 */
export const CATALYST_ROLE_NAME_MAP = {
  "App Administrator": APP_ROLES.SUPER_ADMIN,
  "Admin": APP_ROLES.ADMIN,
  "Dealer": APP_ROLES.DEALER,
};

