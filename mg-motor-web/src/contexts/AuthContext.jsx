import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { authService } from "../services/api/authService";
import { onAuthEvent, AUTH_EVENTS } from "../services/api/authEvents";
import { SESSION_STATUS } from "../constants/app.constants";
import {
  SESSION_REVALIDATE_INTERVAL_MS,
  APP_ROLES,
  CATALYST_ROLE_ID_MAP,
  CATALYST_ROLE_NAME_MAP,
} from "../constants/auth.constants";
import { ROUTES, APP_BASE_PATH } from "../constants/routes.constants";
import { useAlerts } from "../ui/Alerts/Alerts";

/**
 * AuthContext.jsx
 * -----------------------------------------------------------------------
 * Single source of truth for "is anyone logged in, who, and what role".
 *
 * normalizeRole() is the ONLY place that reads Catalyst's raw role_id /
 * role_name off the profile object. If Catalyst's response shape turns
 * out to differ from what's assumed here (verify via one console.log of
 * authService.getCurrentSession() output), fix it in this one function.
 *
 * dealerCode is NOT part of Catalyst's auth profile — Catalyst has no
 * concept of it. It's resolved via a separate backend lookup
 * (authService.getDealerContext, stubbed below) that maps the logged-in
 * user to a Dealer_Code. Until that backend endpoint exists, dealerCode
 * stays null and any Dealer-only view should treat null as "not yet
 * resolved / show nothing" rather than "show everything."
 */

const AuthContext = createContext(undefined);

// Logout: how many times to send sign-out if the session is still valid
// afterwards, and how long to wait for each confirmation.
const SIGN_OUT_ATTEMPTS = 3;
const SIGN_OUT_CONFIRM_TIMEOUT_MS = 3000;

function normalizeRole(profile) {
  if (!profile) return APP_ROLES.UNKNOWN;

  const roleId = profile?.role_details?.role_id ?? profile?.roleId ?? null;
  const roleName = profile?.role_details?.role_name ?? profile?.roleName ?? null;

  if (roleId && CATALYST_ROLE_ID_MAP[roleId]) {
    return CATALYST_ROLE_ID_MAP[roleId];
  }
  if (roleName && CATALYST_ROLE_NAME_MAP[roleName]) {
    return CATALYST_ROLE_NAME_MAP[roleName];
  }
  return APP_ROLES.UNKNOWN;
}

export function AuthProvider({ children }) {
  const [status, setStatus] = useState(SESSION_STATUS.UNKNOWN);
  const [user, setUser] = useState(null);
  const revalidateTimer = useRef(null);
  const { showAlert } = useAlerts();

  // Avoid spamming a toast every SESSION_REVALIDATE_INTERVAL_MS tick if the
  // backend stays down — only alert on the transition into a failure state.
  const wasAuthenticated = useRef(false);

  // Set the instant logout() is called. Any validateSession() call that
  // was already in flight (e.g. an interval tick that fired a moment
  // before the click, or one queued right after) checks this before
  // acting on its result — otherwise a still-valid-on-Catalyst's-end
  // session can silently re-authenticate the user right after logout.
  const isLoggingOut = useRef(false);

  const validateSession = useCallback(async () => {
    if (isLoggingOut.current) return;
    try {
      const profile = await authService.getCurrentSession();
      if (isLoggingOut.current) return; // logout started while this was in flight
      console.log('[AUTH-DEBUG]', new Date().toISOString(), 'profile:', profile);

      if (profile) {
        const appRole = normalizeRole(profile);

        let dealerCode = null;
        if (appRole === APP_ROLES.DEALER) {
          try {
            // TODO: backend endpoint not built yet — see Dealer Sync follow-up.
            dealerCode = await authService.getDealerContext(profile);
          } catch {
            dealerCode = null;
          }
        }
        console.log('[DEBUG] resolved user:', { appRole, dealerCode, profile });

        setUser({ ...profile, appRole, dealerCode });
        setStatus(SESSION_STATUS.AUTHENTICATED);
        wasAuthenticated.current = true;
      } else {
        if (wasAuthenticated.current) {
          showAlert("info", "You've been signed out.", { title: "Session ended" });
        }
        setUser(null);
        setStatus(SESSION_STATUS.UNAUTHENTICATED);
        wasAuthenticated.current = false;
      }
    } catch (err) {
      if (isLoggingOut.current) return;
      console.log('[AUTH-DEBUG]', new Date().toISOString(), 'validateSession threw:', err);
      if (wasAuthenticated.current) {
        showAlert("error", "We couldn't verify your session. Please log in again.", {
          title: "Session check failed",
        });
      }
      setUser(null);
      setStatus(SESSION_STATUS.UNAUTHENTICATED);
      wasAuthenticated.current = false;
    }
  }, [showAlert]);

  useEffect(() => {
    validateSession();
  }, [validateSession]);

  useEffect(() => {
    revalidateTimer.current = setInterval(validateSession, SESSION_REVALIDATE_INTERVAL_MS);
    return () => clearInterval(revalidateTimer.current);
  }, [validateSession]);

  useEffect(() => {
    return onAuthEvent(AUTH_EVENTS.SESSION_EXPIRED, () => {
      showAlert("warning", "Your session has expired. Please log in again.", {
        title: "Session expired",
      });
      setUser(null);
      setStatus(SESSION_STATUS.EXPIRED);
      wasAuthenticated.current = false;
    });
  }, [showAlert]);

  const logout = useCallback(async (targetPath = ROUTES.LOGIN) => {
    // Ignore repeat clicks while a sign-out is already running.
    if (isLoggingOut.current) return;
    isLoggingOut.current = true;

    // Stop background revalidation immediately, so a stale "still
    // authenticated" response can never silently undo the logout.
    if (revalidateTimer.current) {
      clearInterval(revalidateTimer.current);
      revalidateTimer.current = null;
    }
    wasAuthenticated.current = false;

    // Park on the neutral "checking session" screen instead of flipping to
    // UNAUTHENTICATED right away. Flipping early routed to /login at once,
    // which mounted Catalyst's embedded sign-in widget while the old
    // session was still alive — the widget then never rendered its form
    // (first click only), and a refresh found the session still valid and
    // went straight back into the app. Nothing mounts the widget until the
    // session is really gone.
    setStatus(SESSION_STATUS.UNKNOWN);

    // Same fully-qualified hash-route shape LoginPage uses for sign-in's
    // service_url. A bare "/login" misses the HashRouter entirely and
    // can fall back to the app's default route on some static hosts.
    const redirectUrl = `${window.location.origin}${APP_BASE_PATH}/#${targetPath}`;

    try {
      // signOut() gives no completion signal, so confirm by polling the
      // session; if it is still valid after a few seconds the first request
      // was lost, so send it again.
      for (let attempt = 0; attempt < SIGN_OUT_ATTEMPTS; attempt += 1) {
        await authService.signOut(redirectUrl);
        const signedOut = await authService.waitForSignedOut({ timeoutMs: SIGN_OUT_CONFIRM_TIMEOUT_MS });
        if (signedOut) break;
      }
    } catch (err) {
      console.error("Sign-out request failed", err);
    }

    setUser(null);
    setStatus(SESSION_STATUS.UNAUTHENTICATED);

    // A real reload guarantees the SDK and the sign-in widget start from a
    // clean state. The SDK's own redirect only changes the hash (a
    // same-document navigation), so it cannot be relied on to do this.
    window.location.href = redirectUrl;
    window.location.reload();
  }, []);

  const value = {
    status,
    user,
    isAuthenticated: status === SESSION_STATUS.AUTHENTICATED,
    revalidate: validateSession,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}