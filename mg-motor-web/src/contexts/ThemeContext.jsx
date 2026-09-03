import { createContext, useContext, useEffect, useState } from "react";
import { appConfig } from "../config/app.config";

/**
 * ThemeContext.jsx
 * -----------------------------------------------------------------------
 * Provides the light/dark theme mode to the whole tree and applies it as
 * a `data-theme` attribute on <html>, which the CSS variables in
 * styles/variables.css key off of. The actual switch control (Day 3
 * layout â€” "Theme Switch") will just call `toggleTheme()` from here.
 */

const ThemeContext = createContext(undefined);

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(() => {
    const stored = localStorage.getItem(appConfig.theme.storageKey);
    return stored || appConfig.theme.defaultMode;
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", mode);
    localStorage.setItem(appConfig.theme.storageKey, mode);
  }, [mode]);

  const toggleTheme = () => {
    setMode((prev) => (prev === "light" ? "dark" : "light"));
  };

  return (
    <ThemeContext.Provider value={{ mode, setMode, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

