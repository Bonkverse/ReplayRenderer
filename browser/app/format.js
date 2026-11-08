// Shared display helpers: match language (modes, teams), dates, durations,
// and reading facts out of a decoded replay.

export const STEPS_PER_SEC = 30;

// bonk.io's game-mode short codes → display names.
export const MODE_LABELS = {
  b: "Classic",
  ar: "Arrows",
  ard: "Death Arrows",
  sp: "Grapple",
  v: "VTOL",
  f: "Football",
  bs: "Simple",
};

export function modeLabel(code) {
  if (!code) return null;
  return MODE_LABELS[code] ?? code; // unknown codes fall back to the raw code
}

// bonk.io's team slots and colors, from the decompiled client
// (MapRenderer.doCapZone()). Team 1 is the free-for-all sentinel.
export const TEAM_COLORS = {
  1: "#94a3b8",
  2: "#f44336",
  3: "#2196f3",
  4: "#4caf50",
  5: "#ffeb3b",
};
export const TEAM_LABELS = { 2: "Red", 3: "Blue", 4: "Green", 5: "Yellow" };

export const teamColor = (team) => TEAM_COLORS[team] ?? TEAM_COLORS[1];
export const teamLabel = (team) => TEAM_LABELS[team] ?? null;

export const initials = (name) => (name || "?").slice(0, 2).toUpperCase();

// Frames (30 per second) → "0:15"
export function formatDuration(frames) {
  if (!Number.isFinite(frames) || frames <= 0) return null;
  const s = Math.round(frames / STEPS_PER_SEC);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Explainer for estimated dates (public/about/dates.html).
export const ABOUT_DATES_URL = "/about/dates.html";
export const ESTIMATED_DATE_NOTE =
  "Estimated from the replay ID, using cycle date estimates by Salama & " +
  "Legendboss123 and Bonkverse's own upload patterns. Usually within a few days.";

/**
 * A replay's date for display. Replays collected after the fact (cycle 5,
 * the first days of cycle 6) carry an `estimated_day` ('YYYY-MM-DD') and are
 * shown as an approximate week; everything else uses the real fetch time.
 *
 * @returns {{ text: string, estimated: boolean }}
 */
export function replayDate(item, { short = false } = {}) {
  const opts = short
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", year: "numeric" };

  if (item?.estimated_day) {
    const [y, m, d] = item.estimated_day.split("-").map(Number);
    const day = new Date(y, m - 1, d); // local date, no timezone shift
    const monday = new Date(day);
    monday.setDate(day.getDate() - ((day.getDay() + 6) % 7));
    return {
      text: `≈ week of ${monday.toLocaleDateString(undefined, { ...opts, year: "numeric" })}`,
      estimated: true,
    };
  }
  if (item?.fetched_at) {
    return { text: new Date(item.fetched_at).toLocaleDateString(undefined, opts), estimated: false };
  }
  return { text: "Unknown date", estimated: false };
}

// ─── Decoded replay → display data ─────────────────────────────────────────

export function extractMeta(decoded) {
  const ss = decoded?.startingState ?? {};
  const mm = ss.mm ?? {};
  const gs = decoded?.gameSettings ?? {};

  return {
    mapName: decoded?.mn ?? mm.n ?? null,
    mapAuthor: decoded?.ma ?? mm.a ?? null,
    mapId: mm.dbid ?? null,
    mapVersion: mm.dbv ?? null,
    mapVotesUp: typeof mm.vu === "number" ? mm.vu : null,
    mapVotesDown: typeof mm.vd === "number" ? mm.vd : null,
    mapPublished: typeof mm.pub === "boolean" ? mm.pub : null,
    remixOf: mm.rxid > 0 ? { id: mm.rxid, name: mm.rxn || null, author: mm.rxa || null } : null,
    mode: gs.mo ?? null,
    teams: typeof gs.tea === "boolean" ? gs.tea : null,
    winLimit: gs.wl ?? null,
    quickplay: !!gs.q,
    seed: ss.seed ?? null,
    rounds: ss.rc ?? null,
    scores: Array.isArray(ss.scores) ? ss.scores : null,
    frames: decoded?.es ?? null,
  };
}

/**
 * One entry per occupied slot. startingState.scores is indexed by slot in
 * free-for-all but by team number in team modes (red = 2, blue = 3), so in
 * team games a player's score is their team's.
 */
export function extractPlayers(decoded) {
  const scores = decoded?.startingState?.scores;
  const teamsMode = decoded?.gameSettings?.tea === true;

  return (decoded?.playerArray ?? [])
    .map((p, i) => {
      if (!p || !p.userName) return null;
      const raw = !Array.isArray(scores) ? null : teamsMode ? scores[p.team] : scores[i];
      return {
        slot: i,
        username: p.userName,
        level: p.level ?? 0,
        team: p.team ?? null,
        ping: p.ping ?? null,
        guest: !!p.guest,
        avatar: p.avatar ?? null,
        score: Number.isFinite(raw) ? raw : null,
      };
    })
    .filter(Boolean);
}

/**
 * Short lineup text for a result row: "A vs B", "A, B, C +2".
 * `players` are API participant objects ({ username, guest }).
 */
export function lineup(players, max = 3) {
  const names = (players ?? []).map((p) => p.username);
  if (names.length === 0) return "";
  if (names.length === 2) return `${names[0]} vs ${names[1]}`;
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} +${names.length - max}` : shown;
}
