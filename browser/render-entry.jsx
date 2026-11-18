// The headless video renderer's page (render.html). Mounts the real player
// with no UI around it and exposes one function to the script driving
// Chrome (server/render-video.mjs):
//
//   await window.renderReplay(decodedReplay, { fps, scale, bitrate, startStep, endStep })
//   -> { base64, bytes, frames, ms }
//
// It reuses ReplayPlayer's own MP4 export, so a video looks exactly like
// the replay on the site.
import React, { createRef } from "react";
import { createRoot } from "react-dom/client";
import box2d from "../vendor/box2d.esm.js";
import ReplayPlayer from "./ReplayPlayer.jsx";
import "./globals.js";

const identityDecode = (x) => x;
const root = createRoot(document.getElementById("root"));

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function waitFor(check, timeoutMs) {
  const until = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > until) throw new Error("player didn't get ready");
    await new Promise((r) => setTimeout(r, 50));
  }
}

window.renderReplay = async (decoded, options = {}) => {
  const started = performance.now();
  const ref = createRef();
  root.render(
    <ReplayPlayer ref={ref} blob={decoded} box2d={box2d} decodeReplayData={identityDecode} />
  );
  await waitFor(() => ref.current, 30_000);

  const video = new Promise((resolve) => {
    globalThis.__onReplayExport = resolve;
  });
  // A failed export alerts; turn that into an error for the caller.
  const failed = new Promise((_, reject) => {
    window.alert = (msg) => reject(new Error(String(msg)));
  });
  await new Promise((r) => setTimeout(r, 500)); // let the player finish its setup
  ref.current.exportMp4(options);
  const blob = await Promise.race([video, failed]);
  return { base64: await blobToBase64(blob), bytes: blob.size, ms: Math.round(performance.now() - started) };
};

window.renderReady = true;
