// API client. In local dev the API runs on its own port (server/dev-api.mjs);
// in production one server serves both the frontend and /api/* from the
// same origin, so relative paths work and no CORS is needed.
export const API_BASE = import.meta.env.DEV ? "http://127.0.0.1:5174" : "";

const cache = new Map(); // url → parsed JSON (lists only; small and short-lived)
const CACHE_MAX = 40;

/**
 * GET JSON with an AbortSignal, so a newer request can cancel a stale one.
 * List responses can be cached so Back to a result page is instant; pass
 * fresh: true when the data is known to have changed.
 */
export async function getJson(path, { signal, useCache = false, fresh = false } = {}) {
  const url = `${API_BASE}${path}`;
  if (useCache && !fresh && cache.has(url)) return cache.get(url);

  // fresh: skip the browser's HTTP cache too (e.g. /api/recent is cacheable
  // for 30s, but a refresh after new replays arrive must see them).
  const res = await fetch(url, { signal, cache: fresh ? "no-store" : "default" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");

  if (useCache) {
    cache.set(url, data);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return data;
}

export const thumbnailUrl = (mapid) => `${API_BASE}/api/map/${mapid}/thumbnail.svg`;
