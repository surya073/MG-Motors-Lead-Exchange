import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { SESSION_STATUS } from "../constants/app.constants";
import { ROUTES } from "../constants/routes.constants";
import LoadingPage from "../common/LoadingPage/LoadingPage";

/**
 * ProtectedRoute.jsx
 * -----------------------------------------------------------------------
 * Guards every route nested under it in AppRoutes.jsx. Three states:
 *
 *   UNKNOWN         â€” session check still in flight â†’ show LoadingPage
 *   UNAUTHENTICATED
 *   / EXPIRED       â€” no valid session â†’ redirect to /login, remembering
 *                     where they were headed so login can send them back
 *   AUTHENTICATED   â€” render the protected route tree
 */
export default function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();
  console.log('[AUTH-DEBUG]', new Date().toISOString(), 'ProtectedRoute status:', status);


  if (status === SESSION_STATUS.UNKNOWN) {
    return <LoadingPage label="Checking session" />;
  }

  if (status === SESSION_STATUS.UNAUTHENTICATED || status === SESSION_STATUS.EXPIRED) {
    return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;
  }

  return <Outlet />;
}

