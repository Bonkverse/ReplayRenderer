import React, { useEffect, useMemo, useRef, useState } from "react";
import box2d from "../../../vendor/box2d.esm.js";
import ReplayPlayer from "../../ReplayPlayer.jsx";
import { getJson } from "../api.js";
import { loadBonkFonts } from "../fonts.js";
import { navigate, searchUrl, watchUrl, SEARCH_DEFAULTS } from "../router.js";
import { PlayerAvatar, GuestBadge, ReplayCard, useToast } from "../components.jsx";
import {
  extractMeta,
  extractPlayers,
  modeLabel,
  teamColor,
  teamLabel,
  initials,
  formatDuration,
  formatClock,
  replayDate,
  ESTIMATED_DATE_NOTE,
  ABOUT_DATES_URL,
} from "../format.js";

// Passed to ReplayPlayer as decodeReplayData. Module scope so it's the same
// function on every render (an inline arrow would re-run the player's setup
// effect whenever this page re-renders).
const identityDecode = (x) => x;

const byName = (a, b) => (a.username || "").localeCompare(b.username || "", undefined, { sensitivity: "base" });

function goSearch(e, next) {
  e.preventDefault();
  navigate(searchUrl({ ...SEARCH_DEFAULTS, ...next }));
}

// ─── Scoreboard ────────────────────────────────────────────────────────────

function ScoreRow({ p }) {
  return (
    <li className="score-row">
      <PlayerAvatar avatar={p.avatar} initialsText={initials(p.username)} color={teamColor(p.team)} size={32} />
      <div className="score-row__who">
        <a
          className="score-row__name"
          href={searchUrl({ ...SEARCH_DEFAULTS, q: p.username, scope: "username", guests: p.guest ? "only" : "exclude" })}
          onClick={(e) => goSearch(e, { q: p.username, scope: "username", guests: p.guest ? "only" : "exclude" })}
          title={`Replays with ${p.username}`}
        >
          {p.username}
        </a>
        {p.guest && <GuestBadge />}
        <div className="score-row__meta">
          Lv {p.level}
          {p.ping != null && ` · ${p.ping} ms`}
        </div>
      </div>
    </li>
  );
}

