import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Palette,
  Bell,
  Users,
  KeyRound,
  LogOut,
  Sun,
  Moon,
  BellDot,
  BellRing,
  BellOff,
  ChevronRight,
  Plug,
  Mail,
  ShieldCheck,
  Type,
  Check,
  RotateCcw,
  Monitor,
  Globe,
  Clock,
  Timer,
  UserCircle,
} from "lucide-react";
import Avatar from "../../ui/Avatar/Avatar";
import { useAuth } from "../../contexts/AuthContext";
import { useTheme } from "../../contexts/ThemeContext";
import { authService } from "../../services/api/authService";
import { APP_ROLES } from "../../constants/auth.constants";
import { ROUTES } from "../../constants/routes.constants";
import { useAlerts } from "../../ui/Alerts/Alerts";
import { useNotificationStyle } from "../../utils/notificationStyle";
import {
  ACCENT_COLORS,
  AVATAR_COLORS,
  AVATAR_GLYPHS,
  formatDuration,
  getSessionStart,
  resetProfilePreferences,
  useAccentColor,
  useAvatarPreference,
} from "../../utils/profilePreferences";
import {
  applyHighContrast,
  applyTableDensity,
  readHighContrast,
  readTableDensity,
} from "../../utils/displayPreferences";
import "./SettingsPage.css";

/** Live session clock — isolated so its 1s tick never re-renders the whole page. */
function SessionClock({ startedAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="settings__fact-value settings__fact-value--mono">{formatDuration(now - startedAt)}</span>;
}

const FONT_SIZE_STORAGE_KEY = "settings:fontSize";
const REDUCE_MOTION_STORAGE_KEY = "settings:reduceMotion";

const ROLE_LABELS = {
  [APP_ROLES.SUPER_ADMIN]: "Super Admin",
  [APP_ROLES.ADMIN]: "Admin",
  [APP_ROLES.DEALER]: "Dealer",
  [APP_ROLES.VIEW_USER]: "View only",
};

const FONT_SIZES = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const TABLE_DENSITIES = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];

