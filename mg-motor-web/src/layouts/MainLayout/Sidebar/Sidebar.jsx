import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { useLayout } from "../../../contexts/LayoutContext";
import { useAuth } from "../../../contexts/AuthContext";
import Logo from "../../../ui/Logo/Logo";
import { Crown, Car } from "lucide-react";
import { ROUTES } from "../../../constants/routes.constants";
import { APP_ROLES } from "../../../constants/auth.constants";
import { NAV_ICONS, LogOutIcon, ChevronLeftIcon, ChevronRightIcon } from "../../../ui/icons";
import "./Sidebar.css";

const NAV_SECTIONS = [
  {
    label: "Main",
    items: [
      {
        to: ROUTES.DASHBOARD,
        icon: NAV_ICONS.dashboard,
        label: "Overview",
        allowedRoles: [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN, APP_ROLES.DEALER],
      },
      // {
      //   to: ROUTES.ON_DEMAND_DASHBOARD,
      //   icon: NAV_ICONS.onDemand,
      //   label: "On Demand Dashboard",
      //   allowedRoles: [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN, APP_ROLES.DEALER],
      // },
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
    ],
  },
  {
    label: "Data & Sync",
    items: [
      {
        to: ROUTES.LOGS,
        icon: NAV_ICONS.logs,
        label: "Sync Logs",
        allowedRoles: [APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN],
      },
    ],
  },
];

const ROLE_LABELS = {
  [APP_ROLES.SUPER_ADMIN]: "Super Admin",
  [APP_ROLES.ADMIN]: "Admin",
  [APP_ROLES.DEALER]: "Dealer",
};

const ROLE_ICONS = {
  [APP_ROLES.SUPER_ADMIN]: Crown,
  [APP_ROLES.ADMIN]: Crown,
  [APP_ROLES.DEALER]: Car,
};

export default function Sidebar() {
  const { mobileDrawerOpen, closeMobileDrawer, collapsed, toggleCollapsed } = useLayout();
  const { user, logout } = useAuth();
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

  const handleToggleClick = (event) => {
    event.currentTarget.blur();
    setTooltip(null);
    toggleCollapsed();
  };

  // Tooltip only makes sense on the collapsed desktop rail — expanded state
  // already shows the label inline, and mobile shows the full drawer.
  const showTooltip = (event, label) => {
    if (!collapsed || mobileDrawerOpen) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setTooltip({ label, top: rect.top + rect.height / 2 });
  };

  const hideTooltip = () => setTooltip(null);

  const visibleSections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.allowedRoles.includes(user?.appRole)),
  })).filter((section) => section.items.length > 0);

  const showSettings = user?.appRole === APP_ROLES.SUPER_ADMIN;

  const displayName =
    [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email_id || "Account";
  const roleLabel = ROLE_LABELS[user?.appRole] || "—";
  const RoleAvatarIcon = ROLE_ICONS[user?.appRole];

  return (
    <>
      <aside className={`sidebar ${mobileDrawerOpen ? "sidebar--open" : ""} ${!collapsed || mobileDrawerOpen ? "sidebar--expanded" : ""}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-top">
            <div className="sidebar__brand-badge">
              <Logo size="md" />
            </div>
            <button
              type="button"
              className="sidebar__toggle"
              onClick={handleToggleClick}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand" : "Collapse"}
            >
              {collapsed ? <ChevronRightIcon size={14} /> : <ChevronLeftIcon size={14} />}
            </button>
          </div>
          <span className="sidebar__brand-text">MG Motor</span>
        </div>

        <nav className="sidebar__nav" aria-label="Primary">
          {visibleSections.map((section) => (
            <div className="sidebar__section" key={section.label}>
              <span className="sidebar__section-label">{section.label}</span>
              {section.items.map(({ to, icon: Icon, label }) => (
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
                  <span className="sidebar__link-icon">
                    <Icon size={18} />
                  </span>
                  <span className="sidebar__label">{label}</span>
                </NavLink>
              ))}
            </div>
          ))}

          {showSettings && (
            <div className="sidebar__section">
              <NavLink
                to={ROUTES.SETTINGS}
                onClick={closeMobileDrawer}
                onMouseEnter={(e) => showTooltip(e, "Settings")}
                onMouseLeave={hideTooltip}
                onFocus={(e) => showTooltip(e, "Settings")}
                onBlur={hideTooltip}
                className={({ isActive }) => `sidebar__link sidebar__link--card ${isActive ? "sidebar__link--active" : ""}`}
                aria-label="Settings"
              >
                <span className="sidebar__link-icon">
                  <SettingsIcon size={18} />
                </span>
                <span className="sidebar__label">Settings</span>
                <ChevronRightIcon size={14} className="sidebar__link-chevron" />
              </NavLink>
            </div>
          )}
        </nav>

        <div className="sidebar__footer">
          <div className="sidebar__profile">
            <span className="sidebar__profile-avatar">
            {RoleAvatarIcon ? <RoleAvatarIcon size={16} strokeWidth={2.25} /> : null}
          </span>
            <div className="sidebar__profile-info">
              <span className="sidebar__profile-name">{displayName}</span>
              <span className="sidebar__profile-role">{roleLabel}</span>
            </div>
            <ChevronRightIcon size={14} className="sidebar__profile-chevron" />
          </div>

          <button
            type="button"
            className="sidebar__logout"
            onClick={() => logout()}
            onMouseEnter={(e) => showTooltip(e, "Log out")}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e, "Log out")}
            onBlur={hideTooltip}
            aria-label="Log out"
          >
            <LogOutIcon size={18} />
            <span className="sidebar__label">Log out</span>
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