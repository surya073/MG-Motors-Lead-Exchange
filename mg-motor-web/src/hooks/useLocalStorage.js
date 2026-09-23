import { useEffect, useState } from "react";

/**
 * useLocalStorage.js
 * -----------------------------------------------------------------------
 * Generic, business-logic-free hook: state that persists to localStorage.
 * Included now to establish the convention for this folder â€” every custom
 * hook is generic and reusable across features, never tied to one module.
 */

export function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored !== null ? JSON.parse(stored) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage unavailable (private browsing, quota) â€” fail silently.
    }
  }, [key, value]);

  return [value, setValue];
}

