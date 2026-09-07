import { useState } from "react";
import { Link } from "react-router-dom";
import { User, Palette, Bell, Users, KeyRound, LogOut, Sun, Moon, BellDot, BellRing, BellOff, ChevronRight, Plug } from "lucide-react";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import { authService } from "../../services/api/authService";
import { APP_ROLES } from "../../constants/auth.constants";
import { ROUTES } from "../../constants/routes.constants";
import { useAlerts } from "../../ui/Alerts/Alerts";
import "./SettingsPage.css";

const FONT_SIZE_STORAGE_KEY = "settings:fontSize";
const NOTIF_STYLE_STORAGE_KEY = "settings:notificationStyle";

const FONT_SIZES = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const NOTIF_STYLES = [
  { value: "dot", label: "Dot", description: "Show dot", icon: BellDot },
  { value: "badge", label: "Badge", description: "Show count", icon: BellRing },
  { value: "hidden", label: "Hide", description: "Hide all", icon: BellOff },
];

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const { mode, toggleTheme } = useTheme();
  const { showAlert } = useAlerts();

  const [resetSending, setResetSending] = useState(false);

  const [fontSize, setFontSize] = useState(() => {
    if (typeof window === "undefined") return "medium";
    return localStorage.getItem(FONT_SIZE_STORAGE_KEY) || "medium";
  });

  const [notificationStyle, setNotificationStyle] = useState(() => {
    if (typeof window === "undefined") return "badge";
    return localStorage.getItem(NOTIF_STYLE_STORAGE_KEY) || "badge";
  });

  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email_id;
  const isSuperAdmin = user?.appRole === APP_ROLES.SUPER_ADMIN;
  const isAdmin = user?.appRole === APP_ROLES.ADMIN || isSuperAdmin;

  const handlePasswordReset = async () => {
    setResetSending(true);
    try {
      await authService.sendPasswordReset(user?.email_id);
      showAlert("success", "Check your inbox for the reset link.", { title: "Reset email sent" });
    } catch (err) {
      showAlert("error", err?.message || "Couldn't send reset email. Try again.", { title: "Reset failed" });
    } finally {
      setResetSending(false);
    }
  };

  const handleFontSizeChange = (value) => {
    setFontSize(value);
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, value);
    document.documentElement.setAttribute("data-font-size", value);
  };

  const handleNotificationStyleChange = (value) => {
    setNotificationStyle(value);
    localStorage.setItem(NOTIF_STYLE_STORAGE_KEY, value);
  };

  return (
    <div className="settings">
      <div className="settings__grid">
        {/* ---------- Account ---------- */}
        <div className="settings__card">
          <div className="settings__card-header">
            <span className="settings__card-icon">
              <User size={18} />
            </span>
            <h3>Account</h3>
          </div>

          <div className="settings__row settings__row--first">
            <div>
              <p className="settings__label">Signed in as</p>
              <p className="settings__value">{displayName}</p>
            </div>
          </div>

          <div className="settings__row">
            <div>
              <p className="settings__label">Password</p>
              <p className="settings__value-muted">Send a password reset link to your email.</p>
            </div>
            <button className="settings__button settings__button--outline" onClick={handlePasswordReset} disabled={resetSending}>
              <KeyRound size={14} strokeWidth={2.5} />
              {resetSending ? "Sending…" : "Reset password"}
            </button>
          </div>

          <div className="settings__row">
            <div>
              <p className="settings__label">Session</p>
              <p className="settings__value-muted">Sign out of your account on this device.</p>
            </div>
            <button className="settings__button settings__button--danger-outline" onClick={() => logout()}>
              <LogOut size={14} strokeWidth={2.5} />
              Log out
            </button>
          </div>
        </div>

        {/* ---------- Appearance ---------- */}
        <div className="settings__card">
          <div className="settings__card-header">
            <span className="settings__card-icon">
              <Palette size={18} />
            </span>
            <h3>Appearance</h3>
          </div>

          <div className="settings__row settings__row--first">
            <div>
              <p className="settings__label">Theme</p>
              <p className="settings__value-muted">Switch between light and dark mode.</p>
            </div>
            <button className="settings__button settings__button--outline" onClick={toggleTheme}>
              {mode === "dark" ? <Sun size={14} strokeWidth={2.5} /> : <Moon size={14} strokeWidth={2.5} />}
              {mode === "dark" ? "Switch to light" : "Switch to dark"}
            </button>
          </div>

          <div className="settings__row settings__row--column">
            <div>
              <p className="settings__label">Font size</p>
              <p className="settings__value-muted">Adjust the size of text across the application.</p>
            </div>
            <div className="settings__option-group">
              {FONT_SIZES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`settings__option ${fontSize === value ? "settings__option--active" : ""}`}
                  onClick={() => handleFontSizeChange(value)}
                >
                  <span className={`settings__option-glyph settings__option-glyph--${value}`}>A</span>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ---------- Notifications ---------- */}
        <div className="settings__card">
          <div className="settings__card-header">
            <span className="settings__card-icon">
              <Bell size={18} />
            </span>
            <h3>Notifications</h3>
          </div>

          <div className="settings__row settings__row--column settings__row--first">
            <div>
              <p className="settings__label">In-app notifications</p>
              <p className="settings__value-muted">Choose how you want to see notifications.</p>
            </div>
            <div className="settings__option-group settings__option-group--notif">
              {NOTIF_STYLES.map(({ value, label, description, icon: Icon }) => {
                const active = notificationStyle === value;
                return (
                  <button
                    key={value}
                    type="button"
                    className={`settings__notif-option ${active ? "settings__notif-option--active" : ""}`}
                    onClick={() => handleNotificationStyleChange(value)}
                  >
                    <span className="settings__notif-icon-wrap">
                      <Icon size={18} />
                      {value === "dot" && <span className="settings__notif-preview-dot" />}
                      {value === "badge" && <span className="settings__notif-preview-badge">3</span>}
                    </span>
                    <span className="settings__notif-option-label">{label}</span>
                    <span className="settings__notif-option-desc">{description}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Admin / Super Admin only — configure external dealer CRM
            integrations (Portal vs External CRM, field/status mappings,
            connection test). Role-agnostic here; the real security
            boundary is requireAdminRole/requireSuperAdminRole on the
            backend and the RequireRole wrapper on the route itself. */}
        {isAdmin && (
          <div className="settings__card">
            <div className="settings__card-header">
              <span className="settings__card-icon">
                <Plug size={18} />
              </span>
              <h3>Dealer CRM Connection</h3>
            </div>

            <div className="settings__row settings__row--first">
              <div>
                <p className="settings__label">External CRM integrations</p>
                <p className="settings__value-muted">
                  Configure Portal vs External CRM mode, field/status mappings, and connection settings per dealer.
                </p>
              </div>
              <Link to={ROUTES.DEALER_CRM_CONFIG} className="settings__button settings__button--primary">
                Configure
                <ChevronRight size={14} strokeWidth={2.5} />
              </Link>
            </div>
          </div>
        )}

        {/* Super Admin only — invite/manage Dealer-role users via
            admin_user_mapping. Not a RequireRole route guard here since
            SettingsPage itself is role-agnostic; this section is simply
            conditionally rendered. The real security boundary is still
            the backend's requireSuperAdminRole middleware and the
            RequireRole wrapper on the /user-management route itself. */}
        {isSuperAdmin && (
          <div className="settings__card">
            <div className="settings__card-header">
              <span className="settings__card-icon">
                <Users size={18} />
              </span>
              <h3>User Management</h3>
            </div>

            <div className="settings__row settings__row--first">
              <div>
                <p className="settings__label">Dealer access</p>
                <p className="settings__value-muted">Invite, resend, or remove Admin-role users.</p>
              </div>
              <Link to={ROUTES.USER_MANAGEMENT} className="settings__button settings__button--primary">
                Manage users
                <ChevronRight size={14} strokeWidth={2.5} />
              </Link>
            </div>
          </div>
        )}
      </div>

      <div className="settings__footer">
        <span className="settings__footer-line" />
        <span className="settings__footer-brand">MG MOTORS AUSTRALIA</span>
        <span className="settings__footer-tagline">Drive the future</span>
        <span className="settings__footer-line" />
      </div>
    </div>
  );
}