const NOTIF_STYLES = [
  { value: "dot", label: "Dot", description: "Dot only, no number", icon: BellDot },
  { value: "badge", label: "Badge", description: "Show unread count", icon: BellRing },
  { value: "hidden", label: "Hide", description: "Remove the bell", icon: BellOff },
];

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const NOTIF_HINTS = {
  hidden: "The notification bell is hidden from the top bar. Switch back any time to see it again.",
  dot: "A small dot appears on the bell when you have unread notifications.",
  badge: "The bell shows how many notifications are unread.",
};

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const { mode, toggleTheme } = useTheme();
  const { showAlert } = useAlerts();

  const [resetSending, setResetSending] = useState(false);

  const [fontSize, setFontSize] = useState(() => {
    if (typeof window === "undefined") return "medium";
    return localStorage.getItem(FONT_SIZE_STORAGE_KEY) || "medium";
  });

  const [reduceMotion, setReduceMotion] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(REDUCE_MOTION_STORAGE_KEY) === "true";
  });

  const [tableDensity, setTableDensity] = useState(readTableDensity);
  const [highContrast, setHighContrast] = useState(readHighContrast);

  // Shared with the navbar bell, so a change here applies instantly.
  const [notificationStyle, setNotificationStyle] = useNotificationStyle();

  const displayName = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email_id;
  const isSuperAdmin = user?.appRole === APP_ROLES.SUPER_ADMIN;
  const isAdmin = user?.appRole === APP_ROLES.ADMIN || isSuperAdmin;
  // View-only: sees the same cards Admin/Super Admin see, but every action
  // that mutates/opens a management surface is disabled rather than the
  // card being hidden — see the Dealer CRM Connection and User Management
  // cards below.
  const isViewUser = user?.appRole === APP_ROLES.VIEW_USER;

  const [accent, setAccent] = useAccentColor();
  const { glyph, color: avatarColor, setGlyph, setColor: setAvatarColor } = useAvatarPreference();
  const sessionStart = getSessionStart();
  const roleLabel = ROLE_LABELS[user?.appRole];

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

  const applyReduceMotion = (enabled) => {
    setReduceMotion(enabled);
    localStorage.setItem(REDUCE_MOTION_STORAGE_KEY, String(enabled));
    if (enabled) document.documentElement.setAttribute("data-reduce-motion", "true");
    else document.documentElement.removeAttribute("data-reduce-motion");
  };

  const handleTableDensityChange = (value) => {
    setTableDensity(value);
    applyTableDensity(value);
  };

  const handleHighContrastChange = (enabled) => {
    setHighContrast(enabled);
    applyHighContrast(enabled);
  };

  // Puts every preference on this page back to its default.
  const handleResetPreferences = () => {
    handleFontSizeChange("medium");
    applyReduceMotion(false);
    handleTableDensityChange("comfortable");
    handleHighContrastChange(false);
    setNotificationStyle("badge");
    resetProfilePreferences();
    if (mode === "dark") toggleTheme();
    showAlert("success", "Your preferences are back to their defaults.", { title: "Preferences reset" });
  };

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
  const locale = (typeof navigator !== "undefined" && navigator.language) || "en-AU";
  const localTime = new Date().toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="settings">
      {/* ---------- Profile ---------- */}
      <section className="settings__profile" aria-label="Account">
        <span className="settings__avatar-wrap">
          <Avatar name={displayName} size="lg" />
        </span>
        <div className="settings__profile-info">
          <div className="settings__profile-name-row">
            <h3 className="settings__profile-name">{displayName}</h3>
            {roleLabel && (
              <span className="settings__role-pill">
                <ShieldCheck size={12} strokeWidth={2.5} />
                {roleLabel}
              </span>
            )}
          </div>
          {user?.email_id && (
            <p className="settings__profile-email">
              <Mail size={13} />
              {user.email_id}
            </p>
          )}
        </div>
        <div className="settings__profile-actions">
          <button
            className="settings__button settings__button--outline"
            onClick={handlePasswordReset}
            disabled={resetSending}
          >
            <KeyRound size={14} strokeWidth={2.5} />
            {resetSending ? "Sending…" : "Reset password"}
          </button>
          <button className="settings__button settings__button--danger-outline" onClick={() => logout()}>
            <LogOut size={14} strokeWidth={2.5} />
            Log out
          </button>
        </div>
      </section>

      <div className="settings__grid">
        {/* ---------- Appearance ---------- */}
        <div className="settings__card">
          <div className="settings__card-header">
            <span className="settings__card-icon">
              <Palette size={18} />
            </span>
            <div>
              <h3>Appearance</h3>
              <p className="settings__card-desc">Theme and text size across the app.</p>
            </div>
          </div>

          <div className="settings__block">
            <p className="settings__label">Theme</p>
            <div className="settings__theme-group" role="radiogroup" aria-label="Theme">
              {THEME_OPTIONS.map(({ value, label, icon: ThemeIcon }) => {
                const active = mode === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`settings__theme-tile settings__theme-tile--${value} ${
                      active ? "settings__theme-tile--active" : ""
                    }`}
                    onClick={() => {
                      if (!active) toggleTheme();
                    }}
                  >
                    <span className="settings__theme-preview" aria-hidden="true">
                      <span className="settings__theme-preview-bar" />
                      <span className="settings__theme-preview-line" />
                      <span className="settings__theme-preview-line settings__theme-preview-line--short" />
                    </span>
                    <span className="settings__theme-label">
                      <ThemeIcon size={14} strokeWidth={2.2} />
                      {label}
                      {active && <Check size={13} strokeWidth={3} className="settings__theme-check" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="settings__block">
            <p className="settings__label">Accent color</p>
            <div className="settings__swatches" role="radiogroup" aria-label="Accent color">
              {ACCENT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={accent === c.id}
                  aria-label={c.label}
                  title={c.label}
                  className={`settings__swatch ${accent === c.id ? "settings__swatch--active" : ""}`}
                  style={{ "--swatch": c.value }}
                  onClick={() => setAccent(c.id)}
                >
                  {accent === c.id && <Check size={14} strokeWidth={3} />}
                </button>
              ))}
            </div>
            <p className="settings__hint">
              Buttons, highlights and active states use{" "}
              <strong>{ACCENT_COLORS.find((c) => c.id === accent)?.label}</strong>.
            </p>
          </div>

          <div className="settings__block">
            <p className="settings__label">Font size</p>
            <div className="settings__option-group">
              {FONT_SIZES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`settings__option ${fontSize === value ? "settings__option--active" : ""}`}
                  onClick={() => handleFontSizeChange(value)}
                  aria-pressed={fontSize === value}
                >
                  <span className={`settings__option-glyph settings__option-glyph--${value}`}>A</span>
                  {label}
                </button>
              ))}
            </div>
            <p className="settings__preview-text">
              <Type size={13} />
              The quick brown fox jumps over the lazy dog.
            </p>
          </div>

          <div className="settings__block settings__block--action">
            <div>
              <p className="settings__label">Reduce motion</p>
              <p className="settings__value-muted">Turn off animations and transitions across the app.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={reduceMotion}
              aria-label="Reduce motion"
              className={`settings__switch ${reduceMotion ? "settings__switch--on" : ""}`}
              onClick={() => applyReduceMotion(!reduceMotion)}
            >
              <span className="settings__switch-thumb" />
            </button>
          </div>
          <div className="settings__block">
            <p className="settings__label">Table density</p>
            <div className="settings__option-group">
              {TABLE_DENSITIES.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`settings__option ${tableDensity === value ? "settings__option--active" : ""}`}
                  onClick={() => handleTableDensityChange(value)}
                  aria-pressed={tableDensity === value}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="settings__hint">Compact fits more rows on screen in lead and dealer tables.</p>
          </div>

          <div className="settings__block settings__block--action">
            <div>
              <p className="settings__label">High contrast</p>
              <p className="settings__value-muted">Stronger text and borders for easier reading.</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={highContrast}
              aria-label="High contrast"
              className={`settings__switch ${highContrast ? "settings__switch--on" : ""}`}
              onClick={() => handleHighContrastChange(!highContrast)}
            >
              <span className="settings__switch-thumb" />
            </button>
          </div>
        </div>

        {/* ---------- Profile picture ---------- */}
        <div className="settings__card">
          <div className="settings__card-header">
            <span className="settings__card-icon">
              <UserCircle size={18} />
            </span>
            <div>
              <h3>Profile picture</h3>
              <p className="settings__card-desc">Pick an icon and color for your avatar.</p>
            </div>
          </div>

          <div className="settings__block">
            <div className="settings__avatar-preview">
              <Avatar name={displayName} size="lg" />
              <div>
                <p className="settings__label">{displayName}</p>
                <p className="settings__value-muted">Shown in the top bar and your profile.</p>
              </div>
            </div>
          </div>

          <div className="settings__block">
            <p className="settings__label">Icon</p>
            <div className="settings__glyph-grid" role="radiogroup" aria-label="Avatar icon">
              {AVATAR_GLYPHS.map(({ id, label, icon: GlyphIcon }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={glyph === id}
                  title={label}
                  className={`settings__glyph ${glyph === id ? "settings__glyph--active" : ""}`}
                  onClick={() => setGlyph(id)}
                >
                  {GlyphIcon ? <GlyphIcon size={18} /> : <span className="settings__glyph-text">Aa</span>}
                  <span className="settings__glyph-label">{label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="settings__block">
            <p className="settings__label">Background</p>
            <div className="settings__swatches" role="radiogroup" aria-label="Avatar color">
              {AVATAR_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={avatarColor === c.id}
                  aria-label={c.label}
                  title={c.label}
                  className={`settings__swatch ${c.value ? "" : "settings__swatch--classic"} ${
                    avatarColor === c.id ? "settings__swatch--active" : ""
                  }`}
                  style={c.value ? { "--swatch": c.value } : undefined}
                  onClick={() => setAvatarColor(c.id)}
                >
                  {avatarColor === c.id && <Check size={14} strokeWidth={3} />}
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
            <div>
              <h3>Notifications</h3>
              <p className="settings__card-desc">Choose how the bell in the top bar behaves.</p>
            </div>
          </div>

          <div className="settings__block">
            <p className="settings__label">Bell indicator</p>
            <div
              className="settings__option-group settings__option-group--notif"
              role="radiogroup"
              aria-label="Bell indicator"
            >
              {NOTIF_STYLES.map(({ value, label, description, icon: Icon }) => {
                const active = notificationStyle === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`settings__notif-option ${active ? "settings__notif-option--active" : ""}`}
                    onClick={() => setNotificationStyle(value)}
                  >
                    <span className="settings__notif-icon-wrap">
                      <Icon size={20} />
                      {value === "dot" && <span className="settings__notif-preview-dot" />}
                      {value === "badge" && <span className="settings__notif-preview-badge">3</span>}
                    </span>
                    <span className="settings__notif-option-label">{label}</span>
                    <span className="settings__notif-option-desc">{description}</span>
                  </button>
                );
              })}
            </div>
            <p className="settings__hint">{NOTIF_HINTS[notificationStyle] || NOTIF_HINTS.badge}</p>
          </div>
        </div>

        {/* ---------- This device ---------- */}
        <div className="settings__card">
          <div className="settings__card-header">
            <span className="settings__card-icon">
              <Monitor size={18} />
            </span>
            <div>
              <h3>Session &amp; device</h3>
              <p className="settings__card-desc">Your current session. Preferences are saved in this browser only.</p>
            </div>
          </div>

          <ul className="settings__facts">
            {sessionStart && (
              <>
                <li>
                  <span className="settings__fact-icon"><Timer size={14} /></span>
                  <span className="settings__fact-label">Session active for</span>
                  <SessionClock startedAt={sessionStart} />
                </li>
                <li>
                  <span className="settings__fact-icon"><Clock size={14} /></span>
                  <span className="settings__fact-label">Session started</span>
                  <span className="settings__fact-value">
                    {new Date(sessionStart).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                  </span>
                </li>
              </>
            )}
            <li>
              <span className="settings__fact-icon"><Globe size={14} /></span>
              <span className="settings__fact-label">Time zone</span>
              <span className="settings__fact-value">{timeZone}</span>
            </li>
            <li>
              <span className="settings__fact-icon"><Clock size={14} /></span>
              <span className="settings__fact-label">Local time</span>
              <span className="settings__fact-value">{localTime}</span>
            </li>
            <li>
              <span className="settings__fact-icon"><Globe size={14} /></span>
              <span className="settings__fact-label">Language</span>
              <span className="settings__fact-value">{locale}</span>
            </li>
          </ul>

          <div className="settings__block settings__block--action">
            <div>
              <p className="settings__label">Reset preferences</p>
              <p className="settings__value-muted">Restore theme, accent color, avatar, text size, motion, contrast, table density and bell indicator to defaults.</p>
            </div>
            <button type="button" className="settings__button settings__button--outline" onClick={handleResetPreferences}>
              <RotateCcw size={14} strokeWidth={2.5} />
              Reset
            </button>
          </div>
        </div>

        {/* Admin / Super Admin — full access; View User — same card and a
            working "Configure" link (the Dealer CRM Config page itself is
            view-only for this role: every mutating control there is
            disabled, see DealerCRMConfig.jsx). Role-agnostic here; the
            real security boundary is requireAdminRole/requireAdminOrViewRole
            on the backend and the RequireRole wrapper on the route itself. */}
        {(isAdmin || isViewUser) && (
          <div className="settings__card">
            <div className="settings__card-header">
              <span className="settings__card-icon">
                <Plug size={18} />
              </span>
              <div>
                <h3>Dealer CRM Connection</h3>
                <p className="settings__card-desc">Integrations and mappings per dealer.</p>
              </div>
            </div>

            <div className="settings__block settings__block--action">
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

        {/* Super Admin — full access via a working link. View User — the
            card stays visible (per spec: show the UI, do not hide it) but
            "Manage users" is a disabled button instead of a Link, so it
            neither navigates nor reaches /user-management — that route is
            still SUPER_ADMIN-only via RequireRole/requireSuperAdminRole
            regardless, this just keeps the disabled control from looking
            or behaving like it works. */}
        {(isSuperAdmin || isViewUser) && (
          <div className="settings__card">
            <div className="settings__card-header">
              <span className="settings__card-icon">
                <Users size={18} />
              </span>
              <div>
                <h3>User Management</h3>
                <p className="settings__card-desc">Control who can access the portal.</p>
              </div>
            </div>

            <div className="settings__block settings__block--action">
              <div>
                <p className="settings__label">Dealer access</p>
                <p className="settings__value-muted">Invite, resend, or remove Admin-role users.</p>
              </div>
              {isViewUser ? (
                <button
                  type="button"
                  className="settings__button settings__button--primary"
                  disabled
                  title="View-only access"
                >
                  Manage users
                  <ChevronRight size={14} strokeWidth={2.5} />
                </button>
              ) : (
                <Link to={ROUTES.USER_MANAGEMENT} className="settings__button settings__button--primary">
                  Manage users
                  <ChevronRight size={14} strokeWidth={2.5} />
                </Link>
              )}
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
