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
  // Органические слои стен (портальный режим): масса → плоть → кайма.
  wallMid: 0x2b1116, // средняя плоть стены (полоса вокруг пола)
  wallInner: 0x4a1d26, // внутренняя кайма вдоль проходимого пола
  wallHighlight: 0x8a3a4a, // светлые доли/выпуклости ткани
  wallCrevice: 0x0d0406, // тёмные впадины между долями
  flesh: 0x3a151c, // мясистая выпуклость (наружный валик портала)
  fleshLight: 0x5a2530, // светлая плоть (блики, мембрана)
  hole: 0x140809, // тёмная глубина венозной дыры
  holeDeep: 0x050203, // почти чёрное дно портала
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
  // Сколько комнат генерируется на карте (минимум/максимум).
  roomCountMin: 3,
  roomCountMax: 5,
  // Размеры комнат в игровых координатах (не зависят от разрешения экрана).
  roomMin: 1000,
  roomMax: 1500,
  // Минимальная сторона стартовой (безопасной) комнаты.
  startRoomMin: 700,
  // Ширина тоннелей между комнатами.
  tunnelWidth: 120,
  // Толщина стен.
  wall: 24,
  // Режим карты: true — комнаты соединены тоннелями (классика),
  // false — тоннелей нет, вместо них врата-порталы между комнатами.
  withTunnels: false,
  // Сколько площадей комнаты даёт одну точку появления врага.
  spawnAreaPer: 70000,
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
  extraSpawnsPerLevel: 5
};

/** Telegraphed room spawns use these; kept in sync with generator defaults. */
export const SPAWNS = {
  retryMs: 800 // re-check deferred spawn points while the player stays in the room
};

/* ------------------------------------------------- арена: бой на закрытых дверях */

/**
 * Бой начинается, когда игрок зашёл в комнату: колония телепортируется
 * внутрь, проходы закрываются барьерами, начинают появляться монстры.
 * После зачистки барьеры открываются.
 */
export const ARENA = {
  barrierColor: 0xff2d40, // красная плоть-барьер в дверном проёме
  barrierAlpha: 0.85,
};

/* ------------------------------------------------- врата-порталы (режим без тоннелей) */

/**
 * Врата-порталы соединяют комнаты напрямую вместо тоннелей.
 * По лору это венозные дыры в плоти: тёмный зев с мясистым валиком
 * снаружи, в цветах окружающих внутренностей. Стоят возле края комнаты,
 * со стороны соседней комнаты (луч на её центр → стена → отступ внутрь).
 * - Каждый линк графа даёт ровно пару врат (туда-обратно),
 *   обе стороны одного линка помечены одной тонкой жилой-кольцом.
 * - Врата в незачищенной боевой комнате затянуты сфинктером (не выпускают).
 */
export const PORTAL = {
  radius: 34, // радиус зоны срабатывания телепорта
  bodyRadius: 20, // радиус видимого тела врат
  exitOffset: 110, // отступ точки прибытия от центра врат (чтобы не триггерить обратно)
  cooldownMs: 1200, // защита от пинг-понга между парой
  clearance: 130, // отступ наростов/стендов/препятствий от врат
  inset: 130, // отступ врат от стен комнаты
  minSeparation: 170, // минимальная дистанция между вратами в одной комнате
  // Цвета пар врат (по индексу линка) — обе стороны одного линка одинаковые.
  pairColors: [0x40e0d0, 0xffd94d, 0xff7ada, 0x9dffb0, 0xb79cff, 0xffa35e, 0x7ad9ff, 0xff8f8f],
  lockedColor: 0xff2d40, // заблокированные врата (бой не зачищен) красятся красным
};

export const RESOURCE = {
  pickupRadius: 34,
  cap: 200 // oldest motes are recycled past this (no accumulation)
};

/* ------------------------------------------------- боссы в конце крыльев */

/**
 * Босс-комната appended в конец каждого крыла (базовый layout — крыло 0,
 * дальше generateWing): больше обычных комнат, без препятствий и обычных
 * спавнов. Бой: колония прячется, босс гоняется и бьёт вближнюю как обычный
 * враг + раз в cooldown устраивает bullet-hell суператаку с телеграфом.
 * Награда: +rewardLevels уровней (драфты) + плазма.
 */
