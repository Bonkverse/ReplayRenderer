// core/safe-trig.js
//
// bonk.io's SafeTrig, copied exactly from the live game (gameframe, Nov 2026).
//
// bonk's physics (vendor/bonk-core.mjs) and its Box2D build
// (vendor/box2d.esm.js) call SafeTrig.* instead of Math.sin / Math.cos / etc.
// Each one rounds the result to 7 decimal places so every browser computes
// exactly the same numbers. Replays only play back correctly if we do the
// same rounding: with plain Math.* the sim drifts a tiny bit on every step,
// and after a few hundred steps (most visibly on maps with crates or moving
// platforms) players end up somewhere their recorded inputs don't fit.
//
// Do not "improve" these. They must match bonk bit for bit.

function round7(r) {
  r *= 10000000;
  r = Math.round(r);
  r /= 10000000;
  return r;
}

export const SafeTrig = {
  safeSin: (r) => round7(Math.sin(r)),
  safeCos: (r) => round7(Math.cos(r)),
  safeTan: (r) => round7(Math.tan(r)),
  safeASin: (r) => round7(Math.asin(r)),
  safeACos: (r) => round7(Math.acos(r)),
  safeATan: (r) => round7(Math.atan(r)),
  safeATan2: (y, x) => round7(Math.atan2(y, x)),
};

// bonk's SafeTrig only has the names above. A few Box2D methods we don't use
// in replays (b2Mat22.GetAngle, b2Transform.GetAngle, connectEdges) call
// SafeTrig.SafeATan2 / SafeTan, which don't exist in bonk either, so they're
// deliberately left undefined here to behave the same way.

/** Install bonk's SafeTrig on the global object (bonk's code reads it as a global). */
export function installSafeTrig(g = globalThis) {
  g.SafeTrig ??= {};
  Object.assign(g.SafeTrig, SafeTrig);
  return g.SafeTrig;
}
