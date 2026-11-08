import React, { useEffect, useState } from "react";
import { getJson } from "../api.js";
import { navigate, searchUrl, SEARCH_DEFAULTS } from "../router.js";
import { SearchBox, ReplayCard, CardSkeleton } from "../components.jsx";

// Homepage: one search entry point, with recent replays to browse under it.
export default function Home() {
  const [recent, setRecent] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

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
              <ReplayCard key={`${item.cycle}:${item.id}`} item={item} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
