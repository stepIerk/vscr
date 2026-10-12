/**
 * Central game configuration + balance constants.
 * World structure comes from src/world/generator.js (seeded);
 * this file holds palette, gameplay tuning and view settings.
 */

export const COLORS = {
  // Living-tissue dungeon palette: mostly dark, bright accents used sparingly.
  void: 0x0a0507, // near-black with a maroon hint (outside the tissue)
  floorA: 0x2b1218, // muted dark-red room floor
  floorB: 0x241016, // alternate room floor tone
  tunnel: 0x201016, // tunnel floor
  floorRim: 0x4a1d26, // faint inner floor edge
  wall: 0x120709, // dense dark tissue wall (rooms, tunnels, blocks alike)
  wallEdge: 0x8a2f3d, // crisp crimson wall outline
  vein: 0x6e2430, // muted raspberry veins / decor
  mottle: 0x170a0d, // darker floor mottling
  telegraph: 0xff2d40, // enemy spawn warning — clearly visible red
  mote: 0x9dffb0, // resource: pale glowing green, distinct on dark floor
  // Returning cast (kept for contrast against the red environment).
  playerCore: 0xffd94d,
  playerShell: 0x40e0d0,
  bullet: 0xffe86b,
  enemyA: 0xff4d5e, // triangle — fast, fragile
  enemyB: 0xff7a3d, // square — balanced
  enemyC: 0xd63d5e, // pentagon — tank
  sparkHit: 0xffd94d,
  sparkDeath: 0xff4d5e,
  sparkTrail: 0x40e0d0,
  sparkMote: 0x9dffb0
};

/** Dungeon generation parameters (game coords, not screen pixels). */
export const DUNGEON = {
  roomCountMin: 12,
  roomCountMax: 18,
  roomMin: 560,
  roomMax: 1080,
  startRoomMin: 700,
  tunnelWidth: 120,
  wall: 24,
  spawnAreaPer: 70000, // room area funding one spawn point
  spawnMin: 3,
  spawnMax: 9
};

export const PLAYER = {
  bodyRadius: 14,
  invulnMs: 800, // i-frames after a hit
  knockback: 220
};

/** Base hero combat stats (modified by cards; see HERO/mutations/upgrades). */
export const HERO_BASE = {
  attack: 1, // bullet damage
  attackIntervalMs: 350, // → attackSpeed = 1000 / interval (single semantics!)
  moveSpeed: 280, // px/sec
  maxHealth: 100
};

export const ENEMIES = {
  maxAlive: 110, // global safety cap across all rooms (headroom for level scaling)
  minPlayerDist: 260, // spawns closer than this are deferred while player is near
  telegraphMinMs: 600,
  telegraphMaxMs: 900,
  attackCooldownMs: 1000, // melee swing timer at attack range
  retargetMs: 400, // how often enemies reconsider their target (stability)
  retargetHysteresis: 0.7, // switch only if the rival is clearly closer
  // type table — extend here for future mutations
  types: [
    { key: 'enemy-a', hp: 2, speed: 150, damage: 10, radius: 13, weight: 0.45, dropChance: 0.4, dropCount: [1, 1] },
    { key: 'enemy-b', hp: 3, speed: 110, damage: 12, radius: 16, weight: 0.35, dropChance: 0.7, dropCount: [1, 1] },
    { key: 'enemy-c', hp: 6, speed: 70, damage: 16, radius: 21, weight: 0.2, dropChance: 1.0, dropCount: [1, 2] }
  ]
};

/** +N extra spawn markers per room per hero level above 1. */
export const ENEMY_LEVEL = {
  extraSpawnsPerLevel: 1
};

/** Telegraphed room spawns use these; kept in sync with generator defaults. */
export const SPAWNS = {
  retryMs: 800 // re-check deferred spawn points while the player stays in the room
};

export const RESOURCE = {
  pickupRadius: 34,
  cap: 200 // oldest motes are recycled past this (no accumulation)
};

export const WEAPON = {
  range: 520,
  bulletSpeed: 560,
  bulletLifeMs: 1300,
  bulletPoolMax: 64
};

export const GAME_VIEW = {
  width: 960,
  height: 600,
  zoom: 1
};

/* ------------------------------------------------ progression (stage 1) */

