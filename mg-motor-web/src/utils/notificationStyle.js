import { useEffect, useState } from "react";

/**
 * How the top-navbar notification bell is displayed — chosen on the
 * Settings page, read by NotificationBell.
 *   "badge"  -> unread count on the bell (default)
 *   "dot"    -> a small dot when anything is unread, no number
 *   "hidden" -> bell removed from the navbar entirely
 *
 * Stored in localStorage (same key Settings has always used) and
 * broadcast through a window event so the navbar updates instantly,
 * in the same tab, without a reload.
 */
export const NOTIF_STYLE_STORAGE_KEY = "settings:notificationStyle";
export const NOTIF_STYLE_EVENT = "settings:notificationStyle:change";
export const NOTIF_STYLES_VALUES = ["badge", "dot", "hidden"];

export function readNotificationStyle() {
  try {
    const stored = localStorage.getItem(NOTIF_STYLE_STORAGE_KEY);
    return NOTIF_STYLES_VALUES.includes(stored) ? stored : "badge";
  } catch {
    return "badge";
  }
}

export function writeNotificationStyle(value) {
  try {
    localStorage.setItem(NOTIF_STYLE_STORAGE_KEY, value);
  } catch {
    // Storage unavailable (private mode etc.) — the event below still
    // updates the current session.
  }
  window.dispatchEvent(new CustomEvent(NOTIF_STYLE_EVENT, { detail: value }));
}

export function useNotificationStyle() {
  const [style, setStyle] = useState(readNotificationStyle);

  useEffect(() => {
    const sync = () => setStyle(readNotificationStyle());
    window.addEventListener(NOTIF_STYLE_EVENT, sync);
    window.addEventListener("storage", sync); // changes from another tab
    return () => {
      window.removeEventListener(NOTIF_STYLE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return [style, writeNotificationStyle];
}