export const BOSS = {
  roomMin: 1300, // сторона босс-комнаты (больше обычных roomMax)
  roomMax: 1700,
  rewardLevels: 2, // +N уровней (выборов карт) за победу
  rewardPlasma: 15, // плазмы сверху
  deathAnimMs: 1400, // агония босса: вспышки и разрывы до выдачи награды
  hpScalePerWing: 0.25, // +25% HP за каждое следующее крыло
  foeCap: 120, // лимит вражеских снарядов (старые гаснут)
  foeLifeMs: 4000, // время жизни вражеского снаряда
  foeRadius: 7, // радиус тела снаряда
  /** Ростер: крыло N берёт defs[N % len]. У каждого свои атаки/статы. */
  defs: [
    {
      key: 'maw', name: 'Утроба', tint: 0xc44dff,
      hp: 70, speed: 85, damage: 16, radius: 32, contactCooldownMs: 1100,
      attacks: [
        { kind: 'radial', label: 'Кольцевой залп', cooldownMs: 9000, telegraphMs: 1200, count: 14, rings: 2, ringDelayMs: 280, speed: 170, dmg: 12 },
        { kind: 'aimed', label: 'Прицельный веер', cooldownMs: 6000, telegraphMs: 800, count: 5, spread: 0.45, speed: 330, dmg: 14 },
        { kind: 'summon', label: 'Призыв стаи', cooldownMs: 15000, telegraphMs: 1000, count: 3 },
      ]
    },
    {
      key: 'choir', name: 'Хор', tint: 0x4dd2ff,
      hp: 110, speed: 62, damage: 20, radius: 38, contactCooldownMs: 1300,
      attacks: [
        { kind: 'spiral', label: 'Спираль', cooldownMs: 12000, telegraphMs: 1200, durationMs: 5000, tickMs: 130, step: 0.42, speed: 150, dmg: 10 },
        { kind: 'radial', label: 'Кольцевой залп', cooldownMs: 8000, telegraphMs: 1000, count: 20, rings: 1, ringDelayMs: 0, speed: 200, dmg: 12 },
        { kind: 'summon', label: 'Призыв стаи', cooldownMs: 16000, telegraphMs: 1000, count: 4 },
      ]
    },
  ]
};

/* ------------------------------------------------- вторая валюта: плазма */

/** Плазма: падает с убитых клеток чаще, чем биомасса. Тратится только в лавках. */
export const PLASMA = {
  startAmount: 0, // сколько плазмы игрок получает на старте забега
  /** Базовый шанс выпадения плазмы с одного убитого врага. */
  baseChance: 0.45,
  /** Индивидуальный шанс выпадения по типу врага (перекрывает baseChance). */
  perEnemyChance: {
    'enemy-a': 0.5, // быстрый слабый враг
    'enemy-b': 0.65, // средний враг
    'enemy-c': 1.0 // тяжёлый враг — всегда роняет плазму
  },
  valueMin: 1, // минимальное количество плазмы за одно выпадение
  valueMax: 1, // максимальное количество плазмы за одно выпадение
  pickupRadius: 34, // радиус автоподбора капель плазмы
  cap: 120, // лимит капель плазмы на карте (старые перерабатываются)
  /** Отображение капли плазмы на полу (форма, размер, цвет, свечение). */
  radius: 7,
  color: 0xff5fd2, // основной цвет плазмы (малиново-фиолетовый)
  glowColor: 0xffffff
};

/* ------------------------------------------------------- лавки в комнатах */

/**
 * Лавка: вместо боевой комнаты генерируется комната с торговцем.
 * Гарантия: минимум одна лавка на каждые `guaranteedEvery` комнат.
 */