/** XP curve: biomass to go from level L to L+1. */
export const PROGRESSION = {
  baseBiomass: 6,
  growthFactor: 1.35,
  maxQueuedLevels: 10 // safety cap for bulk XP gains
};

export function requiredBiomass(level) {
  return Math.ceil(PROGRESSION.baseBiomass * Math.pow(PROGRESSION.growthFactor, level - 1));
}

/** Friendly cell colony rules. */
export const ALLIES = {
  max: 5, // max live instances (not kinds)
  mergeBonus: 0.35, // +35% attack & maxHealth per merge level
  mergeSpeedBonus: 0.1, // +10% attack speed & move speed per merge level
  maxMerge: 3,
  leashRadius: 150, // allies drift back inside this radius of the hero
  aggroRadius: 760, // allies engage enemies within this range
  dropAggroRadius: 950 // ...and drop targets beyond this range
};

/**
 * Base friendly cell types. attackSpeed semantics (project-wide!):
 * attacks per second; intervalMs = 1000 / attackSpeed. Raising attackSpeed
 * ALWAYS attacks faster — for hero, cells and (via cooldown) enemies alike.
 */
export const ALLY_TYPES = {
  hunter: {
    name: 'Hunter',
    role: 'Pursues the nearest enemy and strikes it down.',
    attack: 1, attackIntervalMs: 850, moveSpeed: 245, maxHealth: 34,
    range: 80, bodyR: 11, tint: 0x46d8ff
  },
  defender: {
    name: 'Defender',
    role: 'Durable close-range fighter that holds enemies off you.',
    attack: 1, attackIntervalMs: 1400, moveSpeed: 175, maxHealth: 85,
    range: 70, bodyR: 14, tint: 0x3ddc84
  },
  parasite: {
    name: 'Parasite',
    role: 'Fragile but relentless: very frequent weak bites.',
    attack: 0.5, attackIntervalMs: 400, moveSpeed: 215, maxHealth: 22,
    range: 70, bodyR: 9, tint: 0xb8f53d
  }
};

/** Mutations apply to hero and/or one cell; re-pick raises the level. */
export const MUTATIONS = {
  metabolism: {
    name: 'Accelerated metabolism', targets: ['hero', 'cell'], maxLevel: 5,
    desc: '+25% attack speed per level', speedBonus: 0.25
  },
  membrane: {
    name: 'Reinforced membrane', targets: ['hero', 'cell'], maxLevel: 5,
    desc: '+25 max health per level', healthBonus: 25
  },
  acid: {
    name: 'Acid secretions', targets: ['hero', 'cell'], maxLevel: 5,
    desc: '+0.5 attack damage per level', damageBonus: 0.5
  }
};

/** Passive upgrades: hero-only or all-cells, leveled by re-picks. */
export const UPGRADES = {
  pulse: { name: 'Amplified pulse', target: 'hero', desc: '+35% hero attack per level', perLevel: 0.35, maxLevel: 5 },
  regen: { name: 'Accelerated regeneration', target: 'hero', desc: '+0.8 HP/s per level', perLevel: 0.8, maxLevel: 5 },
  adaptation: { name: 'Collective adaptation', target: 'cells', desc: '+30% cells max health per level', perLevel: 0.3, maxLevel: 5 },
  sync: { name: 'Synchronization', target: 'cells', desc: '+20% cells attack speed per level', perLevel: 0.2, maxLevel: 5 },
  swift: { name: 'Enhanced motility', target: 'hero', desc: '+8% hero move speed per level', perLevel: 0.08, maxLevel: 5 }
};

/**
 * World seed: fixed via `?seed=N` for debugging/reproduction,
 * otherwise random per page load. Restart reuses it (same map);
 * reload the page for a fresh map.
 */
export function resolveSeed(paramName = 'seed') {
  try {
    const raw = new URLSearchParams(window.location.search).get(paramName);
    const n = raw !== null && raw !== '' ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(n)) return n >>> 0;
  } catch {
    /* non-browser context: fall through to random */
  }
  return (Math.random() * 0xffffffff) >>> 0;
}

/** Pick an enemy type by weight. Pure function, easy to unit-test later. */
export function pickEnemyType(random = Math.random) {
  const total = ENEMIES.types.reduce((s, t) => s + t.weight, 0);
  let roll = random() * total;
  for (const t of ENEMIES.types) {
    roll -= t.weight;
    if (roll <= 0) return t;
  }
  return ENEMIES.types[0];
}
