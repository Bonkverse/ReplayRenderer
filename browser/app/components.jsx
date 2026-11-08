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

export function ReplayCard({ item, compact = false, isNew = false }) {
  return (
    <li className={`card${compact ? " card--compact" : ""}${isNew ? " is-new" : ""}`}>
      <a className="card__link" href={watchUrl(item)} onClick={(e) => openReplay(e, item)}>
        <div className="card__media">
          <MapThumbnail mapid={item.mapid} className="card__thumb" />
          {isNew && <span className="card__new">New</span>}
        </div>
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

/**
 * Page numbers to show: always the first and last, the current page and
 * `siblings` on each side, with "…" for the gaps.
 *   pageItems(6, 75, 1) → [1, "…", 5, 6, 7, "…", 75]
 */
export function pageItems(page, total, siblings = 1) {
  const span = siblings * 2 + 1; // pages shown around the current one
  // Few enough pages to show them all
  if (total <= span + 4) return Array.from({ length: total }, (_, i) => i + 1);

  // Keep the same number of slots wherever you are, so buttons don't jump
  let from = page - siblings;
  let to = page + siblings;
  if (page <= siblings + 3) {
    from = 2;
    to = span + 2;
  } else if (page >= total - siblings - 2) {
    from = total - span - 1;
    to = total - 1;
  }

  const items = [1];
  if (from > 2) items.push("…");
  for (let p = from; p <= to; p++) items.push(p);
  if (to < total - 1) items.push("…");
  items.push(total);
  return items;
}

/** "Go to page" box. Keeps its own draft so typing doesn't navigate. */
export function PageJump({ page, totalPages, onPage, busy, compact = false }) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);

  function submit(e) {
    e.preventDefault();
    const n = parseInt(draft, 10);
    if (!Number.isFinite(n)) return setDraft(String(page));
    const target = Math.min(Math.max(1, n), totalPages);
    setDraft(String(target));
    if (target !== page) onPage(target);
  }

  return (
    <form className={`page-jump${compact ? " page-jump--compact" : ""}`} onSubmit={submit}>
      <label>
        <span>{compact ? "Page" : "Go to page"}</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={totalPages}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => !compact && setDraft(String(page))}
          aria-label={`Page number, 1 to ${totalPages}`}
          disabled={busy}
        />
      </label>
      {compact ? (
        <span className="page-jump__of">of {totalPages.toLocaleString()}</span>
      ) : (
        <button className="btn" type="submit" disabled={busy}>
          Go
        </button>
      )}
    </form>
  );
}

/**
 * Full pager: previous / numbered pages with gaps / next, plus a jump box.
 * `capped` means the count stopped at the API's limit, so the last page
 * number is a floor ("500+").
 */
export function Pagination({ page, totalPages, onPage, busy, capped = false }) {
  if (totalPages <= 1) return null;
  const items = pageItems(page, totalPages, 1);

  return (
    <nav className="pagination" aria-label="Pages">
      <div className="pager">
        <button
          className="pager__btn pager__step"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1 || busy}
          aria-label="Previous page"
        >
          ‹<span className="pager__step-text"> Previous</span>
        </button>

        <ol className="pager__pages">
          {items.map((it, i) =>
            it === "…" ? (
              <li key={`gap-${i}`} className="pager__gap" aria-hidden="true">
                …
              </li>
            ) : (
              <li key={it}>
                <button
                  className={`pager__btn${it === page ? " is-current" : ""}`}
                  onClick={() => it !== page && onPage(it)}
                  aria-current={it === page ? "page" : undefined}
                  aria-label={`Page ${it}${it === page ? ", current page" : ""}`}
                  disabled={busy && it !== page}
                >
                  {it.toLocaleString()}
                  {capped && it === totalPages ? "+" : ""}
                </button>
              </li>
            )
          )}
        </ol>

        <button
          className="pager__btn pager__step"
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages || busy}
          aria-label="Next page"
        >
          <span className="pager__step-text">Next </span>›
        </button>
      </div>

      <PageJump page={page} totalPages={totalPages} onPage={onPage} busy={busy} />
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
