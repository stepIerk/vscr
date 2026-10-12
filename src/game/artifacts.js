/**
 * Artifact catalog helpers: prices, effect aggregation, stock generation.
 * Pure functions over config data — no Phaser / DOM.
 */

import { ARTIFACT_CATALOG, SHOP, ARTIFACTS, UPGRADES } from '../config.js';

export const ARTIFACT_BY_ID = Object.fromEntries(ARTIFACT_CATALOG.map((a) => [a.id, a]));

/** Owned levels of one artifact (0 = not acquired). */
export function artifactLevel(run, id) {
  return run.artifacts[id] || 0;
}

export function artifactMaxed(run, id) {
  const def = ARTIFACT_BY_ID[id];
  return !!def && artifactLevel(run, id) >= def.maxLevel;
}

/** Can this artifact be bought right now? */
export function canBuyArtifact(run, id) {
  return !artifactMaxed(run, id);
}

/** Is the artifact currently active (counted in computeHero)? */
export function isArtifactActive(run, id) {
  return run.activeArtifacts.includes(id);
}

/** Free active slots left. */
export function freeSlots(run) {
  return Math.max(0, ARTIFACTS.slots - run.activeArtifacts.length);
}

/** Sum of one effect field across ACTIVE artifacts (0 for inactive ones). */
export function artifactSum(run, field) {
  let sum = 0;
  for (const id of run.activeArtifacts) {
    const def = ARTIFACT_BY_ID[id];
    if (!def || !def.effect[field]) continue;
    sum += def.effect[field] * artifactLevel(run, id);
  }
  return sum;
}

/** Sum of one percent effect field (returns fraction, e.g. 0.24). */
export function artifactPct(run, field) {
  return artifactSum(run, field);
}

/** Price of a shop offer. Visits add markup; levels add steps. */
export function priceOf(kind, key, level, visits) {
  const isArt = kind === 'artifact';
  const base = isArt ? SHOP.priceBaseArtifact : SHOP.priceBaseUpgrade;
  const step = isArt ? SHOP.priceStepArtifact : SHOP.priceStepUpgrade;
  const mult = isArt ? SHOP.priceMultiplier.artifact : SHOP.priceMultiplier.upgrade;
  const raw = (base + step * level) * mult * Math.pow(SHOP.visitMarkup, visits);
  return Math.max(1, Math.round(raw));
}

export function priceLabel(price, plasma) {
  return `${price} плазмы (есть ${plasma})`;
}

/** All artifact definitions (for the inventory view). */
export function allArtifacts() {
  return ARTIFACT_CATALOG;
}

/** Upgrades that can still be leveled (for shop stock). */
export function availableUpgrades(run) {
  return Object.keys(UPGRADES).filter((k) => (run.upgrades[k] || 0) < UPGRADES[k].maxLevel);
}

/** Artifacts that can still be leveled (for shop stock). */
export function availableArtifacts(run) {
  return ARTIFACT_CATALOG.filter((a) => !artifactMaxed(run, a.id)).map((a) => a.id);
}

/**
 * Shop stock for one visit: a mix of upgrades and artifacts.
 * `rng` — seeded random from the room (deterministic per map+room).
 */
export function generateShopStock(run, rng, opts = {}) {
  const min = opts.min ?? SHOP.offersMin;
  const max = opts.max ?? SHOP.offersMax;
  const n = Math.floor(min + rng() * (max - min + 1));
  const ups = availableUpgrades(run);
  const arts = availableArtifacts(run);
  const stock = [];
  // Alternate categories so both types appear when possible.
  let takeArt = rng() < 0.5;
  for (let i = 0; i < n && (ups.length || arts.length); i++) {
    const pool = takeArt ? arts : ups;
    const other = takeArt ? ups : arts;
    const src = pool.length ? pool : other;
    if (!src.length) break;
    const idx = Math.floor(rng() * src.length);
    const key = src[idx];
    const kind = src === arts ? 'artifact' : 'upgrade';
    stock.push({ kind, key });
    if (src === arts) arts.splice(idx, 1);
    else ups.splice(idx, 1);
    takeArt = !takeArt; // чередуем категории
  }
  return stock;
}
