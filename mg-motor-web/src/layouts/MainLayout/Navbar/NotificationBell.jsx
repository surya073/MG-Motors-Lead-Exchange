import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  BellOff,
  Check,
  CheckCheck,
  CheckCircle2,
  Pencil,
  RefreshCw,
  Trash2,
  UserPlus,
} from "lucide-react";
import IconButton from "../../../ui/IconButton/IconButton";
import { BellIcon } from "../../../ui/icons";
import { useAuth } from "../../../contexts/AuthContext";
import { useAlerts, getErrorMessage } from "../../../ui/Alerts/Alerts";
import { APP_ROLES } from "../../../constants/auth.constants";
import { ROUTES } from "../../../constants/routes.constants";
import { notificationService } from "../../../services/api/notificationService";
import { CompactListSkeleton } from "../../../ui/Skeleton/PageSkeletons";
import { useNotificationStyle } from "../../../utils/notificationStyle";
import "./NotificationBell.css";

const MAX_BADGE = 99;
const CONFIRM_CLEAR_MS = 4000;

/* ---------- how each notification type looks ---------- */

const TYPE_META = {
  LEAD_ASSIGNED: { label: "New lead", tone: "success", Icon: UserPlus },
  LEAD_STATUS_UPDATED: { label: "Status update", tone: "info", Icon: ArrowRightLeft },
  LEAD_FIELDS_UPDATED: { label: "Lead updated", tone: "violet", Icon: Pencil },
  SYNC_SUMMARY: { label: "Sync", tone: "neutral", Icon: RefreshCw },
};

function typeMeta(type) {
  if (TYPE_META[type]) return TYPE_META[type];
  // Integration scenarios arrive as HAPPY_n / UNHAPPY_n.
  const scenario = /^(HAPPY|UNHAPPY)_(\d+)$/.exec(type || "");
  if (scenario) {
    const happy = scenario[1] === "HAPPY";
    return {
      label: `${happy ? "Happy" : "Unhappy"} ${scenario[2]}`,
      tone: happy ? "success" : "danger",
      Icon: happy ? CheckCircle2 : AlertTriangle,
    };
  }
  return { label: (type || "Update").replace(/_/g, " ").toLowerCase(), tone: "neutral", Icon: BellIcon };
}

/* ---------- where clicking a notification goes ---------- */

function getTarget(notification, role) {
  const type = notification.type || "";
  const leadId = notification.related_lead_id;

  if (type === "SYNC_SUMMARY") return role === APP_ROLES.DEALER ? ROUTES.MY_LEADS : ROUTES.LOGS;

  if (role === APP_ROLES.DEALER) {
    // My Leads has no per-lead page, so open it filtered to the customer
    // named at the start of the message ("Rahul Sharma — MG Hector").
    const firstLine = String(notification.message || "").split("\n")[0];
    const customer = firstLine.split(" — ")[0].trim();
    return customer && !firstLine.includes("→")
      ? `${ROUTES.MY_LEADS}?search=${encodeURIComponent(customer)}`
      : ROUTES.MY_LEADS;
  }

  if (leadId) return `${ROUTES.LEAD_EXCHANGE}/${encodeURIComponent(leadId)}`;
  if (/^(HAPPY|UNHAPPY)_/.test(type)) return ROUTES.INTEGRATIONS;
  return ROUTES.LEAD_EXCHANGE;
}

/* ---------- message body: "Label: from → to" lines become change rows ---------- */

const CHANGE_LINE = /^(.+?):\s(.*)\s→\s(.*)$/;

