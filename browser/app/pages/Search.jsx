import React, { useEffect, useRef, useState } from "react";
import { getJson } from "../api.js";
import { navigate, searchFromParams, searchToQuery, searchUrl, SEARCH_DEFAULTS } from "../router.js";
import { SearchBox, ReplayRow, RowSkeleton, Pagination, PageJump, scopeLabel } from "../components.jsx";
import { MODE_LABELS, modeLabel, ABOUT_DATES_URL } from "../format.js";

const GUEST_OPTIONS = [
  ["exclude", "Registered only"],
  ["include", "Include guests"],
  ["only", "Guests only"],
];

function activeFilterCount(s) {
  return (
    (s.with.length > 0 ? 1 : 0) +
    (s.mode ? 1 : 0) +
    (s.map ? 1 : 0) +
    (s.cycle ? 1 : 0) +
    (s.guests !== SEARCH_DEFAULTS.guests ? 1 : 0)
  );
}

// ─── Filter panel ──────────────────────────────────────────────────────────

/**
 * Participant and match filters. Edits are a draft until Apply; closing
 * discards them and returns focus to the Filters button. A side panel on
 * wide screens and a full-height sheet on phones (CSS).
 */
function FilterPanel({ search, onApply, onClose, returnFocusRef }) {
  const [draft, setDraft] = useState(() => ({ ...search, with: [...search.with] }));
  const [newPlayer, setNewPlayer] = useState("");
  const firstFieldRef = useRef(null);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (e) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    onClose();
    setTimeout(() => returnFocusRef.current?.focus(), 0);
  }

  function addPlayer() {
    const name = newPlayer;
    if (!name || draft.with.includes(name) || draft.with.length >= 5) return;
    set({ with: [...draft.with, name] });
    setNewPlayer("");
  }

  const playerSearch = search.scope === "username" && search.q;

  return (
    <>
      <div className="sheet-backdrop" onClick={close} aria-hidden="true" />
      <aside className="filters" role="dialog" aria-modal="true" aria-labelledby="filters-title">
        <div className="filters__head">
          <h2 id="filters-title">{playerSearch ? "Replay filters" : "Filters"}</h2>
          <button className="icon-button" onClick={close} aria-label="Close filters">
            ✕
          </button>
        </div>

        <div className="filters__body">
          <fieldset className="field-group">
            <legend>Players</legend>
            {playerSearch && (
              <div className="field">
                <span className="field__label">Search player</span>
                <span className="token token--fixed">{search.q}</span>
              </div>
            )}

            <div className="field">
              <label className="field__label" htmlFor="add-player">
                {playerSearch ? "Additional players (same replay)" : "Players in the same replay"}
              </label>
              {draft.with.length > 0 && (
                <ul className="tokens">
                  {draft.with.map((name) => (
                    <li key={name} className="token">
                      {name}
                      <button
                        type="button"
                        aria-label={`Remove ${name}`}
                        onClick={() => set({ with: draft.with.filter((n) => n !== name) })}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="inline-input">
                <input
                  id="add-player"
                  ref={firstFieldRef}
                  value={newPlayer}
                  onChange={(e) => setNewPlayer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addPlayer();
                    }
                  }}
                  placeholder="Exact username"
                  disabled={draft.with.length >= 5}
                />
                <button type="button" className="btn" onClick={addPlayer} disabled={!newPlayer}>
                  + Add
                </button>
              </div>
            </div>

            {draft.with.length > 1 && (
              <div className="segmented" role="radiogroup" aria-label="Match added players">
                {[
                  ["all", "All added"],
                  ["any", "Any added"],
                ].map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={draft.match === v}
                    className={draft.match === v ? "is-active" : ""}
                    onClick={() => set({ match: v })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            <div className="field">
              <span className="field__label" id="guests-label">
                Account type
              </span>
              <div className="segmented" role="radiogroup" aria-labelledby="guests-label">
                {GUEST_OPTIONS.map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={draft.guests === v}
                    className={draft.guests === v ? "is-active" : ""}
                    onClick={() => set({ guests: v })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="field__hint">
                Guest names aren&rsquo;t unique, so name matches use registered accounts unless you include guests.
              </p>
            </div>
          </fieldset>

          <fieldset className="field-group">
            <legend>Match</legend>
            <label className="field">
              <span className="field__label">Map</span>
              <input
                value={draft.map}
                onChange={(e) => set({ map: e.target.value })}
                placeholder="Map name or map ID"
              />
            </label>
            <label className="field">
              <span className="field__label">Mode</span>
              <select value={draft.mode} onChange={(e) => set({ mode: e.target.value })}>
                <option value="">Any mode</option>
                {Object.entries(MODE_LABELS).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">Cycle</span>
              <select value={draft.cycle} onChange={(e) => set({ cycle: e.target.value })}>
                <option value="">Any cycle</option>
                <option value="6">Cycle 6 (May 2026 – now)</option>
                <option value="5">Cycle 5 (Mar 2025 – Apr 2026)</option>
              </select>
            </label>
          </fieldset>
        </div>

        <div className="filters__foot">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                with: [],
                match: SEARCH_DEFAULTS.match,
                mode: "",
                map: "",
                cycle: "",
                guests: SEARCH_DEFAULTS.guests,
              }))
            }
          >
            Reset filters
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onApply({ ...draft, page: 1 });
              setTimeout(() => returnFocusRef.current?.focus(), 0);
            }}
          >
            Apply filters
          </button>
        </div>
      </aside>
    </>
  );
}

// ─── Search page ───────────────────────────────────────────────────────────

export default function Search({ route }) {
  const search = searchFromParams(route.params);
  const apiQuery = searchToQuery(search);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersBtnRef = useRef(null);

  const go = (next) => navigate(searchUrl(next));

  useEffect(() => {
    const label = search.q ? `“${search.q}”` : "Replays";
    document.title = `${label} · Bonkverse Replays`;
    try {
      sessionStorage.setItem("bv:lastSearch", JSON.stringify({ url: route.key, label: search.q || "Replays" }));
    } catch {}
  }, [route.key]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    getJson(`/api/search?${apiQuery}`, { signal: ctrl.signal, useCache: true })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [apiQuery, attempt]);

  // Back from a replay: restore scroll and focus the row that was opened.
  // A fresh search starts at the top.
  useEffect(() => {
    if (loading || !data) return;
    const st = window.history.state;
    if (st?.openedKey) {
      window.scrollTo(0, st.scrollY ?? 0);
      const link = document.querySelector(`[data-key="${CSS.escape(st.openedKey)}"] a`);
      link?.focus({ preventScroll: true });
      window.history.replaceState({ ...st, openedKey: null }, "", window.location.href);
    } else {
      window.scrollTo(0, 0);
    }
  }, [loading, data]);

  const results = data?.results ?? [];
  const total = data?.total ?? 0;
  const filterCount = activeFilterCount(search);
  const hasCriteria = search.q || filterCount > 0;

  const heading =
    search.scope === "username" && search.q
      ? `Replays with ${search.q}`
      : search.q
        ? `Results for “${search.q}”`
        : "Replays";

  const chips = [
    ...search.with.map((name) => ({
      key: `with-${name}`,
      label: `With ${name}`,
      remove: () => go({ ...search, with: search.with.filter((n) => n !== name), page: 1 }),
    })),
    search.mode && { key: "mode", label: modeLabel(search.mode), remove: () => go({ ...search, mode: "", page: 1 }) },
    search.map && { key: "map", label: `Map: ${search.map}`, remove: () => go({ ...search, map: "", page: 1 }) },
    search.cycle && { key: "cycle", label: `Cycle ${search.cycle}`, remove: () => go({ ...search, cycle: "", page: 1 }) },
    search.guests !== SEARCH_DEFAULTS.guests && {
      key: "guests",
      label: search.guests === "only" ? "Guests only" : "Including guests",
      remove: () => go({ ...search, guests: SEARCH_DEFAULTS.guests, page: 1 }),
    },
  ].filter(Boolean);

  const countText = loading
    ? "Searching…"
    : `${total.toLocaleString()}${data?.capped ? "+" : ""} ${total === 1 ? "match" : "matches"}`;
  const hasEstimated = results.some((r) => r.estimated_day);

  return (
    <main className="page page--search" id="main">
      <div className="search-top">
        <SearchBox
          initialQuery={search.q}
          initialScope={search.scope}
          onSubmit={(q, scope) => go({ ...search, q, scope, page: 1 })}
          onScopeChange={(scope, q) => q && go({ ...search, q, scope, page: 1 })}
          filterCount={filterCount}
          onOpenFilters={() => setFiltersOpen(true)}
          filtersButtonRef={filtersBtnRef}
        />
      </div>

      <div className={`search-layout${filtersOpen ? " has-filters" : ""}`}>
        <section className="results" aria-labelledby="results-heading">
          <div className="results__head">
            <div>
              <h1 id="results-heading" className="results__title">
                {heading}
              </h1>
              <p className="results__count" aria-live="polite">
                {countText}
                {search.q && ` · ${scopeLabel(search.scope)}`}
                {!loading && hasEstimated && (
                  <>
                    {" · "}
                    <a className="link" href={ABOUT_DATES_URL}>
                      ≈ dates are estimated
                    </a>
                  </>
                )}
              </p>
            </div>
            <div className="results__tools">
            {!loading && data?.totalPages > 1 && (
              <div className="results__pager">
                <button
                  className="pager__btn pager__step"
                  onClick={() => go({ ...search, page: data.page - 1 })}
                  disabled={data.page <= 1}
                  aria-label="Previous page"
                >
                  ‹
                </button>
                <PageJump
                  compact
                  page={data.page}
                  totalPages={data.totalPages}
                  onPage={(p) => go({ ...search, page: p })}
                />
                <button
                  className="pager__btn pager__step"
                  onClick={() => go({ ...search, page: data.page + 1 })}
                  disabled={data.page >= data.totalPages}
                  aria-label="Next page"
                >
                  ›
                </button>
              </div>
            )}
            <label className="sort">
              <span className="visually-hidden">Sort</span>
              <select value={search.sort} onChange={(e) => go({ ...search, sort: e.target.value, page: 1 })}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </label>
            </div>
          </div>

          {chips.length > 0 && (
            <ul className="applied" aria-label="Applied filters">
              {chips.map((c) => (
                <li key={c.key}>
                  <button className="chip is-active chip--removable" onClick={c.remove} aria-label={`Remove filter: ${c.label}`}>
                    {c.label} <span aria-hidden="true">✕</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!hasCriteria ? (
            <div className="notice">
              <p>Type a player, map, or replay ID to search.</p>
            </div>
          ) : error ? (
            <div className="notice notice--error">
              <p>{error}</p>
              <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            </div>
          ) : loading ? (
            <RowSkeleton count={6} />
          ) : results.length === 0 ? (
            <div className="notice">
              <p>No replays match this search.</p>
              {search.scope === "username" && search.guests === "exclude" && (
                <p className="muted">
                  Only registered accounts are matched by name.{" "}
                  <button className="link-button" onClick={() => go({ ...search, guests: "include", page: 1 })}>
                    Include guests
                  </button>
                </p>
              )}
              {chips.length > 0 && (
                <button
                  className="btn"
                  onClick={() =>
                    go({ ...SEARCH_DEFAULTS, q: search.q, scope: search.scope, sort: search.sort })
                  }
                >
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <>
              <ul className="rows">
                {results.map((item) => (
                  <ReplayRow key={`${item.cycle}:${item.id}`} item={item} search={search} />
                ))}
              </ul>
              <Pagination
                page={data.page}
                totalPages={data.totalPages}
                capped={data.capped}
                busy={loading}
                onPage={(p) => go({ ...search, page: p })}
              />
            </>
          )}
        </section>

        {filtersOpen && (
          <FilterPanel
            search={search}
            returnFocusRef={filtersBtnRef}
            onClose={() => setFiltersOpen(false)}
            onApply={(next) => {
              setFiltersOpen(false);
              go(next);
            }}
          />
        )}
      </div>
    </main>
  );
}
