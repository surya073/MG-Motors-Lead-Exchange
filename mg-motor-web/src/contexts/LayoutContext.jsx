import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { appConfig } from "../config/app.config";

/**
 * LayoutContext.jsx
 * -----------------------------------------------------------------------
 * Everything about the shape of the app shell that a future Settings
 * page (Day 9 â€” "Layout Density", "Sidebar Position") will eventually
 * let the user control. Built now so Sidebar/Navbar just read from here
 * instead of owning their own state, and Day 9 only has to add UI that
 * calls the setters already defined below.
 */

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 340;
const DEFAULT_SIDEBAR_WIDTH = 260; // matches --sidebar-width in variables.css

const LayoutContext = createContext(undefined);

export function LayoutProvider({ children }) {
  const [collapsed, setCollapsed] = useLocalStorage(
    appConfig.layout.sidebarStorageKey,
    appConfig.layout.defaultSidebarState === "collapsed"
  );
  const [sidebarWidth, setSidebarWidth] = useLocalStorage(
    `${appConfig.layout.sidebarStorageKey}.width`,
    DEFAULT_SIDEBAR_WIDTH
  );
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const toggleCollapsed = useCallback(() => setCollapsed((prev) => !prev), [setCollapsed]);
  const openMobileDrawer = useCallback(() => setMobileDrawerOpen(true), []);
  const closeMobileDrawer = useCallback(() => setMobileDrawerOpen(false), []);

  const startResizing = useCallback(() => setIsResizing(true), []);

  useEffect(() => {
    if (!isResizing) return undefined;

    const handleMouseMove = (event) => {
      const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, event.clientX));
      setSidebarWidth(next);
    };
    const stopResizing = () => setIsResizing(false);

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", stopResizing);
    document.body.style.userSelect = "none";

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", stopResizing);
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  const value = useMemo(
    () => ({
      collapsed,
      toggleCollapsed,
      sidebarWidth,
      isResizing,
      startResizing,
      mobileDrawerOpen,
      openMobileDrawer,
      closeMobileDrawer,
    }),
    [collapsed, toggleCollapsed, sidebarWidth, isResizing, startResizing, mobileDrawerOpen, openMobileDrawer, closeMobileDrawer]
  );

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout() {
  const context = useContext(LayoutContext);
  if (context === undefined) {
    throw new Error("useLayout must be used within a LayoutProvider");
  }
  return context;
}

