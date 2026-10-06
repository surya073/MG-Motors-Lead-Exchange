import { ROUTES } from "../constants/routes.constants";
import { APP_ROLES } from "../constants/auth.constants";

/**
 * globalSearch.js
 * -----------------------------------------------------------------------
 * Pure search logic behind the navbar search box — no React, no fetching.
 * Turns a query into a ranked, role-aware list of destinations:
 *   - pages the signed-in role can actually open
 *   - Lead Exchange scenarios ("Unhappy 3", "Happy 1" ...)
 *   - leads and dealers (from lists the caller passes in)
 *   - "search this text in ..." fallbacks that open a page pre-filtered
 *
 * Every result carries the exact route to navigate to, so choosing it
 * simply routes there. Role access mirrors AppRoutes / Sidebar; the real
 * boundary is still the route guards and the backend.
 */

const ADMIN_SIDE = [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN, APP_ROLES.VIEW_USER];

export const SEARCH_PAGES = [
  {
    id: "overview",
    label: "Overview",
    hint: "Dashboard, KPIs and lead exchange health",
    to: ROUTES.DASHBOARD,
    icon: "overview",
    roles: [...ADMIN_SIDE, APP_ROLES.DEALER],
    keywords: "home dashboard summary kpi health sla duplicate status",
  },
  {
    id: "dealers",
    label: "Dealers",
    hint: "Dealer network and sync status",
    to: ROUTES.DEALERS,
    icon: "dealers",
    roles: ADMIN_SIDE,
    keywords: "dealer network region state city list",
  },
  {
    id: "lead-exchange",
    label: "Lead Exchange",
    hint: "All leads across dealers",
    to: ROUTES.LEAD_EXCHANGE,
    icon: "leads",
    roles: ADMIN_SIDE,
    keywords: "leads enquiries enquiry pipeline customers exchange happy unhappy path",
  },
  {
    id: "my-leads",
    label: "My Leads",
    hint: "Leads assigned to your dealership",
    to: ROUTES.MY_LEADS,
    icon: "leads",
    roles: [APP_ROLES.DEALER],
    keywords: "leads enquiries enquiry customers pipeline update",
  },
  {
    id: "logs",
    label: "Sync Logs",
    hint: "Every sync run and its result",
    to: ROUTES.LOGS,
    icon: "logs",
    roles: ADMIN_SIDE,
    keywords: "sync logs history runs activity audit webhook cron",
  },
  {
    id: "integrations",
    label: "Integrations",
    hint: "Integration errors and monitoring",
    to: ROUTES.INTEGRATIONS,
    icon: "integrations",
    roles: ADMIN_SIDE,
    keywords: "integration errors failures failed monitoring report dealer events",
  },
  {
    id: "crm-config",
    label: "Dealer CRM Connection",
    hint: "CRM mode, field and status mappings",
    to: ROUTES.DEALER_CRM_CONFIG,
    icon: "crm",
    roles: ADMIN_SIDE,
    keywords: "crm config configuration connection mapping field status external portal webhook credentials",
  },
  {
    id: "user-management",
    label: "User Management",
    hint: "Invite and manage admin users",
    to: ROUTES.USER_MANAGEMENT,
    icon: "users",
    roles: [APP_ROLES.SUPER_ADMIN],
    keywords: "users invite roles access admin permissions people",
  },
  {
    id: "settings",
    label: "Settings",
    hint: "Theme, accent color, avatar, notifications, session",
    to: ROUTES.SETTINGS,
    icon: "settings",
    roles: [...ADMIN_SIDE, APP_ROLES.DEALER],
    keywords: "settings preferences theme dark light accent color avatar profile picture font size notifications bell session password reset logout",
  },
];

const norm = (value) => String(value ?? "").toLowerCase().trim();
const squash = (value) => norm(value).replace(/[\s_-]+/g, "");

/** Every whitespace-separated token must appear somewhere in the haystack. */
function matches(haystack, query) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const h = norm(haystack);
  return tokens.every((t) => h.includes(t));
}

