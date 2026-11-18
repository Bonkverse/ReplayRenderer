// server/video-renderer.mjs
//
// Turns a decoded replay into an MP4 in headless Chrome, using the player's
// own export on render.html, so a video looks exactly like the site.
//
// One Chrome stays open for the life of the process; each job gets a fresh
// tab (so nothing leaks between replays) and closes it afterwards. Jobs run
// at most `concurrency` at a time; the rest wait their turn.
//
// WebGL is off on purpose: bonk.io's renderer then falls back to 2D canvas,
// and copying frames off a 2D canvas is ~100x faster than off software WebGL
// on a server with no GPU (ReplayRenderer #19: 15 s replay in ~3 s).

import puppeteer from "puppeteer-core";

export const CHROME_ARGS = [
  "--no-sandbox",
  "--disable-webgl",
  "--disable-3d-apis",
  "--disable-gpu",
  "--disable-dev-shm-usage", // containers often have a tiny /dev/shm
];

// The same settings as the site's "Export MP4" (ReplayPlayer.exportReplayMp4),
// so a Discord video looks like a site export: 1460×1000 at 60 fps. bonk.io
// frames are simple, so a 15 s replay comes out ~6 MB even at 16 Mbps (tested
// 2026-11-18), well under Discord's 20 MB. Each can be changed with
// RENDER_SCALE / RENDER_FPS / RENDER_BITRATE.
export const DEFAULT_VIDEO = {
  scale: Number(process.env.RENDER_SCALE || 2),
  fps: Number(process.env.RENDER_FPS || 60),
  bitrate: Number(process.env.RENDER_BITRATE || 16_000_000),
};

export class RenderTimeout extends Error {}

export function createVideoRenderer({
  pageUrl,
  chromePath = process.env.CHROME_PATH || "/usr/bin/google-chrome",
  concurrency = 1,
  timeoutMs = 90_000,
  launch = puppeteer.launch.bind(puppeteer),
} = {}) {
  let browser = null;
  let running = 0;
  const waiting = [];

  async function getBrowser() {
    if (browser?.connected) return browser;
    browser = await launch({ executablePath: chromePath, headless: true, args: CHROME_ARGS });
    browser.on("disconnected", () => {
      browser = null; // a crash: the next job starts a new Chrome
    });
    return browser;
  }

  async function slot() {
    if (running < concurrency) {
      running += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }

  async function renderOnce(decoded, options) {
    const page = await (await getBrowser()).newPage();
    try {
      page.on("pageerror", (e) => console.warn("[render page]", e.message));
      await page.setViewport({ width: 800, height: 600 });
      await page.goto(pageUrl, { waitUntil: "load" });
      await page.waitForFunction("window.renderReady === true", { timeout: 30_000 });
      const result = await page.evaluate((d, o) => window.renderReplay(d, o), decoded, {
        ...DEFAULT_VIDEO,
        ...options,
      });
      return { video: Buffer.from(result.base64, "base64"), ms: result.ms };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    /** Jobs waiting for a free slot (for /health and logs). */
    get queued() {
      return waiting.length;
    },

    /** MP4 bytes for one decoded replay. Rejects with RenderTimeout if slow. */
    async render(decoded, options = {}) {
      await slot();
      let timer;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new RenderTimeout(`render took over ${timeoutMs} ms`)), timeoutMs);
        });
        return await Promise.race([renderOnce(decoded, options), timeout]);
      } catch (err) {
        // A stuck tab can't be trusted to finish: restart Chrome for the next job.
        if (err instanceof RenderTimeout) await this.close();
        throw err;
      } finally {
        clearTimeout(timer);
        release();
      }
    },

    async close() {
      await browser?.close().catch(() => {});
      browser = null;
    },
  };
}
