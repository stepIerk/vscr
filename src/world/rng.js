/**
 * Seeded RNG (mulberry32) + small helpers.
 * Single deterministic stream per world seed so the same seed
 * reproduces the same base map structure.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Float in [min, max). */
export function range(rng, min, max) {
  return min + rng() * (max - min);
}

/** Integer in [min, max] inclusive. */
export function int(rng, min, max) {
  return Math.floor(range(rng, min, max + 1));
}

/** Pick one element. */
export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** In-place Fisher–Yates shuffle, returns the array. */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Clamp helper (no Phaser dependency — generator stays engine-free). */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