/** Lower is better. */
function rank(label, query) {
  const l = norm(label);
  const q = norm(query);
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  if (l.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  return 3;
}

function byRank(items, query) {
  return [...items].sort((a, b) => rank(a.label, query) - rank(b.label, query));
}

export function pagesForRole(role) {
  return SEARCH_PAGES.filter((p) => p.roles.includes(role));
}

export function isAdminSide(role) {
  return ADMIN_SIDE.includes(role);
}

/**
 * @param {string} rawQuery
 * @param {{ role: string, leads?: object[], dealers?: object[], scenarios?: Record<string, {description: string, trigger: string}> }} ctx
 * @returns {{ id: string, group: string, label: string, hint?: string, to: string, icon: string }[]}
 */
export function runSearch(rawQuery, { role, leads = [], dealers = [], scenarios = {} }) {
  const query = rawQuery.trim();
  const admin = isAdminSide(role);

  // Empty query: just offer the pages this role can open.
  if (!query) {
    return pagesForRole(role).map((p) => ({ ...p, group: "Go to" }));
  }

  const results = [];

  // --- Pages -------------------------------------------------------
  const pageHits = byRank(
    pagesForRole(role).filter((p) => matches(`${p.label} ${p.hint} ${p.keywords}`, query)),
    query
  ).slice(0, 5);
  pageHits.forEach((p) => results.push({ ...p, group: "Pages" }));

  // --- Lead Exchange scenarios (admin side only) ---------------------
  if (admin) {
    const compact = squash(query);
    const scenarioHits = Object.entries(scenarios)
      .filter(([name, meta]) => {
        if (squash(name).includes(compact)) return true; // "unhappy3", "happy 1"
        return matches(`${name} ${meta.description} ${meta.trigger}`, query);
      })
      .slice(0, 4)
      .map(([name, meta]) => ({
        id: `scenario-${name}`,
        group: "Lead Exchange scenarios",
        label: name,
        hint: meta.description,
        to: `${ROUTES.LEAD_EXCHANGE}?scenario=${encodeURIComponent(name)}`,
        icon: /^happy/i.test(name) ? "happy" : "unhappy",
      }));
    results.push(...scenarioHits);
  }

  // --- Leads ------------------------------------------------------------
  const leadHits = leads
    .filter((l) =>
      matches(
        [l.customer_name, l.email_address, l.mobile_number, l.vehicle_model, l.dealer_name, l.dealer_code].join(" "),
        query
      )
    )
    .slice(0, 5)
    .map((l) => ({
      id: `lead-${l.ROWID}`,
      group: "Leads",
      label: l.customer_name || "Unnamed lead",
      hint: [l.vehicle_model, l.dealer_name || l.dealer_code, l.lead_status].filter(Boolean).join(" · "),
      // Admin side has a per-lead detail route; dealers get their list pre-filtered.
      to: admin
        ? `${ROUTES.LEAD_EXCHANGE}/${l.ROWID}`
        : `${ROUTES.MY_LEADS}?search=${encodeURIComponent(l.customer_name || query)}`,
      icon: "lead",
    }));
  results.push(...leadHits);

  // --- Dealers (admin side only) ---------------------------------------
  if (admin) {
    const dealerHits = dealers
      .filter((d) => matches([d.dealer_name, d.dealer_code, d.city, d.state, d.region].join(" "), query))
      .slice(0, 4)
      .map((d) => ({
        id: `dealer-${d.dealer_code || d.ROWID}`,
        group: "Dealers",
        label: d.dealer_name || d.dealer_code,
        hint: [d.dealer_code, d.city, d.state].filter(Boolean).join(" · "),
        to: `${ROUTES.DEALERS}?search=${encodeURIComponent(d.dealer_code || d.dealer_name)}`,
        icon: "dealer",
      }));
    results.push(...dealerHits);
  }

  // --- "Search this text in ..." fallbacks -----------------------------
  const q = encodeURIComponent(query);
  if (admin) {
    results.push(
      {
        id: "find-leads",
        group: "Search for “" + query + "” in",
        label: "Lead Exchange",
        hint: "Customers, emails, mobiles, vehicles, dealers",
        to: `${ROUTES.LEAD_EXCHANGE}?search=${q}`,
        icon: "leads",
      },
      {
        id: "find-dealers",
        group: "Search for “" + query + "” in",
        label: "Dealers",
        hint: "Names, codes, regions",
        to: `${ROUTES.DEALERS}?search=${q}`,
        icon: "dealers",
      },
      {
        id: "find-logs",
        group: "Search for “" + query + "” in",
        label: "Sync Logs",
        hint: "Sync runs and triggers",
        to: `${ROUTES.LOGS}?search=${q}`,
        icon: "logs",
      }
    );
  } else {
    results.push({
      id: "find-my-leads",
      group: "Search for “" + query + "” in",
      label: "My Leads",
      hint: "Customers, emails, mobiles, vehicles",
      to: `${ROUTES.MY_LEADS}?search=${q}`,
      icon: "leads",
    });
  }

  return results;
}
