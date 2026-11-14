// server/sync-routes.mjs
//
// Private routes for keeping bonkverse.io and the replay archive in step.
// Bonkverse knows bonk.io account IDs (DBIDs) from friend lists and logins;
// replays only carry names. So:
//
//   POST /api/internal/player-ids     Bonkverse sends name ↔ DBID pairs (and
//                                     the estimated join day) into
//                                     player_ids, for "Player's DBID" and
//                                     "A player joined" replay searches.
//   GET  /api/internal/replay-names   Bonkverse reads the registered names
//                                     seen in replays, a batch of replays at a
//                                     time after a cursor, so players who've
//                                     never been in a friend list can be
//                                     found on its Players page. Each name
//                                     also carries the skin it wore last in
//                                     the batch, for profile avatars.
//
// Both need `Authorization: Bearer $BONKVERSE_SYNC_TOKEN` (the same secret
// is set on the bonkverse service). Without the variable the routes answer
// 404, as if they didn't exist.
//
// player_ids is also declared in ReplayFetcher's migrate() with the schema;
// it's created here too (IF NOT EXISTS) so either service can deploy first.
import crypto from "node:crypto";
import express from "express";

const MAX_PLAYERS_PER_POST = 2000;
const NAMES_BATCH_DEFAULT = 5000;
const NAMES_BATCH_MAX = 20000;
const MAX_NAME_LENGTH = 100;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS player_ids (
    dbid        BIGINT      PRIMARY KEY,
    username    TEXT        NOT NULL,
    joined      DATE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_player_ids_lower_username
    ON player_ids (lower(username));
`;

let schemaReady = null;
export function ensurePlayerIds(pool) {
  schemaReady ??= pool.query(SCHEMA_SQL).catch((err) => {
    schemaReady = null; // try again next time
    throw err;
  });
  return schemaReady;
}

function digest(s) {
  return crypto.createHash("sha256").update(String(s)).digest();
}

/** Express middleware: the shared token, compared in constant time. */
function requireSyncToken(req, res, next) {
  const expected = process.env.BONKVERSE_SYNC_TOKEN;
  if (!expected) return res.status(404).json({ error: "Not found" });
  const header = String(req.get("authorization") ?? "");
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given || !crypto.timingSafeEqual(digest(given), digest(expected))) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.setHeader("Cache-Control", "no-store");
  return next();
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Valid, de-duplicated (by DBID, last one wins) rows from a POST body. */
export function cleanPlayerIds(body) {
  const list = Array.isArray(body?.players) ? body.players : null;
  if (!list) return { error: "Send {\"players\": [{\"username\", \"dbid\", \"joined\"}]}." };
  if (list.length > MAX_PLAYERS_PER_POST) return { error: `At most ${MAX_PLAYERS_PER_POST} players per request.` };
  const byId = new Map();
  let skipped = 0;
  for (const row of list) {
    const username = typeof row?.username === "string" ? row.username : "";
    const dbid = Number(row?.dbid);
    const joined = typeof row?.joined === "string" && DAY_RE.test(row.joined) ? row.joined : null;
    if (!username || username.length > MAX_NAME_LENGTH || !Number.isSafeInteger(dbid) || dbid < 1) {
      skipped++;
      continue;
    }
    byId.set(dbid, { dbid, username, joined });
  }
  return { rows: [...byId.values()], skipped };
}

function parseCursor(raw) {
  const m = /^(\d{1,9}):(\d{1,18})$/.exec(String(raw ?? ""));
  return m ? { cycle: Number(m[1]), id: m[2] } : { cycle: 0, id: "0" };
}

export function registerSyncRoutes(app, pool, { sendDbError }) {
  app.post(
    "/api/internal/player-ids",
    requireSyncToken,
    express.json({ limit: "2mb" }),
    async (req, res) => {
      const { rows, skipped, error } = cleanPlayerIds(req.body);
      if (error) return res.status(400).json({ error });
      if (!rows.length) return res.json({ ok: true, received: 0, written: 0, skipped });
      try {
        await ensurePlayerIds(pool);
        const result = await pool.query(
          `INSERT INTO player_ids (dbid, username, joined)
           SELECT * FROM unnest($1::bigint[], $2::text[], $3::date[])
           ON CONFLICT (dbid) DO UPDATE
             SET username = EXCLUDED.username, joined = EXCLUDED.joined, updated_at = NOW()
             WHERE (player_ids.username, player_ids.joined)
                   IS DISTINCT FROM (EXCLUDED.username, EXCLUDED.joined)`,
          [rows.map((r) => String(r.dbid)), rows.map((r) => r.username), rows.map((r) => r.joined)]
        );
        return res.json({ ok: true, received: rows.length, written: result.rowCount, skipped });
      } catch (err) {
        console.error("POST /api/internal/player-ids failed:", err);
        return sendDbError(res, err, "Couldn't save those player IDs.");
      }
    }
  );

  // ?after=cycle:id (exclusive; omit to start at the beginning)
  // &limit=N replays to read this time (default 5000)
  // → { names: [{username, level, games, skin, skin_seen_at}], avatars,
  //     next: "cycle:id", done }
  // `level` is the highest seen in these replays; `games` counts them.
  // `skin` is the hash of the skin in their newest replay of the batch
  // (null if none), and `avatars` maps each hash to its { layers, bc }
  // once, so a skin worn by many names is sent once. `skin_seen_at` is when
  // that replay was collected, or its estimated day (replay_cycle_days) at
  // 00:00 UTC for replays collected after the fact.
  app.get("/api/internal/replay-names", requireSyncToken, async (req, res) => {
    const after = parseCursor(req.query.after);
    const limitParam = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(limitParam, 1), NAMES_BATCH_MAX)
      : NAMES_BATCH_DEFAULT;
    try {
      const { rows } = await pool.query(
        `WITH batch AS (
           SELECT r.cycle, r.id,
                  COALESCE(rcd.day::timestamp AT TIME ZONE 'UTC', r.fetched_at) AS seen_at
           FROM replays r
           LEFT JOIN replay_cycle_days rcd
             ON rcd.cycle = r.cycle AND r.id BETWEEN rcd.first_id AND rcd.last_id
           WHERE (r.cycle, r.id) > ($1::int, $2::bigint)
           ORDER BY r.cycle, r.id
           LIMIT $3
         ),
         seen AS (
           SELECT rp.username, rp.level, rp.avatar_hash, b.cycle, b.id, b.seen_at
           FROM batch b
           JOIN replay_participants rp ON rp.cycle = b.cycle AND rp.replay_id = b.id
           WHERE NOT rp.guest
         ),
         names AS (
           SELECT username, max(level) AS level, count(*)::int AS games,
                  (array_agg(avatar_hash ORDER BY cycle DESC, id DESC)
                     FILTER (WHERE avatar_hash IS NOT NULL))[1] AS skin,
                  (array_agg(seen_at ORDER BY cycle DESC, id DESC)
                     FILTER (WHERE avatar_hash IS NOT NULL))[1] AS skin_seen_at
           FROM seen
           GROUP BY username
         )
         SELECT
           (SELECT count(*)::int FROM batch) AS n,
           (SELECT cycle || ':' || id FROM batch ORDER BY cycle DESC, id DESC LIMIT 1) AS last,
           (SELECT COALESCE(json_agg(names ORDER BY names.username), '[]'::json) FROM names) AS names,
           (SELECT COALESCE(json_object_agg(a.hash, a.avatar), '{}'::json)
              FROM avatars a WHERE a.hash IN (SELECT skin FROM names WHERE skin IS NOT NULL)) AS avatars`,
        [after.cycle, after.id, limit]
      );
      const { n, last, names, avatars } = rows[0];
      return res.json({
        names,
        avatars,
        next: last ?? `${after.cycle}:${after.id}`,
        done: n < limit,
      });
    } catch (err) {
      console.error("GET /api/internal/replay-names failed:", err);
      return sendDbError(res, err, "Couldn't read replay names.");
    }
  });
}
