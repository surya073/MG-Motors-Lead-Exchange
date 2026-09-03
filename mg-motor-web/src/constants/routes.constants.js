/**
 * routes.constants.js
 * -----------------------------------------------------------------------
 * Every route path as a named constant. Nothing in the app should hardcode
 * a path string like "/dealers" inline â€” importing from here means a path
 * only ever needs to change in one place.
 *
 * MY_LEADS is the Dealer-only equivalent of LEAD_EXCHANGE: same underlying
 * data, but scoped to the logged-in dealer's own Dealer_Code server-side,
 * never client-side filtering of the full list.
 */

export const APP_BASE_PATH = "/app";

export const ROUTES = {
  LOGIN: "/login",
  DASHBOARD: "/dashboard",
  DEALERS: "/dealers",
  LEAD_EXCHANGE: "/lead-exchange",
  MY_LEADS: "/my-leads",
  MAPPINGS: "/mappings",
  LOGS: "/logs",
  SETTINGS: "/settings",
  NOT_FOUND: "/404",
  ERROR: "/error",
  USER_MANAGEMENT: "/user-management",
  ON_DEMAND_DASHBOARD: "/on-demand-dashboard",
};
