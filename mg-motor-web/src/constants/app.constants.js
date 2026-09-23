/**
 * app.constants.js
 * -----------------------------------------------------------------------
 * Small fixed values referenced by name elsewhere in the app (avoids
 * magic strings scattered across features).
 */

export const APP_NAME = "MG Motor Lead Exchange";

export const SESSION_STATUS = {
  UNKNOWN: "unknown",
  AUTHENTICATED: "authenticated",
  UNAUTHENTICATED: "unauthenticated",
  EXPIRED: "expired",
};

export const HTTP_STATUS = {
  OK: 200,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SERVER_ERROR: 500,
};

