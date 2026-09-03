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

  const validateSession = useCallback(async () => {
    try {
      const profile = await authService.getCurrentSession();
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

  const logout = useCallback(
    (redirectUrl = "/login") => {
      authService.signOut(redirectUrl);
      setUser(null);
      setStatus(SESSION_STATUS.UNAUTHENTICATED);
      wasAuthenticated.current = false;
    },
    []
  );

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