// server/api-routes.mjs
//
// The actual API logic (search, recent, related, thumbnails, replay fetch),
// factored out of dev-api.mjs so it has exactly one implementation shared by
// both:
//   - server/dev-api.mjs — local dev, its own port, permissive localhost CORS
//   - server/prod-server.mjs — production, same origin as the built
//     frontend, no CORS needed
// Keeping this in one place means a fix or change here applies to both
// automatically, rather than needing to be copy-pasted and kept in sync.
//
// Players come from replay_participants (one row per slot, with bonk.io's
// guest flag; written by ReplayFetcher). Registered usernames are unique and
// permanent, guest names are not, so name matching defaults to registered
// players only. Replays the participants backfill hasn't reached yet fall
// back to the older replay_players names (guest status unknown).
import zlib from "node:zlib";
import { promisify } from "node:util";
import { decodeStoredReplay } from "./codec.js";
import { renderMapThumbnailSvg } from "./map-render/renderMapThumbnailSvg.mjs";
import { registerPlayerRoutes } from "./player-routes.mjs";
import { registerSyncRoutes, ensurePlayerIds } from "./sync-routes.mjs";
import { rulesSql } from "./replay-rules.mjs";
import { parseRules } from "../shared/replayQuery.js";

const gunzip = promisify(zlib.gunzip);

const PAGE_SIZE = 20;
const COUNT_CAP = 10000; // counts stop here; the UI shows "10,000+"
const MAX_ADDED_PLAYERS = 5;
const MODES = new Set(["b", "ar", "ard", "sp", "v", "f", "bs"]);

// Maps DB/driver errors to a safe, plain-language message for the client.
// Never forward err.message directly — it can contain SQLSTATE text,
// column/table names, parameter counts, etc., which are meaningless (or
// worse, informative to an attacker) for an end user. The real error is
// still logged server-side by each route before calling this.
function sendDbError(res, err, fallbackMessage) {
  let message = fallbackMessage;
  let status = 500;

  switch (err.code) {
    // invalid_text_representation — e.g. a value that can't be cast/compared
    // the way the query expects (bad id format, etc.)
    case "22P02":
      message = "That doesn't look like a valid value for this request.";
      status = 400;
      break;
    // indeterminate_datatype — Postgres couldn't infer a type for a bound
    // parameter; almost always a query-construction bug, not bad user input.
    case "42P18":
      message = "That request couldn't be understood. Try again or use a different search.";
      status = 400;
      break;
    // query_canceled — e.g. statement_timeout hit on an expensive query.
    case "57014":
      message = "That took too long to run. Try a more specific search.";
      status = 504;
      break;
    // connection-related — DB unreachable, pool exhausted, etc.
    case "ECONNREFUSED":
    case "ETIMEDOUT":
    case "53300":
      message = "This is temporarily unavailable. Please try again shortly.";
      status = 503;
      break;
  }

  return res.status(status).json({ error: message });
}

// ─── Query building ─────────────────────────────────────────────────────────

// Escapes LIKE metacharacters so "%" and "_" in a username match literally.
// Backslash first so the escapes we add aren't escaped again. Paired with
// `ESCAPE '\'` on every LIKE below.
const likeSafe = (s) => s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");

const isDigits = (s) => /^\d{1,18}$/.test(s);

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * Builds the WHERE clause for a search from the request's query string.
 * Returns null when the search can't match anything (e.g. a non-numeric
 * replay ID), so the route can answer without touching the database.
 *
 * Usernames are not trimmed: bonk.io names can have meaningful leading or
 * trailing spaces. Only the numeric fields are.
 */
