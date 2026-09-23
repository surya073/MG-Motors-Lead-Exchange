import { useEffect, useRef } from "react";

/**
 * useLiquidPointer
 * -----------------------------------------------------------------------
 * Tracks pointer position over an element and writes it to CSS custom
 * properties (--mx, --my as percentages) so a radial-gradient "liquid"
 * highlight in the CSS can follow the cursor. All work happens through
 * CSS var writes on a ref (no re-renders), throttled to one update per
 * animation frame, so it stays cheap even with many panels on screen.
 *
 * Usage: const ref = useLiquidPointer(); <div ref={ref} className="odd-liquid" />
 */
export default function useLiquidPointer() {
  const ref = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) return undefined;

    const handleMove = (event) => {
      if (frameRef.current) return;
      frameRef.current = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * 100;
        const y = ((event.clientY - rect.top) / rect.height) * 100;
        el.style.setProperty("--mx", `${x}%`);
        el.style.setProperty("--my", `${y}%`);
        el.style.setProperty("--mo", "1");
        frameRef.current = null;
      });
    };

    const handleLeave = () => {
      el.style.setProperty("--mo", "0");
    };

    el.addEventListener("pointermove", handleMove);
    el.addEventListener("pointerleave", handleLeave);
    return () => {
      el.removeEventListener("pointermove", handleMove);
      el.removeEventListener("pointerleave", handleLeave);
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return ref;
}