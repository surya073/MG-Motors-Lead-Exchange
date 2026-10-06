import { Link, matchPath, useLocation } from "react-router-dom";
import { useLayout } from "../../../contexts/LayoutContext";
import { useTheme } from "../../../contexts/ThemeContext";
import { useAuth } from "../../../contexts/AuthContext";

import IconButton from "../../../ui/IconButton/IconButton";

import {
  MenuIcon,
  SunIcon,
  SunriseIcon,
  SunsetIcon,
  MoonIcon,
  SettingsIcon,
} from "../../../ui/icons";

import { ROUTES } from "../../../constants/routes.constants";

import NavbarSearch from "./NavbarSearch";
import NotificationBell from "./NotificationBell";
import ProfileDropdown from "./ProfileDropdown";

import "./Navbar.css";

/* =========================================================
   GREETING
========================================================= */

function getGreeting() {
  const hour = new Date().getHours();

  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  if (hour < 21) return "Good evening";

  return "Good night";
}

/* =========================================================
   TIME PERIOD
========================================================= */

function getTimePeriod() {
  const hour = new Date().getHours();

  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";

  return "night";
}

/* =========================================================
   GREETING ICON
========================================================= */

function getGreetingIcon() {
  const period = getTimePeriod();

  switch (period) {
    case "morning":
      return <SunriseIcon size={19} />;

    case "afternoon":
      return <SunIcon size={19} />;

    case "evening":
      return <SunsetIcon size={19} />;

    case "night":
      return <MoonIcon size={19} />;

    default:
      return <SunIcon size={19} />;
  }
}

/* =========================================================
   PAGE HEADERS
========================================================= */

// Plain page header for every non-overview route.
// Copy matches each page's own subtitle where one already exists
// in that page component, so this isn't a second, drifting source of truth.

const PAGE_HEADERS = {
  [ROUTES.ON_DEMAND_DASHBOARD]: {
    title: "On Demand Dashboard",
    subtitle: "Demand and inventory at a glance.",
  },

  [ROUTES.DEALERS]: {
    title: "Dealers",
    subtitle: "Synced from Zoho CRM.",
  },

  [ROUTES.LEAD_EXCHANGE]: {
    title: "Lead Exchange",
    subtitle: "Leads from all dealers.",
  },

  [ROUTES.MY_LEADS]: {
    title: "My Leads",
    subtitle: "Leads assigned to you.",
  },

  [ROUTES.LOGS]: {
    title: "Sync Logs",
    subtitle: "CRM sync run history.",
  },

  [ROUTES.SETTINGS]: {
    title: "Settings",
    subtitle: "Your account and preferences.",
  },

  [ROUTES.DEALER_CRM_CONFIG]: {
    title: "Dealer CRM Connection",
    subtitle: "CRM connection and field mappings.",
  },

  [ROUTES.INTEGRATIONS]: {
    title: "Integration Monitoring",
    subtitle: "Errors and activity per dealer.",
  },

  [ROUTES.USER_MANAGEMENT]: {
    title: "User Management",
    subtitle: "Invite and manage admin users.",
  },
};

// Routes with a parameter (e.g. /lead-exchange/:leadId) can't be looked up by
// exact pathname, so they are matched by pattern instead.
const PATTERN_HEADERS = [
  {
    pattern: ROUTES.LEAD_EXCHANGE_DETAIL,
    header: {
      title: "Lead Details",
      subtitle: "Record, timeline and sync status.",
    },
  },
];

function getPageHeader(pathname) {
  if (PAGE_HEADERS[pathname]) return PAGE_HEADERS[pathname];
  const match = PATTERN_HEADERS.find(({ pattern }) => matchPath({ path: pattern, end: true }, pathname));
  return match ? match.header : undefined;
}

/* =========================================================
   NAVBAR
========================================================= */

export default function Navbar() {
  const { openMobileDrawer } = useLayout();
  const { mode, toggleTheme } = useTheme();
  const { user } = useAuth();
  const location = useLocation();

  const firstName =
    user?.first_name ||
    user?.email_id?.split("@")[0] ||
    "there";

  const isOverview = location.pathname === ROUTES.DASHBOARD;

  const pageHeader = getPageHeader(location.pathname);

  const timePeriod = getTimePeriod();

  return (
    <header className="navbar">

      {/* =====================================================
          LEFT
      ====================================================== */}

      <div className="navbar__greeting">

        <div className="navbar__greeting-row">

          {/* Mobile Menu */}

          <IconButton
            icon={MenuIcon}
            label="Open navigation"
            onClick={openMobileDrawer}
            className="navbar__menu-toggle"
          />

          <div className="navbar__greeting-content">

            {isOverview ? (
              <>
                <h1>
                  {getGreeting()}, {firstName}!

                  <span
                    className={`navbar__greeting-icon navbar__greeting-icon--${timePeriod}`}
                    aria-hidden="true"
                  >
                    {getGreetingIcon()}
                  </span>
                </h1>

                <p>
                  Your lead exchange at a glance.
                </p>
              </>
            ) : (
              <>
                <h1>
                  {pageHeader?.title || "MG Motor"}
                </h1>

                {pageHeader?.subtitle && (
                  <p>{pageHeader.subtitle}</p>
                )}
              </>
            )}

          </div>
        </div>
      </div>

      {/* =====================================================
          RIGHT
      ====================================================== */}

      <div className="navbar__actions">

        {/* Search */}

        <NavbarSearch />

        {/* Theme */}

        <IconButton
          icon={mode === "dark" ? SunIcon : MoonIcon}
          label={
            mode === "dark"
              ? "Switch to light mode"
              : "Switch to dark mode"
          }
          onClick={toggleTheme}
          className="navbar__action-button"
        />

        {/* Notifications */}

        <NotificationBell />

        {/* Settings */}

        <Link
          to={ROUTES.SETTINGS}
          className="navbar__settings"
          aria-label="Settings"
          title="Settings"
        >
          <SettingsIcon size={19} />
        </Link>

        <span className="navbar__divider" />

        {/* Profile */}

        <ProfileDropdown />

      </div>
    </header>
  );
}