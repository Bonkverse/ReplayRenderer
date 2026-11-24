// The sound recorder used by the MP4 export (browser/exportAudio.js). It has to
// make the same choices as bonk.io's SoundHandler, or videos would have more
// (or fewer) sounds than the live player plays.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createSoundRecorder } from "../browser/exportAudio.js";

const fakeBuffers = (durations) => new Map(Object.entries(durations).map(([k, d]) => [k, { duration: d }]));

function recorder(durations = { footBounce: 0.5, discDeath0: 1 }) {
  let now = 0;
  const r = createSoundRecorder({ now: () => now, buffers: fakeBuffers(durations) });
  return { r, at: (t) => (now = t) };
}

describe("export sound recorder", () => {
  test("records the time, volume and stereo position", () => {
    const { r, at } = recorder();
    at(1.25);
    r.playSound("footBounce", -0.4, 0.3, undefined);
    assert.deepEqual(r.events, [{ type: "footBounce", t: 1.25, volume: 0.3, pan: -0.4 }]);
  });

  test("plays a step's sound once, however many frames render that step", () => {
    const { r } = recorder();
    r.playSound("footBounce", 0, 1, 42);
    r.resetSumVols();
    r.playSound("footBounce", 0, 1, 42); // the same step rendered again at 60 fps
    r.playSound("footBounce", 0, 1, 43);
    assert.equal(r.events.length, 2);
  });

  test("at most 10 of one sound play at once, and they free up when they end", () => {
    const { r, at } = recorder({ footBounce: 0.5 });
    for (let i = 0; i < 12; i++) {
      r.playSound("footBounce", 0, 0.1, undefined);
      r.resetSumVols();
    }
    assert.equal(r.events.length, 10);
    at(0.6); // all ten have finished
    r.playSound("footBounce", 0, 0.1, undefined);
    assert.equal(r.events.length, 11);
  });

  test("stops a sound once its volume this render reaches 15", () => {
    const { r } = recorder({ discDeath0: 0 });
    for (let i = 0; i < 5; i++) r.playSound("discDeath0", 0, 5, undefined);
    assert.equal(r.events.length, 3); // 5 + 5 + 5 = 15, then refused
    r.resetSumVols(); // next render
    r.playSound("discDeath0", 0, 5, undefined);
    assert.equal(r.events.length, 4);
  });

  test("capture-zone sounds skip the limits, like bonk's shared Howls", () => {
    const { r } = recorder();
    for (let i = 0; i < 20; i++) r.playSound("capIncrease", 0, 0.5, 7);
    assert.equal(r.events.length, 20);
  });

  test("keeps stereo in range and drops bad volumes to silence", () => {
    const { r } = recorder();
    r.playSound("footBounce", 3, NaN, undefined);
    assert.deepEqual(r.events[0], { type: "footBounce", t: 0, volume: 0, pan: 1 });
  });
});
