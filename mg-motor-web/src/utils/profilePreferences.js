import { useEffect, useState } from "react";
import { CarFront, Zap, Star, ShieldCheck, Rocket, Smile, Crown, Flame } from "lucide-react";

/**
 * Personalisation preferences chosen on the Settings page: the app's
 * accent (primary) colour and the profile avatar. Saved per browser in
 * localStorage and broadcast through a window event so the Settings
 * page, navbar avatar and the whole theme update instantly without a
 * reload. Nothing here touches the backend.
 */

const ACCENT_KEY = "settings:accentColor";
const AVATAR_GLYPH_KEY = "settings:avatarGlyph";
const AVATAR_COLOR_KEY = "settings:avatarColor";
const SESSION_START_KEY = "session:startedAt";
const SESSION_USER_KEY = "session:startedFor";
const CHANGE_EVENT = "settings:profilePreferences:change";

/* ---------------- Accent colours ---------------- */

export const DEFAULT_ACCENT = "mg-red";

export const ACCENT_COLORS = [
  { id: "mg-red", label: "MG Red", value: "#D0021B", hover: "#A80116" },
  { id: "ocean", label: "Ocean", value: "#2F6FED", hover: "#1F55C4" },
  { id: "emerald", label: "Emerald", value: "#1E9E6C", hover: "#157A53" },
  { id: "violet", label: "Violet", value: "#7C4DDA", hover: "#6034B8" },
  { id: "amber", label: "Amber", value: "#E07B00", hover: "#B86200" },
];

const ACCENT_VARS = [
  "--color-primary",
  "--color-primary-hover",
  "--color-primary-soft",
  "--color-primary-soft-strong",
];

/** Writes (or clears, for the default red) the primary-colour tokens on <html>. */
export function applyAccent(id) {
  const root = document.documentElement;
  const accent = ACCENT_COLORS.find((c) => c.id === id);
  if (!accent || accent.id === DEFAULT_ACCENT) {
    ACCENT_VARS.forEach((v) => root.style.removeProperty(v));
    return;
  }
  root.style.setProperty("--color-primary", accent.value);
  root.style.setProperty("--color-primary-hover", accent.hover);
  root.style.setProperty("--color-primary-soft", `color-mix(in srgb, ${accent.value} 12%, transparent)`);
  root.style.setProperty("--color-primary-soft-strong", `color-mix(in srgb, ${accent.value} 22%, transparent)`);
}

/* ---------------- Avatar ---------------- */

export const AVATAR_GLYPHS = [
  { id: "initials", label: "Initials", icon: null },
  { id: "car", label: "Car", icon: CarFront },
  { id: "bolt", label: "Bolt", icon: Zap },
  { id: "star", label: "Star", icon: Star },
  { id: "shield", label: "Shield", icon: ShieldCheck },
  { id: "rocket", label: "Rocket", icon: Rocket },
  { id: "smile", label: "Smile", icon: Smile },
  { id: "crown", label: "Crown", icon: Crown },
  { id: "flame", label: "Flame", icon: Flame },
];

// "default" keeps the stock black/white avatar of the current theme.
export const AVATAR_COLORS = [
  { id: "default", label: "Classic", value: null },
  { id: "red", label: "Red", value: "#D0021B" },
  { id: "blue", label: "Blue", value: "#2F6FED" },
  { id: "green", label: "Green", value: "#1E9E6C" },
  { id: "purple", label: "Purple", value: "#7C4DDA" },
  { id: "orange", label: "Orange", value: "#E07B00" },
];

/* ---------------- Storage + subscription ---------------- */

function read(key, fallback, allowed) {
  try {
    const stored = localStorage.getItem(key);
    return stored && allowed.includes(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the event below still updates this session.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

function usePreference(key, fallback, allowed) {
  const [value, setValue] = useState(() => read(key, fallback, allowed));

  useEffect(() => {
    const sync = () => setValue(read(key, fallback, allowed));
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
    // allowed/fallback are module constants — stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return [value, (next) => write(key, next)];
}

const ACCENT_IDS = ACCENT_COLORS.map((c) => c.id);
const GLYPH_IDS = AVATAR_GLYPHS.map((g) => g.id);
const AVATAR_COLOR_IDS = AVATAR_COLORS.map((c) => c.id);

export function useAccentColor() {
  const [accent, setStored] = usePreference(ACCENT_KEY, DEFAULT_ACCENT, ACCENT_IDS);
  const setAccent = (id) => {
    applyAccent(id);
    setStored(id);
  };
  return [accent, setAccent];
}

export function useAvatarPreference() {
  const [glyph, setGlyph] = usePreference(AVATAR_GLYPH_KEY, "initials", GLYPH_IDS);
  const [color, setColor] = usePreference(AVATAR_COLOR_KEY, "default", AVATAR_COLOR_IDS);
  return { glyph, color, setGlyph, setColor };
}

/** Put every personalisation setting back to its default. */
export function resetProfilePreferences() {
  applyAccent(DEFAULT_ACCENT);
  write(ACCENT_KEY, DEFAULT_ACCENT);
  write(AVATAR_GLYPH_KEY, "initials");
  write(AVATAR_COLOR_KEY, "default");
}

/** Call once on app load to re-apply the saved accent colour. */
export function restoreProfilePreferences() {
  applyAccent(read(ACCENT_KEY, DEFAULT_ACCENT, ACCENT_IDS));
}

/* ---------------- Session timing ---------------- */

/**
 * Records when the signed-in user's session began. Called once the app
 * confirms an authenticated user: the first call after a login stores
 * "now", later calls (page reloads, extra tabs) keep it. A different
 * user id means a different login, so the clock restarts.
 */
export function markSessionStart(userId) {
  try {
    const owner = userId == null ? "" : String(userId);
    const hasStart = Number(localStorage.getItem(SESSION_START_KEY)) > 0;
    if (!hasStart || localStorage.getItem(SESSION_USER_KEY) !== owner) {
      localStorage.setItem(SESSION_START_KEY, String(Date.now()));
      localStorage.setItem(SESSION_USER_KEY, owner);
    }
  } catch {
    // storage unavailable — session timing simply won't show.
  }
}

/** Forgets the session start — call on logout or when the session ends. */
export function clearSessionStart() {
  try {
    localStorage.removeItem(SESSION_START_KEY);
    localStorage.removeItem(SESSION_USER_KEY);
  } catch {
    // nothing to clear
  }
}

export function getSessionStart() {
  try {
    const raw = Number(localStorage.getItem(SESSION_START_KEY));
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}