function MessageBody({ message }) {
  const lines = String(message || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  return (
    <div className="nb-item__body">
      {lines.map((line, i) => {
        const change = CHANGE_LINE.exec(line);
        if (!change) {
          return (
            <p className="nb-item__text" key={i}>
              {line}
            </p>
          );
        }
        const [, label, from, to] = change;
        return (
          <div className="nb-change" key={i}>
            <span className="nb-change__label">{label}</span>
            <span className="nb-change__from">{from}</span>
            <ArrowRight size={12} className="nb-change__arrow" aria-hidden="true" />
            <span className="nb-change__to">{to}</span>
          </div>
        );
      })}
    </div>
  );
}

function timeAgo(catalystDateTime) {
  if (!catalystDateTime) return "";
  const then = new Date(catalystDateTime);
  if (isNaN(then.getTime())) return "";
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function NotificationBell() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { error: showError } = useAlerts();
  const role = user?.appRole;

  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("all"); // "all" | "unread"
  const [confirmClear, setConfirmClear] = useState(false);
  const containerRef = useRef(null);
  const [notificationStyle] = useNotificationStyle();

  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true);
      const result = await notificationService.list();
      setNotifications(result.notifications || []);
      setUnreadCount(result.unreadCount || 0);
    } catch {
      // Silent — a failed fetch shouldn't interrupt the rest of the app.
    } finally {
      setLoading(false);
    }
  }, []);

  // One fetch on mount only. No interval — API calls are rate-limited.
  // Every other refresh happens only when the user opens the panel or
  // takes an action (mark read / delete / mark all read / clear all).
  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    if (!open) return undefined;
    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleEscape = (event) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  // The "Clear all?" confirmation expires on its own.
  useEffect(() => {
    if (!confirmClear) return undefined;
    const timer = setTimeout(() => setConfirmClear(false), CONFIRM_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [confirmClear]);

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) fetchNotifications();
      else setConfirmClear(false);
      return next;
    });
  };

  const isUnread = (notification) => notification.is_read !== true;

  const handleMarkRead = async (notification, e) => {
    e?.stopPropagation();
    if (!isUnread(notification)) return;
    setNotifications((prev) =>
      prev.map((n) => (n.ROWID === notification.ROWID ? { ...n, is_read: true } : n))
    );
    setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      await notificationService.markRead(notification.ROWID);
    } catch {
      fetchNotifications();
    }
  };

  const handleDelete = async (notification, e) => {
    e.stopPropagation();
    const wasUnread = isUnread(notification);
    setNotifications((prev) => prev.filter((n) => n.ROWID !== notification.ROWID));
    if (wasUnread) setUnreadCount((prev) => Math.max(0, prev - 1));
    try {
      await notificationService.remove(notification.ROWID);
    } catch {
      fetchNotifications(); // resync on failure — the row may still exist
    }
  };

  const handleMarkAllRead = async () => {
    if (unreadCount === 0) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
    try {
      await notificationService.markAllRead();
    } catch {
      fetchNotifications();
    }
  };

  const handleClearAll = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    const previous = { notifications, unreadCount };
    setConfirmClear(false);
    setNotifications([]);
    setUnreadCount(0);
    try {
      await notificationService.clearAll();
    } catch (err) {
      setNotifications(previous.notifications);
      setUnreadCount(previous.unreadCount);
      showError(getErrorMessage(err, "Couldn't clear your notifications. Try again."), {
        title: "Clear failed",
      });
    }
  };

  // Click = mark read + go to the thing it is about.
  const handleOpenItem = (notification) => {
    handleMarkRead(notification);
    setOpen(false);
    navigate(getTarget(notification, role));
  };

  const visible = useMemo(
    () => (tab === "unread" ? notifications.filter((n) => n.is_read !== true) : notifications),
    [notifications, tab]
  );

  // Settings → Notifications → "Hide": remove the bell from the navbar.
  if (notificationStyle === "hidden") return null;

  const badgeText = unreadCount > MAX_BADGE ? `${MAX_BADGE}+` : String(unreadCount);

  return (
    <div className="notification-bell" ref={containerRef}>
      <div className="notification-bell__anchor">
        <IconButton
          icon={BellIcon}
          label="Notifications"
          active={open}
          onClick={handleToggle}
          className="notification-bell__btn"
          aria-expanded={open}
          aria-haspopup="dialog"
        />
        {unreadCount > 0 && notificationStyle === "dot" && (
          <span className="notification-bell__dot" aria-hidden="true" />
        )}
        {unreadCount > 0 && notificationStyle !== "dot" && (
          <span className="notification-bell__badge" aria-hidden="true">
            {badgeText}
          </span>
        )}
      </div>

      {open && (
        <div className="notification-bell__panel" role="dialog" aria-label="Notifications">
          <div className="nb-header">
            <div className="nb-header__title">
              <h3>Notifications</h3>
              {unreadCount > 0 && <span className="nb-header__count">{unreadCount > MAX_BADGE ? `${MAX_BADGE}+` : unreadCount} new</span>}
            </div>

            {notifications.length > 0 && (
              <div className="nb-header__actions">
                {unreadCount > 0 && (
                  <button type="button" className="nb-link" onClick={handleMarkAllRead}>
                    <CheckCheck size={13} />
                    Mark all read
                  </button>
                )}
                <button
                  type="button"
                  className={`nb-link nb-link--danger${confirmClear ? " nb-link--confirm" : ""}`}
                  onClick={handleClearAll}
                >
                  <Trash2 size={13} />
                  {confirmClear ? "Click to confirm" : "Clear all"}
                </button>
              </div>
            )}
          </div>

          {notifications.length > 0 && (
            <div className="nb-tabs" role="tablist" aria-label="Filter notifications">
              {[
                { key: "all", label: "All", count: notifications.length },
                { key: "unread", label: "Unread", count: unreadCount },
              ].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  className={`nb-tab${tab === t.key ? " nb-tab--active" : ""}`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                  <span className="nb-tab__count">{t.count > MAX_BADGE ? `${MAX_BADGE}+` : t.count}</span>
                </button>
              ))}
            </div>
          )}

          <div className="nb-scroll">
            {loading && notifications.length === 0 ? (
              <CompactListSkeleton rows={3} />
            ) : visible.length === 0 ? (
              <div className="nb-empty">
                <span className="nb-empty__icon">
                  {tab === "unread" && notifications.length > 0 ? <CheckCheck size={20} /> : <BellOff size={20} />}
                </span>
                <p className="nb-empty__title">
                  {tab === "unread" && notifications.length > 0 ? "No unread notifications" : "You're all caught up"}
                </p>
                <p className="nb-empty__hint">
                  {tab === "unread" && notifications.length > 0
                    ? "Everything has been read."
                    : "Dealer updates and sync results will appear here."}
                </p>
              </div>
            ) : (
              <ul className="nb-list">
                {visible.map((n) => {
                  const unread = isUnread(n);
                  const meta = typeMeta(n.type);
                  const Icon = meta.Icon;
                  return (
                    <li key={n.ROWID} className={`nb-item nb-item--${meta.tone}${unread ? " nb-item--unread" : ""}`}>
                      <button type="button" className="nb-item__main" onClick={() => handleOpenItem(n)}>
                        <span className="nb-item__icon" aria-hidden="true">
                          <Icon size={16} />
                        </span>

                        <span className="nb-item__content">
                          <span className="nb-item__top">
                            <span className="nb-item__type">{meta.label}</span>
                            <span className="nb-item__time">{timeAgo(n.CREATEDTIME || n.created_time)}</span>
                          </span>
                          <span className="nb-item__title">{n.title}</span>
                          <MessageBody message={n.message} />
                          {n.related_dealer_code && (
                            <span className="nb-item__dealer">{n.related_dealer_code}</span>
                          )}
                        </span>

                        {unread && <span className="nb-item__dot" aria-label="Unread" />}
                      </button>

                      <div className="nb-item__actions">
                        {unread && (
                          <button
                            type="button"
                            className="nb-icon-btn"
                            onClick={(e) => handleMarkRead(n, e)}
                            aria-label="Mark as read"
                            title="Mark as read"
                          >
                            <Check size={14} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="nb-icon-btn nb-icon-btn--danger"
                          onClick={(e) => handleDelete(n, e)}
                          aria-label="Delete notification"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
