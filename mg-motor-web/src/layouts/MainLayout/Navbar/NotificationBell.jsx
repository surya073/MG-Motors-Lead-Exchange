import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Trash2 } from "lucide-react";
import IconButton from "../../../ui/IconButton/IconButton";
import { BellIcon } from "../../../ui/icons";
import { notificationService } from "../../../services/api/notificationService";
import "./NotificationBell.css";

const TYPE_LABELS = {
  LEAD_ASSIGNED: "New lead",
  LEAD_STATUS_UPDATED: "Lead updated",
  SYNC_SUMMARY: "Sync",
};

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
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef(null);

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
  // takes an action (mark read / delete / mark all read).
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
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) fetchNotifications();
      return next;
    });
  };

  const isUnread = (notification) => notification.is_read !== true;

  const handleMarkRead = async (notification, e) => {
    e.stopPropagation();
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

  return (
    <div className="notification-bell" ref={containerRef}>
      <div className="notification-bell__anchor">
        <IconButton icon={BellIcon} label="Notifications" active={open} onClick={handleToggle} />
        {unreadCount > 0 && (
          <span className="notification-bell__badge" aria-hidden="true">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </div>
      {open && (
        <div className="notification-bell__panel">
          <div className="notification-bell__header">
            Notifications
            {unreadCount > 0 && (
              <button type="button" className="notification-bell__mark-all" onClick={handleMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>

          {loading && notifications.length === 0 ? (
            <div className="notification-bell__empty">Loading…</div>
          ) : notifications.length === 0 ? (
            <div className="notification-bell__empty">
              <span className="notification-bell__empty-icon">
                <BellIcon size={18} />
              </span>
              You're all caught up — nothing new right now.
            </div>
          ) : (
            <ul className="notification-bell__list">
              {notifications.map((n) => {
                const unread = isUnread(n);
                return (
                  <li key={n.ROWID} className={`notification-bell__item ${unread ? "notification-bell__item--unread" : ""}`}>
                    <div className="notification-bell__item-main">
                      <span className="notification-bell__item-type">{TYPE_LABELS[n.type] || n.type}</span>
                      <span className="notification-bell__item-title">{n.title}</span>
                      <span className="notification-bell__item-message">{n.message}</span>
                      <span className="notification-bell__item-time">{timeAgo(n.CREATEDTIME || n.created_time)}</span>
                    </div>

                    <div className="notification-bell__item-actions">
                      {unread && (
                        <button
                          type="button"
                          className="notification-bell__item-action"
                          onClick={(e) => handleMarkRead(n, e)}
                          aria-label="Mark as read"
                          title="Mark as read"
                        >
                          <Check size={14} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="notification-bell__item-action notification-bell__item-action--delete"
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
      )}
    </div>
  );
}