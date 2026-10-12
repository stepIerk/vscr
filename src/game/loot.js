/**
 * Loot rolls for destroyed growths (pure, no Phaser).
 * Kept separate from the scene so the drop logic is testable and reusable
 * (e.g. for future chests, destructible obstacles or enemy variants).
 */

import { GROWTHS } from '../config.js';

/**
 * Decide what a broken growth yields.
 * @param rand источник случайности (подменяется в тестах)
 * @returns {{biomass:boolean, plasma:boolean, artifact:boolean, cell:boolean}}
 */
export function rollGrowthLoot(rand = Math.random) {
  return {
    biomass: rand() < GROWTHS.dropBiomassChance,
    plasma: rand() < GROWTHS.dropPlasmaChance,
    // Редкий трофей: артефакт, затем (маловероятно) клетка.
    artifact: rand() < GROWTHS.dropArtifactChance,
    cell: rand() < GROWTHS.dropCellChance
  };
}

/** Integer in [min, max] inclusive. */
export function rollCount(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}
