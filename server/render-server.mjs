// server/render-server.mjs
//
// The replay video service (npm run start:render; Dockerfile.render). Its own
// Railway service because it needs Chrome, which the replay site doesn't.
//
//   POST /render  {"replay_id": "123", "cycle": 6?}
//     Authorization: Bearer <RENDER_TOKEN>
//   -> 200 {"replay": {id, cycle, map, author, mode, day, seconds, players:[...]},
//           "video": {"mp4_base64", "bytes", "render_ms"}}
//      400 bad_request · 401 unauthorized · 404 replay_not_found
//      413 replay_too_long / video_too_large · 503 render_failed / render_timeout / db_unavailable
//   POST /replays/with  {"names": ["The Saucy Tulip", ...], "after": {"cycle", "id"} | null, "limit": 5}
//     Authorization: Bearer <RENDER_TOKEN>
//   -> 200 {"replays": [...], "scanned_to": {"cycle", "id"}, "more": bool}
//      New replays (after `after`, oldest first) with any of these registered
//      players, for BonxBot's replay feed. Without `after`: no replays, just
//      scanned_to = the newest replay, so a new feed starts from now.
//   GET /health -> {"ok": true, "queued": n}
//
// It also serves the built frontend (dist/) so Chrome can open render.html
// from this same process. Nothing is stored: the video goes back in the
// reply and is gone. Needs DATABASE_URL (the Replay DB) and RENDER_TOKEN.

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import pg from "pg";
import { createPool, enrichKeys, loadReplay } from "./api-routes.mjs";
import { createVideoRenderer, RenderTimeout } from "./video-renderer.mjs";
import { extractMeta, extractPlayers, modeLabel } from "../browser/app/format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MAX_FRAMES = 30 * 30; // 30 s; bonk.io replays are at most 15 s
// Discord's upload limit is 20 MB; stay under it with room for the message.
export const MAX_VIDEO_BYTES = Number(process.env.RENDER_MAX_BYTES || 19_000_000);
// If a busy replay comes out too big, try once more at this bitrate.
export const FALLBACK_BITRATE = 4_000_000;

/** Render, re-rendering once at a lower bitrate if the file is too big for Discord. */
export async function renderForDiscord(renderer, decoded) {
  const first = await renderer.render(decoded);
  if (first.video.length <= MAX_VIDEO_BYTES) return first;
  console.warn(`render: ${first.video.length} bytes is over ${MAX_VIDEO_BYTES}; retrying at a lower bitrate`);
  const second = await renderer.render(decoded, { bitrate: FALLBACK_BITRATE });
  return { ...second, ms: first.ms + second.ms, tooBig: second.video.length > MAX_VIDEO_BYTES };
}

export const MAX_FEED_NAMES = 1000;
export const MAX_FEED_LIMIT = 10;
// At most this many new replays are looked at per call, so a feed that's
// fallen behind catches up in steps instead of one huge scan.
export const FEED_SCAN = 2000;

/**
 * New replays after (cycle, id), oldest first, with any of `names` playing
 * (registered, case ignored). Returns the replays (enriched like search
 * results), how far it scanned, and whether more matches were left over.
 */
export async function replaysWith(pool, names, after, limit) {
  const lowered = [...new Set(names.map((n) => String(n).toLowerCase()))];
  const result = await pool.query(
    `
    WITH fresh AS (
      SELECT cycle, id, mapid, fetched_at FROM replays
      WHERE (cycle, id) > ($1::int, $2::bigint)
      ORDER BY cycle, id
      LIMIT ${FEED_SCAN}
    ),
    edge AS (SELECT cycle, id FROM fresh ORDER BY cycle DESC, id DESC LIMIT 1),
    hits AS (
      SELECT f.cycle, f.id, f.mapid, f.fetched_at FROM fresh f
      WHERE EXISTS (
        SELECT 1 FROM replay_participants rp
        WHERE rp.cycle = f.cycle AND rp.replay_id = f.id
          AND NOT rp.guest AND lower(rp.username) = ANY($3::text[])
      )
    )
    SELECT (SELECT row_to_json(edge) FROM edge) AS edge,
           (SELECT COALESCE(json_agg(h ORDER BY h.cycle, h.id), '[]'::json) FROM hits h) AS hits
    `,
    [after.cycle, String(after.id), lowered]
  );
  const { edge, hits } = result.rows[0];
  const picked = hits.slice(0, limit);
  if (!picked.length) {
    return { replays: [], scanned_to: edge ?? after, more: false };
  }
  const keys = picked.map((h, i) => `($${i * 4 + 1}::int, $${i * 4 + 2}::bigint, $${i * 4 + 3}::bigint, $${i * 4 + 4}::timestamptz)`);
  const params = picked.flatMap((h) => [h.cycle, String(h.id), h.mapid == null ? null : String(h.mapid), h.fetched_at]);
  const replays = await enrichKeys(
    pool,
    `SELECT * FROM (VALUES ${keys.join(", ")}) AS v(cycle, id, mapid, fetched_at)`,
    params,
    "cycle ASC, id ASC"
  );
  // With leftovers, resume right after the last one sent; otherwise skip
  // ahead to everything scanned.
  const more = hits.length > picked.length;
  const last = picked[picked.length - 1];
  return { replays, scanned_to: more ? { cycle: last.cycle, id: last.id } : edge, more };
}

