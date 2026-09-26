import { ROUTES } from "./routes.constants";

/**
 * navigation.constants.js
 * -----------------------------------------------------------------------
 * Single source of truth for "what's in the sidebar" and "what does this
 * route display as" (used by both Sidebar and Breadcrumb). Business
 * modules that don't exist until later days are listed here already â€”
 * same pattern as Day 1's route tree: the navigation structure doesn't
 * move when a module gets built, only the icon/label stay stable.
 */

export const NAV_ITEMS = [
  { label: "Dashboard", path: ROUTES.DASHBOARD, icon: "dashboard" },
  { label: "Dealers", path: ROUTES.DEALERS, icon: "dealers" },
  { label: "Lead Exchange", path: ROUTES.LEAD_EXCHANGE, icon: "leadExchange" },
  { label: "Mappings", path: ROUTES.MAPPINGS, icon: "mappings" },
  { label: "Logs", path: ROUTES.LOGS, icon: "logs" },
  { label: "Settings", path: ROUTES.SETTINGS, icon: "settings" },
  { label: "Integrations", path: ROUTES.INTEGRATIONS, icon: "integrations" },
];

// Used by Breadcrumb to resolve the current path to a display label
// without duplicating the list above.
export const ROUTE_LABELS = NAV_ITEMS.reduce((acc, item) => {
  acc[item.path] = item.label;
  return acc;
}, {});

