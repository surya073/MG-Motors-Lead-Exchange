import { useEffect } from "react";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider } from "./contexts/AuthContext";
import { LayoutProvider } from "./contexts/LayoutContext";
import { AlertProvider } from "./ui/Alerts/Alerts";
import AppRoutes from "./routes/AppRoutes";

/**
 * App.jsx
 * -----------------------------------------------------------------------
 * Composition root. Global providers wrap the route tree here; nothing
 * else in the app should reach for a provider directly. AuthProvider
 * must sit above AppRoutes since both ProtectedRoute and LoginPage read
 * from it via useAuth(). LayoutProvider only needs to wrap MainLayout in
 * principle, but sits at the same level as the others for consistency —
 * one place to look for every app-wide provider. AlertProvider sits at
 * the outermost level so any provider or route (including AuthProvider,
 * e.g. login failure toasts) can call useAlerts().
 */
export default function App() {
  // Restore the user's saved font-size preference on load — without
  // this, data-font-size resets to the CSS default (medium) on every
  // refresh even though Settings already persisted a different choice.
  useEffect(() => {
    const savedFontSize = localStorage.getItem("settings:fontSize");
    if (savedFontSize) document.documentElement.setAttribute("data-font-size", savedFontSize);
  }, []);

  return (
    <AlertProvider>
      <ThemeProvider>
        <LayoutProvider>
          <AuthProvider>
            <AppRoutes />
          </AuthProvider>
        </LayoutProvider>
      </ThemeProvider>
    </AlertProvider>
  );
}