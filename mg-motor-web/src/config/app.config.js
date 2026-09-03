/**
 * app.config.js
 * -----------------------------------------------------------------------
 * Non-secret, non-environment configuration: defaults the app boots with.
 * Kept separate from env.js because these values are code decisions
 * (safe to hardcode, safe to commit), not deployment-specific secrets.
 */

export const appConfig = {
  theme: {
    defaultMode: "light", // "light" | "dark" â€” Day 3 wires the switch UI
    storageKey: "mglx.theme",
  },

  layout: {
    defaultSidebarState: "expanded", // "expanded" | "collapsed"
    sidebarStorageKey: "mglx.sidebar",
  },

  pagination: {
    defaultPageSize: 20,
  },
};

