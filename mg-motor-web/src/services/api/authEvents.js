/**
 * authEvents.js
 * -----------------------------------------------------------------------
 * A response interceptor in axiosInstance.js needs to react to a 401
 * (session expired) by telling the rest of the app to log the user out
 * and redirect â€” but interceptors run outside the React tree and can't
 * call useAuth() directly. This tiny event target is the bridge:
 * axiosInstance emits, AuthContext listens.
 */

const target = new EventTarget();

export const AUTH_EVENTS = {
  SESSION_EXPIRED: "session-expired",
};

export function emitAuthEvent(eventName) {
  target.dispatchEvent(new Event(eventName));
}

export function onAuthEvent(eventName, handler) {
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
}

