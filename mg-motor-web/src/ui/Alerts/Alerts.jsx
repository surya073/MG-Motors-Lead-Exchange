/**
 * Alerts.jsx
 * -----------------------------------------------------------------------
 * Reusable, global toast/alert system.
 *
 * Usage:
 *   1. Wrap your app once:
 *        <AlertProvider>
 *          <App />
 *        </AlertProvider>
 *
 *   2. Fire alerts from anywhere:
 *        const { showAlert } = useAlerts();
 *        showAlert("success", "Lead updated successfully");
 *        showAlert("error", "Something went wrong");
 *        showAlert("warning", "Finance approval pending");
 *        showAlert("info", "Lead reassigned to MG Ballarat");
 * -----------------------------------------------------------------------
 */

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { CheckCircleIcon, AlertCircleIcon, InfoCircleIcon, XIcon } from "../icons";
import "./Alerts.css";

const AlertsContext = createContext(null);

const VARIANT_ICONS = {
  success: CheckCircleIcon,
  error: AlertCircleIcon,
  warning: AlertCircleIcon,
  info: InfoCircleIcon,
};

const DEFAULT_DURATION = 4000;

export function AlertProvider({ children }) {
  const [alerts, setAlerts] = useState([]);
  const timers = useRef({});

  const dismissAlert = useCallback((id) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  const showAlert = useCallback(
    (variant, message, options = {}) => {
      const id = options.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const duration = options.duration ?? DEFAULT_DURATION;

      setAlerts((prev) => [...prev, { id, variant, message, title: options.title }]);

      if (duration !== 0) {
        timers.current[id] = setTimeout(() => dismissAlert(id), duration);
      }

      return id;
    },
    [dismissAlert]
  );

  return (
    <AlertsContext.Provider value={{ showAlert, dismissAlert }}>
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
  const Icon = VARIANT_ICONS[alert.variant] || InfoCircleIcon;

  return (
    <div className={`alert-toast alert-toast--${alert.variant}`} role="alert">
      <span className="alert-toast__icon">
        <Icon size={18} />
      </span>

      <div className="alert-toast__body">
        {alert.title && <span className="alert-toast__title">{alert.title}</span>}
        <span className="alert-toast__message">{alert.message}</span>
      </div>

      <button
        type="button"
        className="alert-toast__close"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}

/**
 * Standalone inline alert (banner), for when you want to show a persistent
 * message inside a form/page rather than a floating toast.
 *
 *   <Alert variant="error">Please fill in all required fields.</Alert>
 */
export function Alert({ variant = "info", title, children, onClose }) {
  const Icon = VARIANT_ICONS[variant] || InfoCircleIcon;

  return (
    <div className={`alert-banner alert-banner--${variant}`} role="alert">
      <span className="alert-banner__icon">
        <Icon size={18} />
      </span>

      <div className="alert-banner__body">
        {title && <span className="alert-banner__title">{title}</span>}
        <span className="alert-banner__message">{children}</span>
      </div>

      {onClose && (
        <button
          type="button"
          className="alert-banner__close"
          onClick={onClose}
          aria-label="Dismiss"
        >
          <XIcon size={14} />
        </button>
      )}
    </div>
  );
}