import { useEffect, useRef, useState } from "react";

/**
 * useCountUp
 * -----------------------------------------------------------------------
 * Animates a number from 0 up to `target` once `active` becomes true
 * (e.g. once the entrance animation has finished and the dashboard is
 * revealed). Uses requestAnimationFrame with an ease-out curve rather
 * than setInterval so it stays smooth and cancels cleanly on unmount.
 *
 * Respects prefers-reduced-motion by snapping straight to the target.
 */
export default function useCountUp(target, { active = true, duration = 1400, decimals = 0, delay = 0 } = {}) {
  const [value, setValue] = useState(0);
  const frameRef = useRef(null);

  useEffect(() => {
    if (!active) return undefined;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) {
      setValue(target);
      return undefined;
    }

    let startTime = null;
    const timeoutId = setTimeout(() => {
      const tick = (now) => {
        if (startTime === null) startTime = now;
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out-cubic
        const next = target * eased;
        setValue(Number(next.toFixed(decimals)));
        if (progress < 1) {
          frameRef.current = requestAnimationFrame(tick);
        }
      };
      frameRef.current = requestAnimationFrame(tick);
    }, delay);

    return () => {
      clearTimeout(timeoutId);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, target, duration, decimals, delay]);

  return value;
}