// Minimal client-side router on the History API, so search and watch pages
// have real, shareable, reloadable URLs and the browser Back button works:
//
//   /                          home (search + recent replays)
//   /search?q=…&scope=…&page=… search results (every filter in the query string,
//                              advanced rules as f0 o0 v0 …, see shared/replayQuery.js)
//   /watch/:cycle/:id?t=4      one replay (t = start time in seconds)
//
// The production server already sends index.html for any non-API path.
import { useEffect, useState } from "react";
import { parseRules, rulesToParams } from "../../shared/replayQuery.js";

function parse(loc = window.location) {
  const params = new URLSearchParams(loc.search);
  const watch = loc.pathname.match(/^\/watch\/(\d+)\/(\d+)\/?$/);
  if (watch) {
    return { name: "watch", cycle: Number(watch[1]), id: watch[2], params, key: loc.pathname + loc.search };
  }
  if (/^\/search\/?$/.test(loc.pathname)) {
    return { name: "search", params, key: loc.pathname + loc.search };
  }
  return { name: "home", params, key: "/" };
}

const listeners = new Set();

export function navigate(url, { replace = false, state = null } = {}) {
  if (replace) window.history.replaceState(state, "", url);
  else window.history.pushState(state, "", url);
  listeners.forEach((fn) => fn());
}

export function useRoute() {
  const [route, setRoute] = useState(() => parse());
  useEffect(() => {
    const update = () => setRoute(parse());
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route;
}

// Remembers scroll position and the row that was opened on the current
// history entry, so returning to a result list restores both.
export function saveListPosition(openedKey) {
  const state = { ...(window.history.state ?? {}), scrollY: window.scrollY, openedKey };
  window.history.replaceState(state, "", window.location.href);
}

// ─── Search URLs ───────────────────────────────────────────────────────────

export const SEARCH_DEFAULTS = {
  q: "",
  scope: "all",
  guests: "exclude",
  with: [],
  match: "all",
  mode: "",
  map: "",
  cycle: "",
  rules: [], // advanced-search rules (shared/replayQuery.js)
  sort: "newest",
  page: 1,
};

export function searchFromParams(params) {
  return {
    q: params.get("q") ?? "",
    scope: params.get("scope") ?? SEARCH_DEFAULTS.scope,
    guests: params.get("guests") ?? SEARCH_DEFAULTS.guests,
    with: params.getAll("with"),
    match: params.get("match") ?? SEARCH_DEFAULTS.match,
    mode: params.get("mode") ?? "",
    map: params.get("map") ?? "",
    cycle: params.get("cycle") ?? "",
    rules: parseRules(params),
    sort: params.get("sort") ?? SEARCH_DEFAULTS.sort,
    page: Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1),
  };
}

// Only non-default values go in the URL, so links stay short and readable.
export function searchToQuery(s) {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.scope && s.scope !== SEARCH_DEFAULTS.scope) p.set("scope", s.scope);
  if (s.guests && s.guests !== SEARCH_DEFAULTS.guests) p.set("guests", s.guests);
  for (const w of s.with ?? []) p.append("with", w);
  if ((s.with ?? []).length > 1 && s.match !== SEARCH_DEFAULTS.match) p.set("match", s.match);
  if (s.mode) p.set("mode", s.mode);
  if (s.map) p.set("map", s.map);
  if (s.cycle) p.set("cycle", s.cycle);
  for (const [k, v] of Object.entries(rulesToParams(s.rules ?? []))) p.set(k, v);
  if (s.sort && s.sort !== SEARCH_DEFAULTS.sort) p.set("sort", s.sort);
  if (s.page > 1) p.set("page", String(s.page));
  return p.toString();
}

export const searchUrl = (s) => {
  const q = searchToQuery(s);
  return q ? `/search?${q}` : "/search";
};

export const watchUrl = (item, t) =>
  `/watch/${item.cycle}/${item.id}${t > 0 ? `?t=${Math.floor(t)}` : ""}`;
