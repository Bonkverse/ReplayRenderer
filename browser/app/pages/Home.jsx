import React, { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../api.js";
import { navigate, searchUrl, SEARCH_DEFAULTS } from "../router.js";
import { SearchBox, ReplayCard, CardSkeleton } from "../components.jsx";
import LiveStatus from "../LiveStatus.jsx";

const keyOf = (r) => `${r.cycle}:${r.id}`;
const newer = (a, b) => a.cycle > b.cycle || (a.cycle === b.cycle && Number(a.id) > Number(b.id));

// Homepage: one search entry point, the live collector status, and recent
// replays that refresh themselves when new ones are fetched.
export default function Home() {
  const [recent, setRecent] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [newKeys, setNewKeys] = useState(() => new Set());
  const [announcement, setAnnouncement] = useState(null);
  const recentRef = useRef(null);
  recentRef.current = recent;

  useEffect(() => {
    document.title = "Bonkverse Replays";
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    setError(null);
    getJson("/api/recent?limit=9", { signal: ctrl.signal })
      .then((data) => setRecent(data.results ?? []))
      .catch((err) => {
        if (err.name !== "AbortError") setError(err.message);
      });
    return () => ctrl.abort();
  }, [attempt]);

  // Called by LiveStatus when replays newer than our top card exist.
  const onNew = useCallback(async (count) => {
    try {
      const prevTop = recentRef.current?.[0];
      const data = await getJson("/api/recent?limit=9", { fresh: true });
      const fresh = data.results ?? [];
      setNewKeys(new Set(prevTop ? fresh.filter((r) => newer(r, prevTop)).map(keyOf) : []));
      setRecent(fresh);
      setAnnouncement(`${count.toLocaleString()} new replay${count === 1 ? "" : "s"} added`);
    } catch {
      // The next status check will try again.
    }
  }, []);

  // Let the "N new replays added" note fade after a while.
  useEffect(() => {
    if (!announcement) return;
    const t = setTimeout(() => setAnnouncement(null), 12_000);
    return () => clearTimeout(t);
  }, [announcement]);

  const top = recent?.[0] ? { cycle: recent[0].cycle, id: recent[0].id } : null;
  const latestCycle = recent?.[0]?.cycle;

  return (
    <main className="page page--home" id="main">
      <section className="hero">
        <h1>Bonkverse Replays</h1>
        <p className="hero__lead">Find a player, map, or match from Bonk.io.</p>
        <SearchBox
          large
          autoFocus
          onSubmit={(q, scope) => q.length > 0 && navigate(searchUrl({ ...SEARCH_DEFAULTS, q, scope }))}
        />
      </section>

      <section className="section" aria-labelledby="recent-heading">
        <div className="section__head">
          <h2 id="recent-heading">Recent replays</h2>
          {latestCycle != null && (
            <a
              className="link"
              href={searchUrl({ ...SEARCH_DEFAULTS, cycle: String(latestCycle) })}
              onClick={(e) => {
                e.preventDefault();
                navigate(searchUrl({ ...SEARCH_DEFAULTS, cycle: String(latestCycle) }));
              }}
            >
              Browse all ›
            </a>
          )}
        </div>

        {recent && <LiveStatus since={top} onNew={onNew} />}

        <p className="new-note" role="status" aria-live="polite">
          {announcement && (
            <span>
              <span aria-hidden="true">● </span>
              {announcement}
            </span>
          )}
        </p>

        {error ? (
          <div className="notice">
            <p>{error}</p>
            <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
              Retry
            </button>
          </div>
        ) : recent == null ? (
          <CardSkeleton count={6} />
        ) : recent.length === 0 ? (
          <p className="muted">No replays yet.</p>
        ) : (
          <ul className="cards">
            {recent.map((item) => (
              <ReplayCard key={keyOf(item)} item={item} isNew={newKeys.has(keyOf(item))} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
