/**
 * Alerts.jsx
 * -----------------------------------------------------------------------
 * The one place the app tells the user something happened: floating toasts
 * for events ("Lead updated", "Couldn't load dealers") and an inline banner
 * for messages that belong to a page or form.
 *
 * Setup (already done in App.jsx):
 *     <AlertProvider> <App /> </AlertProvider>
 *
 * Toasts, from anywhere:
 *     const { showAlert, success, error, warning, info } = useAlerts();
 *     success("Lead updated");
 *     error("Couldn't save changes", { title: "Save failed" });
 *     showAlert("warning", "Finance approval pending", { duration: 8000 });
 *     error("Couldn't load leads", {
 *       action: { label: "Retry", onClick: loadLeads },
 *     });
 *
 *   options: title, duration (ms, 0 = stays until dismissed), id, action
 *
 * Inline banner (persistent, sits in the page):
 *     <Alert variant="error" title="Load failed" onClose={...}>message</Alert>
 *
 * Turning an API failure into readable text:
 *     error(getErrorMessage(err, "Couldn't load dealers."));
 *
 * Colours come from the design tokens only, so every variant follows the
 * light / dark theme without any extra work.
 * -----------------------------------------------------------------------
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from "lucide-react";
import "./Alerts.css";

const AlertsContext = createContext(null);

const VARIANT_ICONS = {
  success: CheckCircle2,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

// Errors and warnings stay a little longer so they can actually be read.
const DEFAULT_DURATIONS = { success: 4000, info: 4500, warning: 6000, error: 6500 };
const MAX_VISIBLE = 4;
const EXIT_MS = 200;
const DUPLICATE_WINDOW_MS = 1500;

/**
 * Turns whatever an API call threw into one readable sentence, preferring
 * the server's own message, then a friendly network message, then `fallback`.
 */
export function getErrorMessage(err, fallback = "Something went wrong. Please try again.") {
  const fromServer = err?.response?.data?.error || err?.response?.data?.message;
  if (typeof fromServer === "string" && fromServer.trim()) return fromServer;

  const message = typeof err?.message === "string" ? err.message.trim() : "";
  if (/network error|failed to fetch/i.test(message)) {
    return "Can't reach the server. Check your connection and try again.";
  }
  if (message && !/^request failed with status code/i.test(message)) return message;
  return fallback;
}

export function AlertProvider({ children }) {
  const [alerts, setAlerts] = useState([]);
  const recent = useRef(new Map()); // "variant|message" -> { id, at }

  const removeAlert = useCallback((id) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  // Marks the toast as leaving so it can animate out, then removes it.
  const dismissAlert = useCallback(
    (id) => {
      setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, leaving: true } : a)));
      setTimeout(() => removeAlert(id), EXIT_MS);
    },
    [removeAlert]
  );

  const showAlert = useCallback((variant, message, options = {}) => {
    const key = `${variant}|${options.title || ""}|${message}`;
    const now = Date.now();
    const previous = recent.current.get(key);
    // The same message firing repeatedly (e.g. a retry loop) shows once.
    if (previous && now - previous.at < DUPLICATE_WINDOW_MS) return previous.id;

    const id = options.id || `${now}-${Math.random().toString(36).slice(2, 8)}`;
    recent.current.set(key, { id, at: now });

    const duration = options.duration ?? DEFAULT_DURATIONS[variant] ?? 4000;
    setAlerts((prev) =>
      [...prev, { id, variant, message, title: options.title, action: options.action, duration }].slice(-MAX_VISIBLE)
    );
    return id;
  }, []);

  const value = useMemo(
    () => ({
      showAlert,
      dismissAlert,
      success: (message, options) => showAlert("success", message, options),
      error: (message, options) => showAlert("error", message, options),
      warning: (message, options) => showAlert("warning", message, options),
      info: (message, options) => showAlert("info", message, options),
    }),
    [showAlert, dismissAlert]
  );

  return (
    <AlertsContext.Provider value={value}>
      {children}
      <AlertStack alerts={alerts} onDismiss={dismissAlert} />
    </AlertsContext.Provider>
  );
}

export function useAlerts() {
  const ctx = useContext(AlertsContext);
  if (!ctx) {
    throw new Error("useAlerts must be used inside an <AlertProvider>");
  }
  return ctx;
}

function AlertStack({ alerts, onDismiss }) {
  if (!alerts.length) return null;

  return (
    <div className="alert-stack" role="region" aria-live="polite" aria-label="Notifications">
      {alerts.map((alert) => (
        <AlertToast key={alert.id} alert={alert} onDismiss={() => onDismiss(alert.id)} />
      ))}
    </div>
  );
}

function AlertToast({ alert, onDismiss }) {
  const Icon = VARIANT_ICONS[alert.variant] || Info;
  const { duration, action } = alert;
  const sticky = duration === 0;

  // Auto-dismiss that pauses while the pointer or keyboard focus is on the toast.
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration);
  const startedAt = useRef(0);

  useEffect(() => {
    if (sticky || paused || alert.leaving) return undefined;
    startedAt.current = Date.now();
    const timer = setTimeout(onDismiss, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(400, remaining.current - (Date.now() - startedAt.current));
    };
    // onDismiss changes identity every render; the timer must only depend on pause state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, sticky, alert.leaving]);

  const urgent = alert.variant === "error" || alert.variant === "warning";

  return (
    <div
      className={`alert-toast alert-toast--${alert.variant}${alert.leaving ? " alert-toast--leaving" : ""}`}
      role={urgent ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="alert-toast__icon" aria-hidden="true">
        <Icon size={18} strokeWidth={2.4} />
      </span>

      <div className="alert-toast__body">
        {alert.title && <span className="alert-toast__title">{alert.title}</span>}
        <span className="alert-toast__message">{alert.message}</span>
        {action && (
          <button
            type="button"
            className="alert-toast__action"
            onClick={() => {
              action.onClick?.();
              onDismiss();
            }}
          >
            {action.label}
          </button>
        )}
      </div>

      <button type="button" className="alert-toast__close" onClick={onDismiss} aria-label="Dismiss notification">
        <X size={14} />
      </button>

      {!sticky && (
        <span
          className="alert-toast__progress"
          style={{ animationDuration: `${duration}ms`, animationPlayState: paused ? "paused" : "running" }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/**
 * Inline alert (banner), for a persistent message inside a page or form
 * rather than a floating toast.
 *
 *   <Alert variant="error" onClose={() => setError(null)}>Couldn't load leads.</Alert>
 *   <Alert variant="warning" title="Heads up" action={{ label: "Retry", onClick: reload }}>...</Alert>
 */
export function Alert({ variant = "info", title, children, onClose, action, className = "" }) {
  const Icon = VARIANT_ICONS[variant] || Info;
  const urgent = variant === "error" || variant === "warning";

  return (
    <div className={`alert-banner alert-banner--${variant} ${className}`} role={urgent ? "alert" : "status"}>
      <span className="alert-banner__icon" aria-hidden="true">
        <Icon size={18} strokeWidth={2.3} />
      </span>

      <div className="alert-banner__body">
        {title && <span className="alert-banner__title">{title}</span>}
        <span className="alert-banner__message">{children}</span>
      </div>

      {action && (
        <button type="button" className="alert-banner__action" onClick={action.onClick}>
          {action.label}
        </button>
      )}

      {onClose && (
        <button type="button" className="alert-banner__close" onClick={onClose} aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  );
}
