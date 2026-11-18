// The replay video service (server/render-server.mjs, server/video-renderer.mjs).
//
// The database is faked with one real stored replay (one.bin). The last test
// renders it for real in headless Chrome, so it needs a built dist/ (npm run
// build) and Chrome (CHROME_PATH, default /usr/bin/google-chrome); it's
// skipped when either is missing.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authorized, createRenderApp, MAX_FRAMES, summarize } from "../server/render-server.mjs";
import { createVideoRenderer, RenderTimeout } from "../server/video-renderer.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const STORED = readFileSync(path.join(root, "one.bin"));
const TOKEN = "test-render-token";

function fakePool(rows) {
  return { query: async () => ({ rows }) };
}

const ROW = {
  cycle: 6,
  id: 12345,
  mapid: 77,
  replaydata: STORED,
  fetched_at: new Date("2026-11-02T00:00:00Z"),
  estimated_day: "2026-11-01",
};

async function serve(app) {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function post(url, body, token = TOKEN) {
  return fetch(`${url}/render`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

describe("auth", () => {
  test("needs the exact token, and no token set means nobody gets in", () => {
    assert.equal(authorized(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(authorized("Bearer wrong", TOKEN), false);
    assert.equal(authorized("", TOKEN), false);
    assert.equal(authorized("Bearer ", ""), false);
  });
});

describe("summary for the bot", () => {
  test("map, mode, length and players", async () => {
    const { decodeStoredReplay } = await import("../server/codec.js");
    const summary = summarize({ ...ROW, id: "12345", decoded: decodeStoredReplay(STORED) });
    assert.equal(summary.id, "12345");
    assert.equal(summary.day, "2026-11-01");
    assert.equal(summary.seconds, 15);
    // 5 slots, 2 real players: empty slots are left out
    assert.deepEqual(summary.players.map((p) => p.name), ["FlamingFight", "Very_big_small"]);
  });
});

describe("POST /render without Chrome", () => {
  const calls = [];
  const renderer = {
    queued: 0,
    async render(decoded) {
      calls.push(decoded.es);
      if (decoded.fail === "timeout") throw new RenderTimeout("slow");
      return { video: Buffer.from("fake mp4"), ms: 5 };
    },
  };
  let svc;
  before(async () => {
    svc = await serve(createRenderApp({ pool: fakePool([ROW]), renderer, token: TOKEN, distDir: root }));
  });
  after(() => svc.close());

  test("renders and returns the video with the summary", async () => {
    const res = await post(svc.url, { replay_id: "12345" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(Buffer.from(body.video.mp4_base64, "base64").toString(), "fake mp4");
    assert.equal(body.replay.cycle, 6);
    assert.deepEqual(calls, [450]);
  });

  test("problems", async () => {
    assert.equal((await post(svc.url, { replay_id: "12345" }, "nope")).status, 401);
    assert.equal((await post(svc.url, { replay_id: "abc" })).status, 400);
    assert.equal((await post(svc.url, { replay_id: "1", cycle: "x" })).status, 400);
  });

  test("health", async () => {
    assert.deepEqual(await (await fetch(`${svc.url}/health`)).json(), { ok: true, queued: 0 });
  });
});

describe("POST /render edge cases", () => {
  const renderer = {
    queued: 0,
    async render() {
      throw new RenderTimeout("slow");
    },
  };

  test("missing replay, too long, database down, render timeout", async () => {
    const missing = await serve(createRenderApp({ pool: fakePool([]), renderer, token: TOKEN, distDir: root }));
    assert.deepEqual(
      [(await post(missing.url, { replay_id: "1" })).status],
      [404],
    );
    missing.close();

    const down = await serve(
      createRenderApp({
        pool: { query: async () => { throw new Error("connection refused"); } },
        renderer, token: TOKEN, distDir: root,
      }),
    );
    assert.equal((await (await post(down.url, { replay_id: "1" })).json()).error, "db_unavailable");
    down.close();

    const slow = await serve(createRenderApp({ pool: fakePool([ROW]), renderer, token: TOKEN, distDir: root }));
    const res = await post(slow.url, { replay_id: "12345" });
    assert.deepEqual([res.status, (await res.json()).error], [503, "render_timeout"]);
    slow.close();

    assert.equal(MAX_FRAMES, 900);
  });
});

describe("queue", () => {
  test("runs one job at a time and keeps the order", async () => {
    const order = [];
    const fakeBrowser = {
      connected: true,
      on() {},
      async newPage() {
        return {
          on() {}, async setViewport() {}, async goto() {}, async waitForFunction() {},
          async evaluate(_, d) {
            order.push(`start ${d}`);
            await new Promise((r) => setTimeout(r, 20));
            order.push(`end ${d}`);
            return { base64: Buffer.from(String(d)).toString("base64"), ms: 20 };
          },
          async close() {},
        };
      },
      async close() {},
    };
    const renderer = createVideoRenderer({ pageUrl: "x", launch: async () => fakeBrowser });
    await Promise.all([renderer.render("a"), renderer.render("b")]);
    assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
  });
});

const chrome = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const canRender = existsSync(chrome) && existsSync(path.join(root, "dist", "render.html"));

describe("real render in headless Chrome", { skip: !canRender && "needs Chrome and npm run build" }, () => {
  test("a stored replay becomes a playable-size MP4", async () => {
    // The page is served by the app itself, so the renderer is only made
    // once the port is known.
    let real;
    const renderer = { queued: 0, render: (d, o) => real.render(d, o) };
    const distDir = path.join(root, "dist");
    const svc = await serve(createRenderApp({ pool: fakePool([ROW]), renderer, token: TOKEN, distDir }));
    real = createVideoRenderer({ pageUrl: `${svc.url}/render.html`, chromePath: chrome });
    try {
      const res = await post(svc.url, { replay_id: "12345" });
      assert.equal(res.status, 200);
      const body = await res.json();
      const mp4 = Buffer.from(body.video.mp4_base64, "base64");
      assert.equal(mp4.subarray(4, 8).toString(), "ftyp"); // an MP4 file
      assert.ok(mp4.length > 100_000 && mp4.length < 20_000_000, `size ${mp4.length}`);
      console.log(`  rendered ${mp4.length} bytes in ${body.video.render_ms} ms`);
    } finally {
      await real.close();
      svc.close();
    }
  });
});

describe("fitting Discord's upload limit", () => {
  test("a video that's too big is re-rendered once at a lower bitrate", async () => {
    const { renderForDiscord, MAX_VIDEO_BYTES, FALLBACK_BITRATE } = await import("../server/render-server.mjs");
    const asked = [];
    const sizes = [MAX_VIDEO_BYTES + 1, 1000];
    const renderer = {
      async render(_, options = {}) {
        asked.push(options.bitrate ?? "default");
        return { video: Buffer.alloc(sizes.shift()), ms: 10 };
      },
    };
    const result = await renderForDiscord(renderer, {});
    assert.deepEqual(asked, ["default", FALLBACK_BITRATE]);
    assert.equal(result.video.length, 1000);
    assert.equal(result.tooBig, false);
    assert.equal(result.ms, 20);
  });

  test("a video that fits is rendered once", async () => {
    const { renderForDiscord } = await import("../server/render-server.mjs");
    let calls = 0;
    const renderer = { async render() { calls += 1; return { video: Buffer.alloc(10), ms: 5 }; } };
    await renderForDiscord(renderer, {});
    assert.equal(calls, 1);
  });

  test("the defaults match the site's Export MP4", async () => {
    const { DEFAULT_VIDEO } = await import("../server/video-renderer.mjs");
    assert.deepEqual(DEFAULT_VIDEO, { scale: 2, fps: 60, bitrate: 16_000_000 });
  });
});