export const SHOP = {
  chance: 0.07, // случайный шанс стать лавкой для очередной комнаты
  guaranteedEvery: 2, // хотя бы одна лавка на каждые N комнат (сверх стартовой)
  maxShare: 0.15, // не более этой доли от всех комнат может быть лавками
  offersMin: 3, // сколько товаров генерируется в лавке
  offersMax: 5,
  priceMultiplier: {
    upgrade: 1, // множитель цены для улучшений характеристик
    artifact: 3 // множитель цены для артефактов
  },
  priceBaseUpgrade: 5, // базовая цена улучшения 1-го уровня
  priceStepUpgrade: 3, // прибавка к цене за каждый уже приобретённый уровень
  priceBaseArtifact: 12, // базовая цена артефакта
  priceStepArtifact: 6, // прибавка к цене за каждый уже приобретённый уровень
  visitMarkup: 1.15, // наценка за каждое новое посещение лавки (дробная, шаг 5%)
  /* Комната лавки остаётся без монстров и считается «зачищенной» сразу. */
  clearOnEnter: true,
  /* Физическая лавка: стенды-наросты с товаром (как в рогаликах). */
  standRadius: 26, // радиус тела стенда (блокирует проход)
  standSpacingX: 170, // шаг сетки стендов по горизонтали
  standSpacingY: 170, // шаг сетки стендов по вертикали
  interactRadius: 130, // дистанция покупки по E
  doorClearance: 120, // не ближе этого к устью дверей
  labelFont: '12px',
};

/* ------------------------------------------------------------- артефакты */

/** Артефакты игрока: максимум `slots` активных одновременно. */
export const ARTIFACTS = {
  slots: 5,
  /** Максимальный уровень любого артефакта. */
  maxLevel: 5
};

/**
 * Каталог артефактов (id — ключ в сохранении, не меняйте у существующих).
 * Эффекты применяются в RunState.computeHero() и сцене боя.
 */
export const ARTIFACT_CATALOG = [
  {
    id: 'fang', name: 'Клык', maxLevel: 5,
    desc: '+0.5 к силе атаки героя за уровень.',
    effect: { attack: 0.5 }
  },
  {
    id: 'carapace', name: 'Панцирная пластина', maxLevel: 5,
    desc: '+22 к максимальному здоровью героя за уровень (и лечит на эту же величину).',
    effect: { health: 22 }
  },
  {
    id: 'springs', name: 'Пружинные волокна', maxLevel: 3,
    desc: '+8% к скорости передвижения героя за уровень.',
    effect: { moveSpeedPct: 0.08 }
  },
  {
    id: 'core', name: 'Перегруженное ядро', maxLevel: 3,
    desc: '+18% к скорости атаки героя за уровень.',
    effect: { attackSpeedPct: 0.18 }
  },
  {
    id: 'clinging', name: 'Прилипающие мембраны', maxLevel: 3,
    desc: '+15% к радиусу подбора биомассы и плазмы за уровень.',
    effect: { pickupPct: 0.15 }
  },
  {
    id: 'regennode', name: 'Регенеративный узел', maxLevel: 3,
    desc: '+0.6 HP в секунду герою за уровень.',
    effect: { regen: 0.6 }
  },
  {
    id: 'thorns', name: 'Шиповатая оболочка', maxLevel: 3,
    desc: 'Атакующий героя получает 4 урона за уровень.',
    effect: { thorns: 4 }
  },
  {
    id: 'leech', name: 'Пиявка', maxLevel: 3,
    desc: '+2 HP герою за каждое убийство за уровень.',
    effect: { leech: 2 }
  },
  {
    id: 'scope', name: 'Прицельный глаз', maxLevel: 3,
    desc: '+12% к дальности атаки героя за уровень.',
    effect: { rangePct: 0.12 }
  }
];

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

/** Мобильное управление: тихий стик + сдвиг фокуса камеры от него. */
export const TOUCH = {
  followOffsetY: 90, // фокус ниже героя: герой выше центра, бой не под стиком
};

/* ------------------------------------------------ progression (stage 1) */

/** XP curve: biomass to go from level L to L+1. */
export const PROGRESSION = {
  baseBiomass: 3,
  growthFactor: 1.2,
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
    name: 'Охотник',
    role: 'Преследует ближайшего врага и добивает его.',
    attack: 5, attackIntervalMs: 850, moveSpeed: 245, maxHealth: 54,
    range: 80, bodyR: 11, tint: 0x46d8ff
  },
  defender: {
    name: 'Защитник',
    role: 'Живучий боец ближнего боя, держит врагов вдали от тебя.',
    attack: 1, attackIntervalMs: 1400, moveSpeed: 175, maxHealth: 85,
    range: 70, bodyR: 14, tint: 0x3ddc84
  },
  parasite: {
    name: 'Паразит',
    role: 'Хрупкий, но неумолимый: очень частые слабые укусы.',
    attack: 3, attackIntervalMs: 300, moveSpeed: 215, maxHealth: 42,
    range: 70, bodyR: 9, tint: 0xb8f53d
  }
};

