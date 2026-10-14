import { env } from "../config/env";

/**
 * Temporary auth-loop diagnostics. They print parts of the session (token
 * prefix, user profile), so they log only in development builds and stay
 * silent in the production bundle.
 */
export function authDebug(...args) {
  if (env.isProd) return;
  console.log("[AUTH-DEBUG]", ...args);
}
