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
//      413 replay_too_long · 503 render_failed / render_timeout / db_unavailable
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
import { createPool, loadReplay } from "./api-routes.mjs";
import { createVideoRenderer, RenderTimeout } from "./video-renderer.mjs";
import { extractMeta, extractPlayers, modeLabel } from "../browser/app/format.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MAX_FRAMES = 30 * 30; // 30 s; bonk.io replays are at most 15 s

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
      const { video, ms } = await renderer.render(replay.decoded);
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
