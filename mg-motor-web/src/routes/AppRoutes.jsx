import { createHashRouter, Navigate, RouterProvider } from "react-router-dom";
import MainLayout from "../layouts/MainLayout/MainLayout";
import AuthLayout from "../layouts/AuthLayout/AuthLayout";
import ProtectedRoute from "./ProtectedRoute";
import RequireRole from "./RequireRole";
import ErrorPage from "../pages/ErrorPage/ErrorPage";
import NotFoundPage from "../pages/NotFoundPage/NotFoundPage";
import LoginPage from "../pages/Login/LoginPage";
import DealerListPage from "../pages/Dealers/DealerListPage";
import LeadExchangePage from "../pages/LeadExchange/LeadExchangePage";
import MyLeadsPage from "../pages/MyLeads/MyLeadsPage";
import SyncLogsPage from "../pages/SyncLogs/SyncLogsPage";
import SettingsPage from "../pages/Settings/SettingsPage";
import { ROUTES } from "../constants/routes.constants";
import { APP_ROLES } from "../constants/auth.constants";
import UserManagementPage from "../pages/UserManagement/UserManagementPage";
import OnDemandDashboard from "../pages/OnDemandDashboard/OnDemandDashboard";

import Overview from "../pages/Overview/Overview";

/**
 * AppRoutes.jsx
 * -----------------------------------------------------------------------
 * Role split backed by real Catalyst roles. Super Admin and Admin share
 * the full management tree (Dealers, Lead Exchange — network-wide data
 * via /admin/*); Dealer gets a restricted tree (My Leads — scoped to
 * their own dealer_code via /dealer/leads/*, resolved server-side).
 *
 * User Management is Super Admin-only — inviting/removing Admin users
 * and controlling their dealer-management permissions is a higher
 * privilege tier than Admin itself, so it does NOT share the
 * SUPER_ADMIN + ADMIN block above like Dealers/Lead Exchange/Logs do.
 *
 * Settings is shared across all three roles (theme, password reset,
 * logout are role-agnostic) — no RequireRole wrapper needed.
 *
 * On Demand Dashboard is protected (must be logged in) but intentionally
 * sits OUTSIDE MainLayout's children — it's a sibling of the MainLayout
 * route object below, so it renders with no Sidebar/Navbar around it.
 */

const router = createHashRouter([
  {
    path: "/",
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <Navigate to={ROUTES.DASHBOARD} replace /> },
      {
        element: <AuthLayout />,
        children: [{ path: ROUTES.LOGIN, element: <LoginPage /> }],
      },
      {
        element: <ProtectedRoute />,
        children: [
          {
            element: <MainLayout />,
            children: [
              { path: ROUTES.DASHBOARD, element: <Overview /> },
              { path: ROUTES.SETTINGS, element: <SettingsPage /> },

              {
                element: <RequireRole allowedRoles={[APP_ROLES.SUPER_ADMIN, APP_ROLES.ADMIN]} />,
                children: [
                  { path: ROUTES.DEALERS, element: <DealerListPage /> },
                  { path: ROUTES.LEAD_EXCHANGE, element: <LeadExchangePage /> },
                  { path: ROUTES.LOGS, element: <SyncLogsPage /> },
                ],
              },

              {
                element: <RequireRole allowedRoles={[APP_ROLES.DEALER]} />,
                children: [
                  { path: ROUTES.MY_LEADS, element: <MyLeadsPage /> },
                ],
              },

              {
                element: <RequireRole allowedRoles={[APP_ROLES.SUPER_ADMIN]} />,
                children: [
                  { path: ROUTES.USER_MANAGEMENT, element: <UserManagementPage /> },
                ],
              },
            ],
          },

          // Sibling of the MainLayout route object — still requires auth via
          // ProtectedRoute above, but does NOT render inside MainLayout, so
          // no Sidebar/Navbar wraps it.
          { path: ROUTES.ON_DEMAND_DASHBOARD, element: <OnDemandDashboard /> },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

export default function AppRoutes() {
  return <RouterProvider router={router} />;
}