function Scoreboard({ players, teams }) {
  if (players.length === 0) {
    return (
      <section className="panel scoreboard">
        <h2 className="panel__title">Scoreboard</h2>
        <p className="muted">No player data on this replay.</p>
      </section>
    );
  }

  if (teams) {
    // Team games: one score per team, players listed under their team.
    const groups = new Map();
    for (const p of players) {
      if (!groups.has(p.team)) groups.set(p.team, []);
      groups.get(p.team).push(p);
    }
    const ordered = [...groups.entries()].sort(
      ([, a], [, b]) => (b[0].score ?? -1) - (a[0].score ?? -1)
    );
    return (
      <section className="panel scoreboard" aria-labelledby="scoreboard-title">
        <div className="panel__head">
          <h2 className="panel__title" id="scoreboard-title">
            Scoreboard
          </h2>
          <span className="muted">Score</span>
        </div>
        {ordered.map(([team, members]) => (
          <div className="team" key={team}>
            <div className="team__head">
              <span className="team__swatch" style={{ background: teamColor(team) }} aria-hidden="true" />
              <span className="team__name">{teamLabel(team) ? `${teamLabel(team)} team` : "No team"}</span>
              <span className="team__score tabular">{members[0].score ?? "—"}</span>
            </div>
            <ul className="score-list">
              {[...members].sort(byName).map((p) => (
                <ScoreRow key={p.slot} p={p} />
              ))}
            </ul>
          </div>
        ))}
      </section>
    );
  }

  const sorted = [...players].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || byName(a, b));
  return (
    <section className="panel scoreboard" aria-labelledby="scoreboard-title">
      <div className="panel__head">
        <h2 className="panel__title" id="scoreboard-title">
          Scoreboard
        </h2>
        <span className="muted">Score</span>
      </div>
      <ul className="score-list">
        {sorted.map((p) => (
          <li className="score-line" key={p.slot}>
            <ScoreRow p={p} />
            <span className="score-line__score tabular">{p.score ?? "—"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Share / Export menus ──────────────────────────────────────────────────

function Menu({ label, children, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => !ref.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button className="btn" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)} disabled={disabled}>
        {label}
      </button>
      {open && (
        <div className="menu__pop" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ─── Watch page ────────────────────────────────────────────────────────────

export default function Watch({ route }) {
  const { cycle, id } = route;
  const startAt = Math.max(0, parseInt(route.params.get("t") ?? "0", 10) || 0);
  const [replay, setReplay] = useState(null);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [related, setRelated] = useState(null);
  const [tab, setTab] = useState("match");
  const [exportState, setExportState] = useState({ isExporting: false, exportPct: null, gifExportPct: null });
  const [withTime, setWithTime] = useState(false);
  const playerRef = useRef(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    const ctrl = new AbortController();
    setReplay(null);
    setError(null);
    setRelated(null);
    setTab("match");
    window.scrollTo(0, 0);

    getJson(`/api/replay/${id}?cycle=${cycle}`, { signal: ctrl.signal })
      .then(async (data) => {
        await loadBonkFonts();
        if (!ctrl.signal.aborted) setReplay(data);
        if (data.mapid) {
          getJson(`/api/related?mapid=${data.mapid}&id=${data.id}&cycle=${data.cycle}&limit=4`, { signal: ctrl.signal })
            .then((r) => setRelated(r.results ?? []))
            .catch(() => setRelated([]));
        } else {
          setRelated([]);
        }
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError(err.message);
      });
    return () => ctrl.abort();
  }, [cycle, id, attempt]);

  const meta = useMemo(() => (replay ? extractMeta(replay.decoded) : null), [replay]);
  const players = useMemo(() => (replay ? extractPlayers(replay.decoded) : []), [replay]);

  const title = meta?.mapName || "Replay";
  useEffect(() => {
    document.title = replay ? `${title} · #${id} · Bonkverse Replays` : "Replay · Bonkverse Replays";
  }, [replay, title, id]);

  // Back link: real history when we came from a list (restores its scroll
  // and focus), otherwise the last search, otherwise home.
  let lastSearch = null;
  try {
    lastSearch = JSON.parse(sessionStorage.getItem("bv:lastSearch") ?? "null");
  } catch {}
  function goBack(e) {
    e.preventDefault();
    if (window.history.state?.fromList) window.history.back();
    else navigate(lastSearch?.url ?? "/");
  }

  async function copyLink(close) {
    const t = withTime ? playerRef.current?.getTime?.() ?? 0 : 0;
    const url = `${window.location.origin}${watchUrl({ cycle, id }, t)}`;
    close();
    try {
      if (navigator.share && window.matchMedia("(pointer: coarse)").matches) {
        await navigator.share({ title: `${title} · #${id}`, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      showToast(withTime ? `Link copied (starts at ${formatClock(t)})` : "Link copied");
    } catch (err) {
      if (err?.name !== "AbortError") showToast("Couldn't copy the link");
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(replay.decoded, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bonkverse-replay-${cycle}-${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyJson() {
    try {
      await navigator.clipboard.writeText(JSON.stringify(replay.decoded, null, 2));
      showToast("JSON copied");
    } catch {
      showToast("Couldn't copy the JSON");
    }
  }

  const date = replay ? replayDate(replay) : null;
  const exportLabel =
    exportState.exportPct !== null
      ? `Exporting video… ${exportState.exportPct}%`
      : exportState.gifExportPct !== null
        ? `Exporting GIF… ${exportState.gifExportPct}%`
        : "Export";

  return (
    <main className="page page--watch" id="main">
      <a className="back-link" href={lastSearch?.url ?? "/"} onClick={goBack}>
        ‹ {lastSearch ? `Results for ${lastSearch.label}` : "Search replays"}
      </a>

      {error ? (
        <div className="notice notice--error">
          <p>{error}</p>
          <button className="btn" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : (
        <div className="watch">
          <div className="watch__player">
            <div className="player-shell" id="player-shell">
              {replay ? (
                <ReplayPlayer
                  key={`${replay.cycle}:${replay.id}`}
                  ref={playerRef}
                  blob={replay.decoded}
                  box2d={box2d}
                  decodeReplayData={identityDecode}
                  fullscreenTargetId="player-shell"
                  onExportStateChange={setExportState}
                  initialTime={startAt}
                />
              ) : (
                <div className="player-skeleton skeleton" aria-label="Loading replay" />
              )}
            </div>
          </div>

          <div className="watch__heading">
            {replay ? (
              <>
                <h1 className="watch__title">
                  {title} <span className="watch__id">· #{id}</span>
                </h1>
                <p className="watch__sub">
                  {[
                    modeLabel(meta.mode),
                    meta.teams == null ? null : meta.teams ? "Teams" : "Free-for-all",
                    `Cycle ${replay.cycle}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  {" · "}
                  {date.estimated ? (
                    <a className="link" href={ABOUT_DATES_URL} title={ESTIMATED_DATE_NOTE}>
                      {date.text}
                    </a>
                  ) : (
                    date.text
                  )}
                </p>
                <div className="watch__actions">
                  <Menu label="Share">
                    {(close) => (
                      <div className="menu__section">
                        <label className="check">
                          <input type="checkbox" checked={withTime} onChange={(e) => setWithTime(e.target.checked)} />
                          Start at current time
                        </label>
                        <button className="btn btn--primary btn--block" onClick={() => copyLink(close)}>
                          Copy link
                        </button>
                      </div>
                    )}
                  </Menu>
                  <Menu label={exportLabel} disabled={exportState.isExporting}>
                    {(close) => (
                      <>
                        <button role="menuitem" className="menu__item" onClick={() => { close(); playerRef.current?.exportMp4(); }}>
                          Video (MP4)
                        </button>
                        <button role="menuitem" className="menu__item" onClick={() => { close(); playerRef.current?.exportGif(); }}>
                          GIF
                        </button>
                        <button role="menuitem" className="menu__item" onClick={() => { close(); downloadJson(); }}>
                          Replay data (JSON)
                        </button>
                      </>
                    )}
                  </Menu>
                </div>
              </>
            ) : (
              <>
                <div className="skeleton skeleton--title" />
                <div className="skeleton skeleton--line" style={{ width: "40%" }} />
              </>
            )}
          </div>

          <div className="watch__scoreboard">
            {replay ? <Scoreboard players={players} teams={meta.teams === true} /> : <div className="panel skeleton skeleton--panel" />}
          </div>

          {replay && (
            <section className="watch__details panel" aria-label="Replay details">
              <div className="tabs" role="tablist">
                {[
                  ["match", "Match details"],
                  ["map", "Map details"],
                  ["raw", "Raw data"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    role="tab"
                    id={`tab-${key}`}
                    aria-selected={tab === key}
                    aria-controls={`panel-${key}`}
                    className={`tab${tab === key ? " is-active" : ""}`}
                    onClick={() => setTab(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {tab === "match" && (
                <div className="tab-panel" role="tabpanel" id="panel-match" aria-labelledby="tab-match">
                  <dl className="facts">
                    <dt>Mode</dt>
                    <dd>{modeLabel(meta.mode) ?? "—"}</dd>
                    <dt>Format</dt>
                    <dd>{meta.teams == null ? "—" : meta.teams ? "Teams" : "Free-for-all"}</dd>
                    <dt>Quickplay</dt>
                    <dd>{meta.quickplay ? "Yes" : "No"}</dd>
                    <dt>Rounds</dt>
                    <dd>{meta.rounds ?? "—"}</dd>
                    <dt>Win limit</dt>
                    <dd>{meta.winLimit ?? "—"}</dd>
                    <dt>Length</dt>
                    <dd>
                      {formatDuration(meta.frames) ?? "—"}
                      {meta.frames ? <span className="muted"> ({meta.frames} frames)</span> : null}
                    </dd>
                    <dt>Seed</dt>
                    <dd className="mono">{meta.seed ?? "—"}</dd>
                  </dl>

                  {players.length > 0 && (
                    <div className="table-wrap">
                      <table className="slots">
                        <caption className="visually-hidden">Player slots</caption>
                        <thead>
                          <tr>
                            <th scope="col">Slot</th>
                            <th scope="col">Player</th>
                            <th scope="col">Team</th>
                            <th scope="col" className="num">Level</th>
                            <th scope="col" className="num">Ping</th>
                          </tr>
                        </thead>
                        <tbody>
                          {players.map((p) => (
                            <tr key={p.slot}>
                              <td className="tabular">{p.slot}</td>
                              <td>
                                {p.username} {p.guest && <GuestBadge />}
                              </td>
                              <td>{teamLabel(p.team) ?? "—"}</td>
                              <td className="num tabular">{p.level}</td>
                              <td className="num tabular">{p.ping != null ? `${p.ping} ms` : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {tab === "map" && (
                <div className="tab-panel" role="tabpanel" id="panel-map" aria-labelledby="tab-map">
                  <dl className="facts">
                    <dt>Name</dt>
                    <dd>{meta.mapName ?? "—"}</dd>
                    <dt>Author</dt>
                    <dd>{meta.mapAuthor ?? "—"}</dd>
                    <dt>Map ID</dt>
                    <dd className="mono">
                      {meta.mapId != null ? (
                        <a className="link" href={searchUrl({ ...SEARCH_DEFAULTS, q: String(meta.mapId), scope: "mapid" })} onClick={(e) => goSearch(e, { q: String(meta.mapId), scope: "mapid" })}>
                          {meta.mapId}
                        </a>
                      ) : (
                        "—"
                      )}
                    </dd>
                    <dt>Version</dt>
                    <dd>{meta.mapVersion ?? "—"}</dd>
                    <dt>Votes</dt>
                    <dd>
                      {meta.mapVotesUp != null
                        ? `${meta.mapVotesUp.toLocaleString()} up · ${(meta.mapVotesDown ?? 0).toLocaleString()} down`
                        : "—"}
                    </dd>
                    <dt>Published</dt>
                    <dd>{meta.mapPublished == null ? "—" : meta.mapPublished ? "Yes" : "No"}</dd>
                    <dt>Remix of</dt>
                    <dd>
                      {meta.remixOf ? (
                        <a className="link" href={searchUrl({ ...SEARCH_DEFAULTS, q: String(meta.remixOf.id), scope: "mapid" })} onClick={(e) => goSearch(e, { q: String(meta.remixOf.id), scope: "mapid" })}>
                          {meta.remixOf.name ?? `#${meta.remixOf.id}`}
                          {meta.remixOf.author ? ` by ${meta.remixOf.author}` : ""}
                        </a>
                      ) : (
                        "—"
                      )}
                    </dd>
                  </dl>
                </div>
              )}

              {tab === "raw" && (
                <div className="tab-panel" role="tabpanel" id="panel-raw" aria-labelledby="tab-raw">
                  <div className="raw-actions">
                    <button className="btn" onClick={copyJson}>
                      Copy JSON
                    </button>
                    <button className="btn" onClick={downloadJson}>
                      Download JSON
                    </button>
                  </div>
                  <pre className="raw-json">{JSON.stringify(replay.decoded, null, 2)}</pre>
                </div>
              )}
            </section>
          )}

          <aside className="watch__related" aria-labelledby="related-heading">
            {related && related.length > 0 && (
              <>
                <h2 className="section-title" id="related-heading">
                  More on this map
                </h2>
                <ul className="cards cards--list">
                  {related.map((item) => (
                    <ReplayCard key={`${item.cycle}:${item.id}`} item={item} compact />
                  ))}
                </ul>
                <a
                  className="link"
                  href={searchUrl({ ...SEARCH_DEFAULTS, q: String(replay.mapid), scope: "mapid" })}
                  onClick={(e) => goSearch(e, { q: String(replay.mapid), scope: "mapid" })}
                >
                  All replays on this map ›
                </a>
              </>
            )}
          </aside>
        </div>
      )}
      {toast}
    </main>
  );
}
