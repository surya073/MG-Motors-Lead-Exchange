import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../../contexts/AuthContext";
import { APP_ROLES } from "../../../constants/auth.constants";
import Avatar from "../../../ui/Avatar/Avatar";
import { ChevronDownIcon, SettingsIcon, LogOutIcon } from "../../../ui/icons";
import { ROUTES } from "../../../constants/routes.constants";
import "./ProfileDropdown.css";

const ROLE_LABELS = {
  [APP_ROLES.SUPER_ADMIN]: "Super Admin",
  [APP_ROLES.ADMIN]: "Admin",
  [APP_ROLES.DEALER]: "Dealer",
};

/**
 * ProfileDropdown.jsx
 * -----------------------------------------------------------------------
 * Replaces common/LogoutButton (Day 2's temporary stand-in, now deleted).
 * Reads the same useAuth().user/logout — nothing about the auth
 * integration changes, only where the control lives.
 */
export default function ProfileDropdown() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email_id || "Account";
  const roleLabel = ROLE_LABELS[user?.appRole] || null;

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="profile-dropdown" ref={containerRef}>
      <button
        className="btn btn--ghost profile-dropdown__trigger"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Avatar name={displayName} size="sm" />
        <span className="profile-dropdown__name">{displayName}</span>
        <ChevronDownIcon size={16} />
      </button>

      {open && (
        <div className="profile-dropdown__panel" role="menu">
          <div className="profile-dropdown__header">
            <Avatar name={displayName} size="md" />
            <div>
              <div className="profile-dropdown__header-name">{displayName}</div>
              {user?.email_id && <div className="profile-dropdown__header-email">{user.email_id}</div>}
              {roleLabel && <span className="profile-dropdown__header-role">{roleLabel}</span>}
            </div>
          </div>

          <div className="profile-dropdown__divider" />

          <Link
            to={ROUTES.SETTINGS}
            className="btn btn--ghost profile-dropdown__item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <SettingsIcon size={17} />
            Settings
          </Link>
          <button
            className="btn btn--ghost profile-dropdown__item profile-dropdown__item--danger"
            role="menuitem"
            onClick={() => logout()}
          >
            <LogOutIcon size={17} />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}