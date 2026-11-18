// One replay -> MP4 in headless Chrome, using the player's own MP4 export
// (render.html), so the video looks exactly like the site. Prints the size
// and timings. Needs the dev server (npm run dev) or a built render.html.
//
// WebGL is turned off on purpose: bonk.io's renderer then falls back to 2D
// canvas, and reading frames from a 2D canvas is ~100x faster than from
// software WebGL on a server with no GPU (spike, 2026-11-18).
//
//   node server/render-video.mjs <replay.json> <out.mp4> [fps] [scale] [bitrate] [seconds]
import { readFileSync, writeFileSync } from "node:fs";
import puppeteer from "puppeteer-core";

const [replayPath, outPath, fps = "30", scale = "1", bitrate = "2500000", seconds = ""] =
  process.argv.slice(2);
const replay = JSON.parse(readFileSync(replayPath, "utf8"));
const decoded = replay.decoded ?? replay;

const launchedAt = Date.now();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  headless: true,
  args: (process.env.CHROME_ARGS || "--no-sandbox --disable-webgl --disable-3d-apis --disable-gpu").split(" "),
});
try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("[page]", m.text());
  });
  page.on("pageerror", (e) => console.error("[page error]", e.message));
  await page.setViewport({ width: 800, height: 600 });
  await page.goto(process.env.RENDER_URL || "http://127.0.0.1:5173/render.html", { waitUntil: "load" });
  await page.waitForFunction("window.renderReady === true", { timeout: 60_000 });
  const pageReadyMs = Date.now() - launchedAt;

  const endStep = seconds ? Number(seconds) * 30 : null;
  const result = await page.evaluate(
    (d, o) => window.renderReplay(d, o),
    decoded,
    { fps: Number(fps), scale: Number(scale), bitrate: Number(bitrate), endStep },
  );
  writeFileSync(outPath, Buffer.from(result.base64, "base64"));
  console.log(JSON.stringify({
    out: outPath,
    bytes: result.bytes,
    mb: +(result.bytes / 1e6).toFixed(2),
    render_ms: result.ms,
    chrome_start_ms: pageReadyMs,
    total_ms: Date.now() - launchedAt,
  }));
} finally {
  await browser.close();
}
