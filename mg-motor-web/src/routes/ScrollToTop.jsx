import { useEffect } from "react";
import { Outlet, useLocation, useNavigationType } from "react-router-dom";

/**
 * ScrollToTop.jsx
 * -----------------------------------------------------------------------
 * Rendered as the `element` of the root route in AppRoutes.jsx, so every
 * route in the app passes through it. On a PUSH/REPLACE navigation (a
 * click on a menu item, link, card, or action button - anything that
 * changes the URL going forward) it resets scroll to the top of the new
 * page. On POP navigations (browser back/forward) it does nothing, so the
 * browser's own scroll-restoration for back/forward keeps working as
 * users expect.
 *
 * window.scrollTo alone isn't enough here: MainLayout and
 * OnDemandDashboard each own a `height: 100vh; overflow-y: auto` region
 * instead of letting the document/body scroll, so their containers need
 * scrollTop reset directly. If a future top-level layout introduces its
 * own scrollable shell, add its selector to SCROLL_CONTAINER_SELECTORS.
 */
const SCROLL_CONTAINER_SELECTORS = [
  ".main-layout__scroll", // MainLayout (Overview, Dealers, Lead Exchange, Sync Logs, Settings, ...)
  ".odd-root",            // OnDemandDashboard (standalone route, owns its own scroll shell)
];

function resetScrollToTop() {
  window.scrollTo(0, 0);
  for (const selector of SCROLL_CONTAINER_SELECTORS) {
    const el = document.querySelector(selector);
    if (el) {
      el.scrollTop = 0;
    }
  }
}

export default function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === "POP") {
      return;
    }
    resetScrollToTop();
  }, [pathname, navigationType]);

  return <Outlet />;
}
