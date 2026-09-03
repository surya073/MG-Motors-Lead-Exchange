import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { ROUTES } from "../constants/routes.constants";

/**
 * RequireRole.jsx
 * -----------------------------------------------------------------------
 * Route-level enforcement of role access â€” separate from Sidebar's menu
 * filtering. Sidebar hiding a link is a UX nicety only; this is the
 * actual security boundary that stops a Dealer from reaching /dealers
 * by typing the URL directly.
 *
 * Sits INSIDE ProtectedRoute (so status is already AUTHENTICATED by the
 * time this runs) â€” never used standalone.
 */
export default function RequireRole({ allowedRoles }) {
  const { user } = useAuth();

  if (!allowedRoles.includes(user?.appRole)) {
    return <Navigate to={ROUTES.DASHBOARD} replace />;
  }

  return <Outlet />;
}