/** Mutations apply to hero and/or one cell; re-pick raises the level. */
export const MUTATIONS = {
  metabolism: {
    name: 'Ускоренный метаболизм', targets: ['hero', 'cell'], maxLevel: 5,
    desc: '+25% к скорости атаки за уровень', speedBonus: 0.25
  },
  membrane: {
    name: 'Укреплённая мембрана', targets: ['hero', 'cell'], maxLevel: 5,
    desc: '+25 к макс. здоровью за уровень', healthBonus: 25
  },
  acid: {
    name: 'Кислотные железы', targets: ['hero', 'cell'], maxLevel: 5,
    desc: '+0.5 к урону за уровень', damageBonus: 0.5
  }
};

/** Passive upgrades: hero-only or all-cells, leveled by re-picks. */
export const UPGRADES = {
  pulse: { name: 'Усиленный пульс', target: 'hero', desc: '+35% к атаке героя за уровень', perLevel: 0.35, maxLevel: 5 },
  regen: { name: 'Ускоренная регенерация', target: 'hero', desc: '+0.8 HP/с за уровень', perLevel: 0.8, maxLevel: 5 },
  adaptation: { name: 'Общая адаптация', target: 'cells', desc: '+30% к здоровью клеток за уровень', perLevel: 0.3, maxLevel: 5 },
  sync: { name: 'Синхронизация', target: 'cells', desc: '+20% к скорости атаки клеток за уровень', perLevel: 0.2, maxLevel: 5 },
  swift: { name: 'Быстрая подвижность', target: 'hero', desc: '+8% к скорости героя за уровень', perLevel: 0.08, maxLevel: 5 },
  // Рой: +1 к лимиту содружественных клеток под контролем за уровень.
  swarm: { name: 'Рой', target: 'colony', desc: '+1 слот дружественной клетки', perLevel: 1, maxLevel: 2 }
};

/* ------------------------------------------------- наросты (добыча) */

/**
 * Наросты: разрушаемые мясистые образования на полу комнат.
 * Не блокируют движение (мягкая ткань) — ломаются снарядами героя.
 * Из нароста выпадают: биомасса, плазма, редко — артефакт или клетка.
 */
export const GROWTHS = {
  minPerRoom: 1, // минимум наростов в обычной комнате
  maxPerRoom: 3, // максимум наростов в обычной комнате
  startRoomMax: 1, // в стартовой комнате не больше одного (знакомство с механикой)
  hpMin: 3, // минимальная прочность нароста (попаданий)
  hpMax: 6, // максимальная прочность нароста
  radiusMin: 14, // минимальный радиус тела нароста
  radiusMax: 24, // максимальный радиус тела нароста
  inset: 70, // отступ от стен комнаты
  obstaclePad: 30, // зазор от препятствий-стенок
  doorClearance: 70, // не ближе этого к устью дверей (не загораживать проход визуально)
  minSeparation: 90, // минимальная дистанция между наростами
  dropBiomassChance: 0.55, // шанс выпадения биомассы
  dropBiomassMin: 1, // минимум мот биомассы
  dropBiomassMax: 3, // максимум мот биомассы
  dropPlasmaChance: 0.5, // шанс выпадения плазмы
  dropPlasmaMin: 1, // минимум капель плазмы
  dropPlasmaMax: 2, // максимум капель плазмы
  dropArtifactChance: 0.03, // шанс готового артефакта 1-го уровня
  dropCellChance: 0.02, // шанс дружественной клетки (случайный тип)
  fallbackPlasma: 5 // плазма вместо артефакта/клетки, если некуда положить
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

/**
 * Map mode override via URL: `?tunnels=0|false` → portal mode (no tunnels),
 * `?tunnels=1|true` → classic tunnels. Falls back to `DUNGEON.withTunnels`
 * when the param is absent/invalid. Handy for A/B-testing both layouts.
 */
export function resolveWithTunnels(fallback, paramName = 'tunnels') {
  try {
    const raw = new URLSearchParams(window.location.search).get(paramName);
    if (raw === null || raw === '') return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '0' || v === 'false' || v === 'no') return false;
    if (v === '1' || v === 'true' || v === 'yes') return true;
  } catch {
    /* non-browser context */
  }
  return fallback;
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
