import React, { useEffect, useRef, useState } from "react";
import { thumbnailUrl } from "./api.js";
import { navigate, watchUrl, saveListPosition } from "./router.js";
import {
  modeLabel,
  formatDuration,
  replayDate,
  lineup,
  ESTIMATED_DATE_NOTE,
} from "./format.js";

// Main-site links (the shared Bonkverse header). Absolute URLs: the replay
// site is its own service on replays.bonkverse.io.
const SITE = "https://bonkverse.io";
export const LINKS = {
  home: `${SITE}/`,
  skins: `${SITE}/search/`,
  community: `${SITE}/players_search/players/`,
};

export const SCOPES = [
  ["all", "All"],
  ["username", "Username"],
  ["id", "Replay ID"],
  ["mapid", "Map ID"],
  ["mapname", "Map name"],
];
export const scopeLabel = (v) => SCOPES.find(([k]) => k === v)?.[1] ?? "All";

// ─── Global header ─────────────────────────────────────────────────────────

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <a className="brand" href={LINKS.home}>
          <img className="brand__mark" src="/brand/planet.png" alt="" width="32" height="32" />
          <span className="brand__name">Bonkverse</span>
        </a>
        <nav className="site-nav" aria-label="Bonkverse">
          <a href={LINKS.skins}>Skins</a>
          <a
            href="/"
            aria-current="page"
            className="is-active"
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            Replays
          </a>
          <a className="site-nav__community" href={LINKS.community}>
            Community
          </a>
        </nav>
      </div>
    </header>
  );
}

// ─── Search box ────────────────────────────────────────────────────────────

/**
 * One query field and one scope control per breakpoint: chips on wider
 * screens, a labelled select on phones (CSS shows one or the other).
 */
