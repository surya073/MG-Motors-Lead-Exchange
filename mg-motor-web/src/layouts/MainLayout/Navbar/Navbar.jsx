import { Link, useLocation } from "react-router-dom";
import { useLayout } from "../../../contexts/LayoutContext";
import { useTheme } from "../../../contexts/ThemeContext";
import { useAuth } from "../../../contexts/AuthContext";

import IconButton from "../../../ui/IconButton/IconButton";

import {
  MenuIcon,
  SunIcon,
  MoonIcon,
  SettingsIcon,
  SearchIcon,
} from "../../../ui/icons";

import { ROUTES } from "../../../constants/routes.constants";

import NotificationBell from "./NotificationBell";
import ProfileDropdown from "./ProfileDropdown";

import "./Navbar.css";

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

// Plain page header for every non-overview route. Copy matches each
// page's own subtitle where one already exists in that page component,
// so this isn't a second, drifting source of truth.
const PAGE_HEADERS = {
  [ROUTES.ON_DEMAND_DASHBOARD]: {
    title: "On Demand Dashboard",
    subtitle: "Live view of demand and inventory movement.",
  },
  [ROUTES.DEALERS]: {
    title: "Dealers",
    subtitle: "Dealers synced from Zoho CRM Dealer_Master.",
  },
  [ROUTES.LEAD_EXCHANGE]: {
    title: "Lead Exchange",
    subtitle: "Leads synced from Zoho CRM OEM_Leads, across all dealers.",
  },
  [ROUTES.MY_LEADS]: {
    title: "My Leads",
    subtitle: "Leads assigned to you.",
  },
  [ROUTES.LOGS]: {
    title: "Sync Logs",
    subtitle: "History of CRM synchronization runs.",
  },
  [ROUTES.SETTINGS]: {
    title: "Settings",
    subtitle: "Manage your account and preferences.",
  },
};

export default function Navbar() {
  const { openMobileDrawer } = useLayout();
  const { mode, toggleTheme } = useTheme();
  const { user } = useAuth();
  const location = useLocation();

  const firstName = user?.first_name || user?.email_id?.split("@")[0] || "there";
  const isOverview = location.pathname === ROUTES.DASHBOARD;
  const pageHeader = PAGE_HEADERS[location.pathname];

  return (
    <header className="navbar">
      {/* =====================================================
          LEFT
      ====================================================== */}

      <div className="navbar__greeting">
        <div className="navbar__greeting-row">
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
                  {getGreeting()}, {firstName}! <span>👋</span>
                </h1>
                <p>Here's what's happening with your lead exchange today.</p>
              </>
            ) : (
              <>
                <h1>{pageHeader?.title || "MG Motor"}</h1>
                {pageHeader?.subtitle && <p>{pageHeader.subtitle}</p>}
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

        <div className="navbar__search">
          <SearchIcon size={18} />

          <input type="text" placeholder="Search dealers, leads, logs..." aria-label="Search" />

          <span className="navbar__search-shortcut">/</span>
        </div>

        {/* Theme */}

        <IconButton
          icon={mode === "dark" ? SunIcon : MoonIcon}
          label={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={toggleTheme}
          className="navbar__action-button"
        />

        {/* Notifications */}

        <NotificationBell />

        {/* Settings */}

        <Link to={ROUTES.SETTINGS} className="navbar__settings" aria-label="Settings" title="Settings">
          <SettingsIcon size={19} />
        </Link>

        <span className="navbar__divider" />

        {/* Profile */}

        <ProfileDropdown />
      </div>
    </header>
  );
}