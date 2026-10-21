import { APP_ROLES } from "../constants/auth.constants";
import { adminDashboardService } from "../services/api/adminDashboardService";
import { dealerPortalService } from "../services/api/dealerPortalService";
import { isAdminSide } from "./globalSearch";

const CACHE_TTL_MS = 30000;
const MAX_CACHE_ENTRIES = 25;
const cache = new Map();

export async function loadSearchSuggestions(role, userKey, rawQuery) {
  const query = rawQuery.trim();
  if (!userKey || query.length < 2) return { leads: [], dealers: [] };
  const key = JSON.stringify([role, userKey, query.toLowerCase()]);
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && (existing.pending || existing.until > now)) return existing.promise;
  for (const [oldKey, value] of cache) {
    if (!value.pending && value.until <= now) cache.delete(oldKey);
  }
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  const entry = { pending: true };
  entry.promise = Promise.resolve().then(() => {
    if (isAdminSide(role)) return adminDashboardService.searchSuggestions(query);
    if (role === APP_ROLES.DEALER) return dealerPortalService.searchSuggestions(query);
    return { leads: [], dealers: [] };
  }).then((data) => {
    entry.pending = false;
    entry.until = Date.now() + CACHE_TTL_MS;
    return data;
  }, (err) => {
    if (cache.get(key) === entry) cache.delete(key);
    throw err;
  });
  cache.set(key, entry);
  return entry.promise;
}

export const clearSearchSuggestions = () => cache.clear();