function buildSearch(query) {
  const q = String(query.q ?? "");
  const scope = ["all", "username", "id", "mapid", "mapname", "dbid"].includes(query.scope)
    ? query.scope
    : "all";
  const guests = ["exclude", "include", "only"].includes(query.guests) ? query.guests : "exclude";
  const match = query.match === "any" ? "any" : "all";
  const sort = query.sort === "oldest" ? "oldest" : "newest";
  const added = toArray(query.with)
    .map(String)
    .filter((s) => s.length > 0)
    .slice(0, MAX_ADDED_PLAYERS);
  const mode = MODES.has(String(query.mode ?? "")) ? String(query.mode) : null;
  const mapFilter = String(query.map ?? "").trim();
  const cycle = isDigits(String(query.cycle ?? "")) ? Number(query.cycle) : null;
  const rules = parseRules(query);

  const params = [];
  const p = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = [];

  const guestCond =
    guests === "exclude" ? "AND NOT rp.guest" : guests === "only" ? "AND rp.guest" : "";

  const playerContains = (text) => `EXISTS (
      SELECT 1 FROM replay_participants rp
      WHERE rp.cycle = r.cycle AND rp.replay_id = r.id
        AND lower(rp.username) LIKE '%' || lower(${p(likeSafe(text))}) || '%' ESCAPE '\\'
        ${guestCond}
    )`;
  const playerExact = (name) => `EXISTS (
      SELECT 1 FROM replay_participants rp
      WHERE rp.cycle = r.cycle AND rp.replay_id = r.id
        AND lower(rp.username) = lower(${p(name)})
        ${guestCond}
    )`;
  // A registered player whose bonk.io account ID is `n` (player_ids comes
  // from bonkverse.io, server/sync-routes.mjs).
  const playerDbid = (n) => `EXISTS (
      SELECT 1 FROM player_ids pi
      JOIN replay_participants rp ON lower(rp.username) = lower(pi.username)
      WHERE pi.dbid = ${n}::bigint AND rp.cycle = r.cycle AND rp.replay_id = r.id AND NOT rp.guest
    )`;
  const mapNameContains = (text) => `EXISTS (
      SELECT 1 FROM maps mn
      WHERE mn.mapid = r.mapid
        AND mn.name ILIKE '%' || ${p(likeSafe(text))} || '%' ESCAPE '\\'
    )`;

  // ── Main query ──
  if (q.length > 0) {
    const qt = q.trim();
    switch (scope) {
      case "username":
        where.push(playerContains(q));
        break;
      case "id":
        if (!isDigits(qt)) return null;
        where.push(`r.id = ${p(qt)}::bigint`);
        break;
      case "mapid":
        if (!isDigits(qt)) return null;
        where.push(`r.mapid = ${p(qt)}::bigint`);
        break;
      case "mapname":
        where.push(mapNameContains(q));
        break;
      case "dbid":
        if (!isDigits(qt)) return null;
        where.push(playerDbid(p(qt)));
        break;
      default: {
        const ors = [playerContains(q), mapNameContains(q)];
        if (isDigits(qt)) {
          const n = p(qt);
          ors.unshift(`r.id = ${n}::bigint`, `r.mapid = ${n}::bigint`, playerDbid(n));
        }
        where.push(`(${ors.join(" OR ")})`);
      }
    }
  }

  // ── Filters ──
  if (added.length > 0) {
    const conds = added.map(playerExact);
    where.push(`(${conds.join(match === "any" ? " OR " : " AND ")})`);
  }
  if (mode) where.push(`rm.mode = ${p(mode)}`);
  if (mapFilter) {
    where.push(isDigits(mapFilter) ? `r.mapid = ${p(mapFilter)}::bigint` : mapNameContains(mapFilter));
  }
  if (cycle != null) where.push(`r.cycle = ${p(cycle)}`);

  // ── Advanced-search rules (shared/replayQuery.js, server/replay-rules.mjs) ──
  const ruleCond = rulesSql(rules, p, guestCond);
  if (ruleCond) where.push(ruleCond);

  return {
    where: where.length ? where.join("\n AND ") : "TRUE",
    params,
    order: sort === "oldest" ? OLDEST : NEWEST,
    echo: { q, scope, guests, match, sort, with: added, mode, map: mapFilter, cycle, rules },
  };
}