export async function newestReplay(pool) {
  const result = await pool.query("SELECT cycle, id FROM replays ORDER BY cycle DESC, id DESC LIMIT 1");
  return result.rows[0] ?? { cycle: 0, id: 0 };
}

export function authorized(header, token) {
  if (!token) return false; // no token set: the service refuses everything
  const given = Buffer.from(String(header || "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** What the bot shows next to the video. */
export function summarize(replay) {
  const meta = extractMeta(replay.decoded);
  return {
    id: replay.id,
    cycle: replay.cycle,
    map: meta.mapName,
    author: meta.mapAuthor,
    map_id: meta.mapId,
    mode: modeLabel(meta.mode),
    teams: meta.teams,
    // The day is estimated from replay ids (replay_cycle_days), not recorded.
    day: replay.estimated_day ?? null,
    seconds: meta.frames ? Math.round(meta.frames / 30) : null,
    players: extractPlayers(replay.decoded).map((p) => ({
      name: p.username,
      team: p.team,
      level: p.level,
      guest: p.guest,
      score: p.score,
    })),
  };
}

export function createRenderApp({ pool, renderer, token, distDir }) {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (req, res) => res.json({ ok: true, queued: renderer.queued }));

  app.post("/render", async (req, res) => {
    if (!authorized(req.get("authorization"), token)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const id = String(req.body?.replay_id ?? "");
    const cycle = req.body?.cycle == null ? null : Number(req.body.cycle);
    if (!/^\d{1,18}$/.test(id) || (cycle != null && !Number.isInteger(cycle))) {
      return res.status(400).json({ error: "bad_request" });
    }

    let replay;
    try {
      replay = await loadReplay(pool, id, cycle);
    } catch (err) {
      console.error("render: loading replay failed:", err.message);
      return res.status(503).json({ error: "db_unavailable" });
    }
    if (!replay) return res.status(404).json({ error: "replay_not_found" });
    if ((replay.decoded?.es ?? 0) > MAX_FRAMES) {
      return res.status(413).json({ error: "replay_too_long" });
    }

    try {
      const { video, ms, tooBig } = await renderForDiscord(renderer, replay.decoded);
      if (tooBig) return res.status(413).json({ error: "video_too_large" });
      console.log(`render: replay ${replay.cycle}:${replay.id} -> ${video.length} bytes in ${ms} ms`);
      return res.json({
        replay: summarize(replay),
        video: { mp4_base64: video.toString("base64"), bytes: video.length, render_ms: ms },
      });
    } catch (err) {
      const timedOut = err instanceof RenderTimeout;
      console.error(`render: replay ${id} failed:`, err.message);
      return res.status(503).json({ error: timedOut ? "render_timeout" : "render_failed" });
    }
  });

  app.post("/replays/with", async (req, res) => {
    if (!authorized(req.get("authorization"), token)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const names = req.body?.names;
    const after = req.body?.after ?? null;
    const limit = Math.min(MAX_FEED_LIMIT, Math.max(1, Number(req.body?.limit) || 5));
    const validNames =
      Array.isArray(names) && names.length <= MAX_FEED_NAMES && names.every((n) => typeof n === "string" && n.length <= 64);
    const validAfter =
      after === null ||
      (Number.isInteger(Number(after.cycle)) && /^\d{1,18}$/.test(String(after.id ?? "")));
    if (!validNames || !validAfter) return res.status(400).json({ error: "bad_request" });

    try {
      if (after === null) {
        const newest = await newestReplay(pool);
        return res.json({ replays: [], scanned_to: { cycle: newest.cycle, id: String(newest.id) }, more: false });
      }
      if (!names.length) return res.json({ replays: [], scanned_to: after, more: false });
      const found = await replaysWith(pool, names, { cycle: Number(after.cycle), id: String(after.id) }, limit);
      found.scanned_to = { cycle: found.scanned_to.cycle, id: String(found.scanned_to.id) };
      return res.json(found);
    } catch (err) {
      console.error("POST /replays/with failed:", err.message);
      return res.status(503).json({ error: "db_unavailable" });
    }
  });

  app.use(express.static(distDir));
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8090);
  const renderer = createVideoRenderer({
    pageUrl: `http://127.0.0.1:${port}/render.html`,
    concurrency: Number(process.env.RENDER_CONCURRENCY || 1),
  });
  const app = createRenderApp({
    pool: createPool(pg.Pool),
    renderer,
    token: process.env.RENDER_TOKEN,
    distDir: path.join(__dirname, "..", "dist"),
  });
  const server = app.listen(port, () => console.log(`Replay video service on port ${port}`));
  const stop = async () => {
    server.close();
    await renderer.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