export function SearchBox({
  initialQuery = "",
  initialScope = "all",
  onSubmit,
  onScopeChange,
  filterCount = 0,
  onOpenFilters,
  filtersButtonRef,
  autoFocus = false,
  large = false,
}) {
  const [q, setQ] = useState(initialQuery);
  const [scope, setScope] = useState(initialScope);

  useEffect(() => setQ(initialQuery), [initialQuery]);
  useEffect(() => setScope(initialScope), [initialScope]);

  function pickScope(next) {
    setScope(next);
    onScopeChange?.(next, q);
  }

  return (
    <form
      className={`search${large ? " search--large" : ""}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(q, scope);
      }}
    >
      <div className="search__field">
        <svg className="search__icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search players, maps, or replay IDs"
          aria-label="Search replays"
          autoFocus={autoFocus}
          enterKeyHint="search"
        />
        <button className="btn btn--primary" type="submit">
          Search
        </button>
      </div>

      <div className="search__controls">
        <div className="chips search__scopes" role="radiogroup" aria-label="Search in">
          {SCOPES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              className={`chip${scope === value ? " is-active" : ""}`}
              onClick={() => pickScope(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <label className="search__scope-select">
          <span>Scope:</span>
          <select value={scope} onChange={(e) => pickScope(e.target.value)}>
            {SCOPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        {onOpenFilters && (
          <button
            type="button"
            ref={filtersButtonRef}
            className={`chip chip--filters${filterCount ? " is-active" : ""}`}
            onClick={onOpenFilters}
            aria-haspopup="dialog"
          >
            Filters{filterCount ? ` · ${filterCount}` : ""}
          </button>
        )}
      </div>
    </form>
  );
}

// ─── Thumbnails, avatars ───────────────────────────────────────────────────

export function MapThumbnail({ mapid, className = "" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [mapid]);

  if (!mapid || failed) {
    return (
      <div className={`thumb thumb--empty ${className}`} aria-hidden="true">
        <span>No preview</span>
      </div>
    );
  }
  return (
    <img
      className={`thumb ${className}`}
      src={thumbnailUrl(mapid)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

// Real bonk.io skin via skin-render.js (window.renderBonkAvatar, loaded in
// index.html). Falls back to initials on the team colour if there's no
// avatar or the render fails, so a bad avatar never blocks the list.
export function PlayerAvatar({ avatar, initialsText, color, size = 40 }) {
  const canvasRef = useRef(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    setRendered(false);
    if (!avatar || typeof window.renderBonkAvatar !== "function") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    window
      .renderBonkAvatar(canvas, avatar, Math.round(size * dpr))
      .then(() => !cancelled && setRendered(true))
      .catch((err) => console.warn("Avatar render failed:", err));
    return () => {
      cancelled = true;
    };
  }, [avatar, size]);

  return (
    <div
      className="avatar"
      style={{ background: rendered ? "transparent" : color, width: size, height: size }}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        style={{ display: rendered ? "block" : "none", width: size, height: size }}
      />
      {!rendered && <span>{initialsText}</span>}
    </div>
  );
}

export function GuestBadge() {
  return (
    <span className="badge" title="Played as a guest (not a registered account)">
      guest
    </span>
  );
}

// ─── Result row (search) and card (home, related) ──────────────────────────

const lower = (s) => (s ?? "").toLocaleLowerCase();

/** Which players in this replay matched the search, for highlighting. */
function matchedNames(item, search) {
  if (!search) return new Set();
  const out = new Set();
  const q = lower(search.q);
  const added = (search.with ?? []).map(lower);
  for (const p of item.players ?? []) {
    const n = lower(p.username);
    const nameScope = search.scope === "username" || search.scope === "all";
    if ((nameScope && q && n.includes(q)) || added.includes(n)) out.add(p.username);
  }
  return out;
}

function openReplay(e, item) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // new tab
  e.preventDefault();
  saveListPosition(`${item.cycle}:${item.id}`);
  // fromList lets the watch page's back link use real history (restoring
  // the list's scroll position and focus) instead of a fresh navigation.
  navigate(watchUrl(item), { state: { fromList: true } });
}

function DateText({ item, short }) {
  const d = replayDate(item, { short });
  return d.estimated ? <span title={ESTIMATED_DATE_NOTE}>{d.text}</span> : <span>{d.text}</span>;
}

export function ReplayRow({ item, search }) {
  const matched = matchedNames(item, search);
  const players = item.players ?? [];
  const duration = formatDuration(item.frames);
  const mode = modeLabel(item.mode);
  const shown = players.slice(0, 4);

  return (
    <li className="row" data-key={`${item.cycle}:${item.id}`}>
      <a className="row__link" href={watchUrl(item)} onClick={(e) => openReplay(e, item)}>
        <MapThumbnail mapid={item.mapid} className="row__thumb" />
        <div className="row__body">
          <h3 className="row__title">
            <span className="row__map">{item.mapname || "Unknown map"}</span>
            <span className="row__id"> · #{item.id}</span>
          </h3>
          <p className="row__players">
            {shown.length === 0 && <span className="muted">No player data</span>}
            {shown.map((p, i) => (
              <React.Fragment key={`${p.slot ?? p.username}-${i}`}>
                {i > 0 && <span className="muted">{players.length === 2 ? " vs " : ", "}</span>}
                <span className={matched.has(p.username) ? "is-match" : undefined}>{p.username}</span>
                {p.guest && <GuestBadge />}
              </React.Fragment>
            ))}
            {players.length > shown.length && <span className="muted"> +{players.length - shown.length}</span>}
            {mode && <span className="muted"> · {mode}</span>}
            {duration && <span className="muted"> · {duration}</span>}
          </p>
          <p className="row__meta">
            <DateText item={item} /> · Cycle {item.cycle}
            {players.length > 0 && ` · ${players.length} player${players.length === 1 ? "" : "s"}`}
            {item.mapid && <span className="row__mapid"> · Map #{item.mapid}</span>}
          </p>
        </div>
      </a>
    </li>
  );
}

export function ReplayCard({ item, compact = false }) {
  return (
    <li className={`card${compact ? " card--compact" : ""}`}>
      <a className="card__link" href={watchUrl(item)} onClick={(e) => openReplay(e, item)}>
        <MapThumbnail mapid={item.mapid} className="card__thumb" />
        <div className="card__body">
          <h3 className="card__title">{item.mapname || "Unknown map"}</h3>
          <p className="card__meta">
            #{item.id} · {compact ? <DateText item={item} short /> : `Cycle ${item.cycle}`}
          </p>
          {!compact && item.players?.length > 0 && (
            <p className="card__players">{lineup(item.players)}</p>
          )}
        </div>
      </a>
    </li>
  );
}

export function RowSkeleton({ count = 5 }) {
  return (
    <ul className="rows" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li className="row row--skeleton" key={i}>
          <div className="row__link">
            <div className="thumb row__thumb skeleton" />
            <div className="row__body">
              <div className="skeleton skeleton--line" style={{ width: "45%" }} />
              <div className="skeleton skeleton--line" style={{ width: "70%" }} />
              <div className="skeleton skeleton--line" style={{ width: "35%" }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function CardSkeleton({ count = 6 }) {
  return (
    <ul className="cards" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li className="card" key={i}>
          <div className="card__link">
            <div className="thumb card__thumb skeleton" />
            <div className="card__body">
              <div className="skeleton skeleton--line" style={{ width: "60%" }} />
              <div className="skeleton skeleton--line" style={{ width: "40%" }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Pagination({ page, totalPages, onPage, busy }) {
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pages">
      <button className="btn" onClick={() => onPage(page - 1)} disabled={page <= 1 || busy}>
        ‹ Previous
      </button>
      <span className="pagination__label">
        Page {page} of {totalPages.toLocaleString()}
      </span>
      <button className="btn" onClick={() => onPage(page + 1)} disabled={page >= totalPages || busy}>
        Next ›
      </button>
    </nav>
  );
}

// Brief confirmation ("Link copied"), announced to screen readers.
export function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef(null);
  const show = (text) => {
    setMsg(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 2200);
  };
  const node = (
    <div className="toast" role="status" aria-live="polite">
      {msg && <span>{msg}</span>}
    </div>
  );
  return [node, show];
}