// Replay key → everything a result row or card shows: map name, match
// metadata, estimated date and the player lineup. Expects a CTE named
// `keys(cycle, id, mapid, fetched_at)` holding just one page of keys.
const ENRICH_SQL = `
  SELECT
    k.id::text AS id,
    k.cycle,
    k.mapid::text AS mapid,
    m.name AS mapname,
    k.fetched_at,
    to_char(rcd.day, 'YYYY-MM-DD') AS estimated_day,
    rm.mode,
    rm.teams,
    rm.frames,
    rm.player_count,
    COALESCE(parts.list, legacy.list, '[]'::json) AS players
  FROM keys k
  LEFT JOIN LATERAL (
    SELECT name FROM maps m2 WHERE m2.mapid = k.mapid ORDER BY m2.version DESC LIMIT 1
  ) m ON true
  LEFT JOIN replay_cycle_days rcd
    ON rcd.cycle = k.cycle AND k.id BETWEEN rcd.first_id AND rcd.last_id
  LEFT JOIN replay_meta rm
    ON rm.cycle = k.cycle AND rm.replay_id = k.id
  LEFT JOIN LATERAL (
    SELECT json_agg(json_build_object(
             'slot', rp.slot, 'username', rp.username, 'guest', rp.guest,
             'team', rp.team, 'score', rp.score, 'level', rp.level
           ) ORDER BY rp.slot) AS list
    FROM replay_participants rp
    WHERE rp.cycle = k.cycle AND rp.replay_id = k.id
  ) parts ON true
  LEFT JOIN LATERAL (
    -- Not backfilled yet: older username-only index, guest status unknown
    SELECT json_agg(json_build_object('username', rpl.username, 'guest', null)
             ORDER BY rpl.username) AS list
    FROM replay_players rpl
    WHERE parts.list IS NULL AND rpl.cycle = k.cycle AND rpl.replay_id = k.id
  ) legacy ON true
`;

const NEWEST = "cycle DESC, id DESC";
const OLDEST = "cycle ASC, id ASC";

