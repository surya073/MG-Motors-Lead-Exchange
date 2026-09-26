import { createHashRouter, Navigate, RouterProvider } from "react-router-dom";
import MainLayout from "../layouts/MainLayout/MainLayout";
import AuthLayout from "../layouts/AuthLayout/AuthLayout";
import ProtectedRoute from "./ProtectedRoute";
import RequireRole from "./RequireRole";
import ErrorPage from "../pages/ErrorPage/ErrorPage";
import NotFoundPage from "../pages/NotFoundPage/NotFoundPage";
import LoginPage from "../pages/Login/LoginPage";
import DealerListPage from "../pages/Dealers/DealerListPage";
import DealerCRMConfig from "../pages/Dealers/DealerCRMConfig";
import LeadExchangePage from "../pages/LeadExchange/LeadExchangePage";
import MyLeadsPage from "../pages/MyLeads/MyLeadsPage";
import SyncLogsPage from "../pages/SyncLogs/SyncLogsPage";
import SettingsPage from "../pages/Settings/SettingsPage";
import { ROUTES } from "../constants/routes.constants";
import { APP_ROLES } from "../constants/auth.constants";
import UserManagementPage from "../pages/UserManagement/UserManagementPage";
import OnDemandDashboard from "../pages/OnDemandDashboard/OnDemandDashboard";

import Overview from "../pages/Overview/Overview";

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
                  { path: ROUTES.DEALER_CRM_CONFIG, element: <DealerCRMConfig /> },
                  { path: ROUTES.LEAD_EXCHANGE, element: <LeadExchangePage /> },
                  // Same component as the list route above — LeadExchangePage
                  // itself decides list vs. detail from the :leadId param, so
                  // a browser refresh on a lead's detail view re-resolves it
                  // from the URL instead of falling back to the list.
                  { path: ROUTES.LEAD_EXCHANGE_DETAIL, element: <LeadExchangePage /> },
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