import axios from "axios";
import { env } from "../../config/env";
import { emitAuthEvent, AUTH_EVENTS } from "./authEvents";
import { authService } from "./authService";

/**
 * axiosInstance.js
 * -----------------------------------------------------------------------
 * Catalyst's Advanced I/O functions require an explicit Authorization
 * token (generated via catalyst.auth.generateAuthToken()) to resolve
 * identity server-side via catalyst.initialize(req) — the session cookie
 * alone is not sufficient for this, even though it is sufficient for
 * direct Catalyst BaaS calls. This request interceptor attaches that
 * token to every outgoing call. Tokens are short-lived (1hr per
 * Catalyst's docs), so this fetches a fresh one per request rather than
 * caching — generateAuthToken() itself is cheap/fast.
 */

const axiosInstance = axios.create({
  baseURL: env.api.baseUrl,
  timeout: env.api.timeout,
  headers: {
    "Content-Type": "application/json",
  },
  withCredentials: true,
});

axiosInstance.interceptors.request.use(async (config) => {
  try {
    const token = await authService.generateAuthToken();
    // TEMP DEBUG — remove once auth loop is confirmed fixed
    console.log(
      "[AUTH-DEBUG] token generated:",
      token ? token.substring(0, 20) + "..." : "NULL/EMPTY"
    );
    if (token) {
      config.headers.Authorization = token;
    }
  } catch (err) {
    // TEMP DEBUG — remove once auth loop is confirmed fixed
    console.log("[AUTH-DEBUG] generateAuthToken FAILED:", err);
    // No token available — request proceeds without it; the existing
    // 401 response interceptor below will still catch the resulting
    // auth failure.
  }
  return config;
});

axiosInstance.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      // TEMP DEBUG — remove once auth loop is confirmed fixed
      console.log(
        "[AUTH-DEBUG] 401 response body:",
        JSON.stringify(error?.response?.data)
      );
      console.log(
        "[AUTH-DEBUG] request that failed:",
        error?.config?.url,
        "had Authorization header:",
        !!error?.config?.headers?.Authorization
      );
      emitAuthEvent(AUTH_EVENTS.SESSION_EXPIRED);
    }
    return Promise.reject(error);
  }
);

export default axiosInstance;