async function enrichKeys(pool, keysSql, params, order = NEWEST) {
  const result = await pool.query(
    `WITH keys AS (${keysSql}) ${ENRICH_SQL} ORDER BY ${order.replace(/(cycle|id)/g, "k.$1")}`,
    params
  );
  return result.rows;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export function registerApiRoutes(app, pool) {
  // Player profiles (server/player-routes.mjs)
  registerPlayerRoutes(app, pool, { enrichKeys, sendDbError });
  // Name ↔ DBID sync with bonkverse.io (server/sync-routes.mjs)
  registerSyncRoutes(app, pool, { sendDbError });
  ensurePlayerIds(pool).catch((err) => console.warn("player_ids table not ready yet:", err.message));

  // One replay's data for the watch page: the decoded replay plus the facts
  // that only live in the database (dates, map name).
  app.get("/api/replay/:id", async (req, res) => {
    const { id } = req.params;
    const cycle = req.query.cycle ? Number(req.query.cycle) : null;

    if (!isDigits(String(id)) || (cycle != null && !Number.isInteger(cycle))) {
      return res.status(400).json({ error: "That doesn't look like a valid replay." });
    }

    try {
      const result = await pool.query(
        `
        SELECT r.cycle, r.id, r.mapid, r.replaydata, r.fetched_at,
               to_char(rcd.day, 'YYYY-MM-DD') AS estimated_day
        FROM replays r
        LEFT JOIN replay_cycle_days rcd
          ON rcd.cycle = r.cycle AND r.id BETWEEN rcd.first_id AND rcd.last_id
        WHERE r.id = $1::bigint
          AND ($2::int IS NULL OR r.cycle = $2::int)
        ORDER BY r.cycle DESC
        LIMIT 1
        `,
        [id, cycle]
      );

      if (!result.rows.length) {
        return res.status(404).json({ error: `Replay ${id} wasn't found.` });
      }

      const row = result.rows[0];
      const decoded = decodeStoredReplay(row.replaydata);

      return res.json({
        cycle: row.cycle,
        id: String(row.id),
        mapid: row.mapid != null ? String(row.mapid) : null,
        fetched_at: row.fetched_at,
        estimated_day: row.estimated_day,
        decoded,
      });
    } catch (err) {
      console.error("GET /api/replay/:id failed:", err);
      return sendDbError(res, err, "We couldn't load that replay. Please try again.");
    }
  });

  // ─── Map thumbnails ─────────────────────────────────────────────────────
  //
  // Real SVG markup (see server/map-render/renderMapThumbnailSvg.mjs)
  // rendered from the already-populated `maps.mapdata` (physics + capZones,
  // gzip'd JSON — see the scraper's compressJsonForStorage). One thumbnail
  // per mapid (latest version), not per replay, and cached for an hour.
  app.get("/api/map/:mapid/thumbnail.svg", async (req, res) => {
    const mapid = req.params.mapid;
    if (!isDigits(String(mapid))) return res.status(400).send("Bad map id");

    try {
      const result = await pool.query(
        `SELECT mapdata FROM maps WHERE mapid = $1::bigint ORDER BY version DESC LIMIT 1`,
        [mapid]
      );

      if (!result.rows.length || !result.rows[0].mapdata) {
        return res.status(404).send("No map data for this mapid");
      }

      const buf = await gunzip(result.rows[0].mapdata);
      const mapData = JSON.parse(buf.toString());

      const svg = renderMapThumbnailSvg(mapData);

      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=3600");
      return res.send(svg);
    } catch (err) {
      console.error("GET /api/map/:mapid/thumbnail.svg failed:", err);
      return res.status(500).send("Thumbnail generation failed");
    }
  });

  // ─── Search ─────────────────────────────────────────────────────────────
  //
  // Query string:
  //   q        text to search for
  //   scope    all | username | id | mapid | mapname | dbid (a player's
  //            bonk.io account ID; "all" with a number matches it too)
  //   guests   exclude (default) | include | only — applies to name matches
  //   with     an added player (repeat for several); exact name, same replay
  //   match    all (default: every added player) | any (at least one)
  //   mode     bonk.io mode code (b, ar, ard, sp, v, f, bs)
  //   f0 o0 v0 w0 k0, c1 f1 …  advanced-search rules (shared/replayQuery.js)
  //   map      map name contains, or a map ID
  //   cycle    cycle number
  //   sort     newest (default) | oldest
  //   page     1-based
  //
  // Finds the page of matching replay keys first (index-friendly), then
  // enriches just those rows. The count stops at COUNT_CAP so a very broad
  // search can't scan the whole archive just to number its pages.
  app.get("/api/search", async (req, res) => {
    const pageParam = parseInt(req.query.page, 10);
    const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.min(pageParam, 500) : 1;
    const offset = (page - 1) * PAGE_SIZE;

    const built = buildSearch(req.query);
    const empty = { results: [], page: 1, pageSize: PAGE_SIZE, total: 0, totalPages: 0, capped: false };

    if (!built) return res.json({ ...empty, query: null });

    const hasCriteria =
      built.echo.q.length > 0 ||
      built.echo.with.length > 0 ||
      built.echo.mode ||
      built.echo.map ||
      built.echo.cycle != null ||
      built.echo.rules.length > 0;
    if (!hasCriteria) return res.json({ ...empty, query: built.echo });

    try {
      const fromWhere = `
        FROM replays r
        LEFT JOIN replay_meta rm ON rm.cycle = r.cycle AND rm.replay_id = r.id
        WHERE ${built.where}
      `;

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM (SELECT 1 ${fromWhere} LIMIT ${COUNT_CAP + 1}) s`,
        built.params
      );
      const rawCount = countResult.rows[0]?.count ?? 0;
      const capped = rawCount > COUNT_CAP;
      const total = Math.min(rawCount, COUNT_CAP);
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

      const n = built.params.length;
      const rows = await enrichKeys(
        pool,
        `SELECT r.cycle, r.id, r.mapid, r.fetched_at
         ${fromWhere}
         ORDER BY ${built.order.replace(/(cycle|id)/g, "r.$1")}
         LIMIT $${n + 1} OFFSET $${n + 2}`,
        [...built.params, PAGE_SIZE, offset],
        built.order
      );

      // Whose DBID this is, so the page can say so and highlight them.
      let dbidPlayer = null;
      const qt = built.echo.q.trim();
      if ((built.echo.scope === "dbid" || built.echo.scope === "all") && isDigits(qt)) {
        const named = await pool.query(`SELECT username FROM player_ids WHERE dbid = $1::bigint`, [qt]);
        dbidPlayer = named.rows[0]?.username ?? null;
      }

      return res.json({
        results: rows,
        page,
        pageSize: PAGE_SIZE,
        total,
        totalPages,
        capped,
        query: { ...built.echo, dbidPlayer },
      });
    } catch (err) {
      console.error("GET /api/search failed:", err);
      return sendDbError(res, err, "Something went wrong running that search. Please try again.");
    }
  });

  // ─── Recent replays (homepage feed) ─────────────────────────────────────
  app.get("/api/recent", async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 9, 1), 24);
    try {
      const rows = await enrichKeys(
        pool,
        `SELECT r.cycle, r.id, r.mapid, r.fetched_at
         FROM replays r
         ORDER BY r.cycle DESC, r.id DESC
         LIMIT $1`,
        [limit]
      );
      res.setHeader("Cache-Control", "public, max-age=30");
      return res.json({ results: rows });
    } catch (err) {
      console.error("GET /api/recent failed:", err);
      return sendDbError(res, err, "We couldn't load recent replays.");
    }
  });

  // ─── Live collector status (homepage countdown) ─────────────────────────
  //
  // What ReplayFetcher is doing and when it will next ask bonk.io for
  // replays (it records this before every wait), plus the newest stored
  // replay. With since_cycle/since_id, also counts replays added after that
  // key, so the page can say "12 new replays added". server_now lets the
  // browser correct for its own clock being off.
  app.get("/api/status", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const sinceCycle = String(req.query.since_cycle ?? "");
    const sinceId = String(req.query.since_id ?? "");
    const hasSince = isDigits(sinceCycle) && isDigits(sinceId);

    try {
      let scraper = null;
      try {
        const st = await pool.query(
          `SELECT status, next_fetch_at, status_at, last_run_added, last_run_at
           FROM scraper_state WHERE id = 1`
        );
        scraper = st.rows[0] ?? null;
      } catch (err) {
        // 42703 = column doesn't exist: the scraper with status reporting
        // isn't deployed yet. Answer without it instead of failing.
        if (err.code !== "42703") throw err;
      }

      const latest = await pool.query(
        `SELECT cycle, id::text AS id FROM replays ORDER BY cycle DESC, id DESC LIMIT 1`
      );

      let addedSince = null;
      if (hasSince) {
        const added = await pool.query(
          `SELECT COUNT(*)::int AS n FROM (
             SELECT 1 FROM replays
             WHERE (cycle, id) > ($1::int, $2::bigint)
             LIMIT 5000
           ) s`,
          [sinceCycle, sinceId]
        );
        addedSince = added.rows[0].n;
      }

      return res.json({
        server_now: new Date().toISOString(),
        status: scraper?.status ?? null,
        next_fetch_at: scraper?.next_fetch_at ?? null,
        status_at: scraper?.status_at ?? null,
        last_run_added: scraper?.last_run_added ?? null,
        last_run_at: scraper?.last_run_at ?? null,
        latest: latest.rows[0] ?? null,
        added_since: addedSince,
      });
    } catch (err) {
      console.error("GET /api/status failed:", err);
      return sendDbError(res, err, "We couldn't load the collector status.");
    }
  });

  // ─── More on this map (watch page) ──────────────────────────────────────
  app.get("/api/related", async (req, res) => {
    const mapid = String(req.query.mapid ?? "");
    const id = String(req.query.id ?? "");
    const cycle = String(req.query.cycle ?? "");
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 4, 1), 12);

    if (!isDigits(mapid)) return res.json({ results: [] });

    try {
      const rows = await enrichKeys(
        pool,
        `SELECT r.cycle, r.id, r.mapid, r.fetched_at
         FROM replays r
         WHERE r.mapid = $1::bigint
           AND NOT (r.id::text = $2 AND r.cycle::text = $3)
         ORDER BY r.cycle DESC, r.id DESC
         LIMIT $4`,
        [mapid, id, cycle, limit]
      );
      return res.json({ results: rows });
    } catch (err) {
      console.error("GET /api/related failed:", err);
      return sendDbError(res, err, "We couldn't load related replays.");
    }
  });
}

// Shared pool factory, also used by both servers — same connection-pooling
// rationale as before (see dev-api.mjs git history / prior conversation):
// avoids a fresh TCP+TLS+auth handshake on every single request.
export function createPool(Pool) {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  });

  pool.on("error", (err) => {
    console.error("Unexpected error on idle DB client:", err);
  });

  return pool;
}
