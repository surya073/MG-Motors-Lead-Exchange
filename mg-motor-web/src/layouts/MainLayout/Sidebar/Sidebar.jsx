import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { useLayout } from "../../../contexts/LayoutContext";
import { useAuth } from "../../../contexts/AuthContext";
import Logo from "../../../ui/Logo/Logo";
import { ROUTES } from "../../../constants/routes.constants";
import { APP_ROLES } from "../../../constants/auth.constants";
import { NAV_ICONS, LogOutIcon, ChevronLeftIcon } from "../../../ui/icons";
import "./Sidebar.css";

const NAV_ITEMS = [
  {
    to: ROUTES.DASHBOARD,
    icon: NAV_ICONS.dashboard,
    label: "Overview",
    allowedRoles: [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN, APP_ROLES.DEALER],
  },
    {
    to: ROUTES.ON_DEMAND_DASHBOARD,
    icon: NAV_ICONS.onDemand,
    label: "On Demand Dashboard",
    allowedRoles: [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN, APP_ROLES.DEALER],
  },
  {
    to: ROUTES.DEALERS,
    icon: NAV_ICONS.dealers,
    label: "Dealers",
    allowedRoles: [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN],
  },
  {
    to: ROUTES.LEAD_EXCHANGE,
    icon: NAV_ICONS.leadExchange,
    label: "Lead exchange",
    allowedRoles: [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN],
  },
  {
    to: ROUTES.MY_LEADS,
    icon: NAV_ICONS.leadExchange,
    label: "My leads",
    allowedRoles: [APP_ROLES.DEALER],
  },
  {
    to: ROUTES.LOGS,
    icon: NAV_ICONS.logs,
    label: "Sync Logs",
    allowedRoles: [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN],
  },
];

export default function Sidebar() {
  const { mobileDrawerOpen, closeMobileDrawer, collapsed, toggleCollapsed } = useLayout();
  const { user } = useAuth();
  const [tooltip, setTooltip] = useState(null); // { label, top } | null
  const SettingsIcon = NAV_ICONS.settings;

  useEffect(() => {
    if (!mobileDrawerOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileDrawerOpen]);

  const handlePinClick = (event) => {
    event.currentTarget.blur();
    setTooltip(null);
    toggleCollapsed();
  };

  // Tooltip only makes sense on the collapsed desktop rail — expanded state
  // already shows the label inline, and mobile shows the full drawer.
  const showTooltip = (event, label) => {
    if (!collapsed) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({ label, top: rect.top + rect.height / 2 });
  };

  const hideTooltip = () => setTooltip(null);

  const visibleNavItems = NAV_ITEMS.filter((item) => item.allowedRoles.includes(user?.appRole));
  const showSettings = user?.appRole === APP_ROLES.SUPER_ADMIN;

  return (
    <>
      <aside className={`sidebar ${mobileDrawerOpen ? "sidebar--open" : ""} ${!collapsed ? "sidebar--expanded" : ""}`}>
        <div className="sidebar__brand">
          <Logo size="lg" />
          <span className="sidebar__brand-text">MG Motor</span>
        </div>

        <nav className="sidebar__nav" aria-label="Primary">
          {visibleNavItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              onClick={closeMobileDrawer}
              onMouseEnter={(e) => showTooltip(e, label)}
              onMouseLeave={hideTooltip}
              onFocus={(e) => showTooltip(e, label)}
              onBlur={hideTooltip}
              className={({ isActive }) => `sidebar__link ${isActive ? "sidebar__link--active" : ""}`}
              aria-label={label}
            >
              <Icon size={20} />
              <span className="sidebar__label">{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar__footer">
          {showSettings && (
            <NavLink
              to={ROUTES.SETTINGS}
              onClick={closeMobileDrawer}
              onMouseEnter={(e) => showTooltip(e, "Settings")}
              onMouseLeave={hideTooltip}
              onFocus={(e) => showTooltip(e, "Settings")}
              onBlur={hideTooltip}
              className="sidebar__link"
              aria-label="Settings"
            >
              <SettingsIcon size={20} />
              <span className="sidebar__label">Settings</span>
            </NavLink>
          )}
          <button
            type="button"
            className="sidebar__link sidebar__logout"
            onMouseEnter={(e) => showTooltip(e, "Log out")}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e, "Log out")}
            onBlur={hideTooltip}
            aria-label="Log out"
          >
            <LogOutIcon size={20} />
            <span className="sidebar__label">Log out</span>
          </button>
          <button
            type="button"
            className="sidebar__pin"
            onClick={handlePinClick}
            aria-label={collapsed ? "Pin sidebar open" : "Unpin sidebar"}
            title={collapsed ? "Pin open" : "Unpin"}
          >
            <ChevronLeftIcon size={16} />
            <span className="sidebar__label">{collapsed ? "Pin open" : "Unpin"}</span>
          </button>
        </div>
      </aside>

      {tooltip && (
        <div className="sidebar__tooltip" style={{ top: tooltip.top }}>
          {tooltip.label}
        </div>
      )}

      {mobileDrawerOpen && <div className="sidebar__scrim" onClick={closeMobileDrawer} />}
    </>
  );
}