// Guards the two things replays need to match bonk.io exactly:
//   1. bonk's SafeTrig (trig rounded to 7 decimals), not plain Math.*
//   2. players with no input yet get `undefined`, like bonk's getInputs()
import test from "node:test";
import assert from "node:assert/strict";
import { SafeTrig, installSafeTrig } from "../core/safe-trig.js";
import { createInputResolver } from "../core/inputs.js";

test("SafeTrig rounds to 7 decimal places like bonk", () => {
  assert.equal(SafeTrig.safeSin(1.2345), Math.round(Math.sin(1.2345) * 1e7) / 1e7);
  assert.equal(SafeTrig.safeCos(0.5), 0.8775826);
  assert.equal(SafeTrig.safeATan2(1, 1), 0.7853982);
  assert.notEqual(SafeTrig.safeSin(1.2345), Math.sin(1.2345));
});

test("installSafeTrig puts bonk's functions on the global", () => {
  const g = {};
  installSafeTrig(g);
  for (const k of ["safeSin", "safeCos", "safeTan", "safeASin", "safeACos", "safeATan", "safeATan2"]) {
    assert.equal(typeof g.SafeTrig[k], "function", k);
  }
});

test("players with no input yet resolve to undefined, not an all-false object", () => {
  const press = { left: true, right: false, up: false, down: false, action: false, action2: false };
  const inputs = [];
  inputs[0] = [];
  inputs[0][5] = press; // player 0's first input is at step 5
  // player 1 never sends anything
  const r = createInputResolver(inputs);
  assert.equal(r.at(0)[0], undefined);
  assert.equal(r.at(4)[0], undefined);
  assert.equal(r.at(5)[0], press);
  assert.equal(r.at(99)[0], press);
  assert.equal(r.at(3)[1], undefined);
  r.seek(2);
  assert.equal(r.nextStep()[0], undefined);
});
