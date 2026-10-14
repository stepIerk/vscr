import Phaser from 'phaser';
import {
  COLORS, DUNGEON, PLAYER, HERO_BASE, ENEMIES, ENEMY_LEVEL, SPAWNS, RESOURCE, WEAPON,
  ALLIES, ALLY_TYPES, MUTATIONS, PLASMA, SHOP, ARTIFACTS, ARTIFACT_CATALOG, UPGRADES,
  GROWTHS, ARENA, PORTAL, BOSS, TOUCH, pickEnemyType, resolveSeed, resolveWithTunnels
} from '../config.js';
import { generateLayout, generateWing, roomDegrees } from '../world/generator.js';
import { WorldBuilder } from '../world/WorldBuilder.js';
import { NavGrid } from '../world/navgrid.js';
import { RunState } from '../game/run.js';
import { describeCard } from '../game/cards.js';
import { rollGrowthLoot, rollCount } from '../game/loot.js';
import {
  ARTIFACT_BY_ID, artifactLevel, artifactMaxed, canBuyArtifact, priceOf, generateShopStock
} from '../game/artifacts.js';
import { ui } from '../ui.js';
import { Minimap } from '../ui/minimap.js';
import * as panels from '../ui/progression.js';
import { mulberry32 } from '../world/rng.js';
import { slideVelocity } from '../world/organic.js';
import { isTouchDevice, initTouch } from '../ui/touch.js';

/**
 * Main gameplay scene (procedural tissue dungeon).
 * - Player microbot (WASD/arrows), smooth camera follow.
 * - Seeded rooms + tunnels with real walls/doors (Arcade static bodies).
 * - Room-based enemy spawns with red telegraph markers; cleared rooms stay cleared.
 * - Auto-attack: nearest enemy in range, pooled-capped bullets (die on walls).
 * - Contact damage with i-frames, HP/kills/motes HUD, Game Over + restart.
 * - Resource motes drop from enemies, magnet-free proximity pickup.
 * - Progression: biomass XP levels, 3-card drafts, friendly cells (max 5),
 *   mutations, upgrades, merging, colony UI. Enemies retarget to allies.
 *
 * No per-frame event subscriptions; overlaps/colliders are created once in create().
 * Enemies, bullets, markers, motes and particles are all strictly bounded.
 */

const TEX = {
  dot: 'dot',
  player: 'player',
  shell: 'shell',
  bullet: 'bullet',
  mote: 'mote',
  plasma: 'plasma',
  growth: 'growth',
  stand: 'stand',
  coin: 'coin',
  relic: 'relic',
  tonic: 'tonic',
  portal: 'portal',
  'enemy-a': 'enemy-a',
  'enemy-b': 'enemy-b',
  'enemy-c': 'enemy-c',
  'enemy-d': 'enemy-d',
  'boss-0': 'boss-0',
  'boss-1': 'boss-1',
  foe: 'foe',
  'cell-hunter': 'cell-hunter',
  'cell-defender': 'cell-defender',
  'cell-parasite': 'cell-parasite',
  'cell-hunter-1': 'cell-hunter-1',
  'cell-hunter-2': 'cell-hunter-2',
  'cell-hunter-3': 'cell-hunter-3',
  'cell-defender-1': 'cell-defender-1',
  'cell-defender-2': 'cell-defender-2',
  'cell-defender-3': 'cell-defender-3',
  'cell-parasite-1': 'cell-parasite-1',
  'cell-parasite-2': 'cell-parasite-2',
  'cell-parasite-3': 'cell-parasite-3',
  'cell-medic': 'cell-medic',
  'cell-medic-1': 'cell-medic-1',
  'cell-medic-2': 'cell-medic-2',
  'cell-medic-3': 'cell-medic-3'
};

const TEX_SIZE = { dot: 8, player: 40, shell: 56, bullet: 16, foe: 20, mote: 20, plasma: 24, growth: 48, stand: 64, coin: 20, relic: 28, tonic: 24, portal: 56, 'enemy-a': 32, 'enemy-b': 36, 'enemy-c': 48, 'enemy-d': 40, 'boss-0': 96, 'boss-1': 96, 'cell-hunter': 28, 'cell-defender': 36, 'cell-parasite': 24, 'cell-hunter-1': 28, 'cell-hunter-2': 28, 'cell-hunter-3': 28, 'cell-defender-1': 36, 'cell-defender-2': 36, 'cell-defender-3': 36, 'cell-parasite-1': 24, 'cell-parasite-2': 24, 'cell-parasite-3': 24, 'cell-medic': 30, 'cell-medic-1': 30, 'cell-medic-2': 30, 'cell-medic-3': 30 };

/** Текстура клетки по виду и уровню слияния (уровни сложнее с каждым). */
function allyTexKey(type, merge) {
  const lv = Math.max(1, Math.min(3, merge || 1));
  return `cell-${type}-${lv}`;
}

const MERGE_BADGE = ['I', 'II', 'III', 'IV', 'V'];

// Константы из конфига (читаемость в сцене).
const SHOP_CLEAR = !!SHOP.clearOnEnter; // лавка без монстров сразу «зачищена»
const ARTIFACT_SLOTS = ARTIFACTS.slots; // активных слотов артефактов
/** Читаемые названия улучшений (id → имя из UPGRADES). */
const UPGRADE_NAME = Object.fromEntries(Object.entries(UPGRADES).map(([k, v]) => [k, v.name]));

/**
 * Phaser 4 removed `setTintFill`. Solid hit-flash = tint + FILL mode.
 * Falls back gracefully if the enum path ever changes.
 */
function setFillTint(obj, color) {
  obj.setTint(color);
  const modes = Phaser.TintModes || Phaser.Display?.TintModes;
  if (modes && obj.setTintMode) obj.setTintMode(modes.FILL);
}

function makeCircleTexture(scene, key, size, draw) {
  if (scene.textures.exists(key)) return;
  const g = scene.add.graphics();
  draw(g, size);
  g.generateTexture(key, size, size);
  g.destroy();
}

/** Вершины правильного многоугольника (по умолчанию — «остриё вверх»). */
function polyN(cx, cy, r, n, rot = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

/** Затемнение/осветление hex-цвета (для слоёв плоти врагов и боссов). */
function shade(color, f) {
  const r = Math.min(255, (((color >> 16) & 255) * f) | 0);
  const g = Math.min(255, (((color >> 8) & 255) * f) | 0);
  const b = Math.min(255, ((color & 255) * f) | 0);
  return (r << 16) | (g << 8) | b;
}

function ensureTextures(scene) {
  // Shared 8px soft dot for all particle emitters.
  makeCircleTexture(scene, TEX.dot, TEX_SIZE.dot, (g, s) => {
    g.fillStyle(0xffffff, 1);
    g.fillCircle(s / 2, s / 2, s / 2 - 1);
  });

  // Герой — микробот: угловатый корпус-гексагон, синяя панель, белая обводка.
  makeCircleTexture(scene, TEX.player, TEX_SIZE.player, (g, s) => {
    const c = s / 2;
    // Слабое синее свечение силуэта.
    g.fillStyle(COLORS.machineLine, 0.12);
    g.fillCircle(c, c, 18);
    // Корпус: тёмный сплав + белая обводка («свой» знак).
    const hull = polyN(c, c, 14, 6);
    g.fillStyle(COLORS.machineBody, 1);
    g.fillPoints(hull, true);
    g.lineStyle(2, COLORS.machineMark, 0.95);
    g.strokePoints(hull, true);
    // Внутренняя панель с синим контуром.
    const panel = polyN(c, c, 9, 6);
    g.fillStyle(COLORS.machinePanel, 1);
    g.fillPoints(panel, true);
    g.lineStyle(1.5, COLORS.machineLine, 0.95);
    g.strokePoints(panel, true);
    // Болты по трём вершинам корпуса.
    g.fillStyle(COLORS.machineLine, 1);
    for (const a of [-Math.PI / 2, Math.PI / 6, (Math.PI * 5) / 6]) {
      g.fillCircle(c + Math.cos(a) * 11.5, c + Math.sin(a) * 11.5, 1.4);
    }
    // Боковые сопла.
    g.lineStyle(2, COLORS.machineLine, 0.85);
    g.lineBetween(c - 12.5, c, c - 16, c);
    g.lineBetween(c + 12.5, c, c + 16, c);
    // Антенна сверху (светодиод на конце) и вентиль снизу.
    g.lineStyle(2, COLORS.machineLine, 0.9);
    g.lineBetween(c, c - 10.5, c, c - 15.5);
    g.fillStyle(COLORS.machineLine, 1);
    g.fillCircle(c, c - 17, 1.6);
    g.lineBetween(c, c + 10.5, c, c + 15.5);
    // Ядро-светодиод.
    g.fillStyle(COLORS.machineGlow, 1);
    g.fillCircle(c, c, 4);
    g.fillStyle(0xffffff, 0.95);
    g.fillCircle(c - 1.4, c - 1.4, 1.5);
  });

  // Кольцо-гироскоп: синие зубцы + один белый маркер оси (медленно вращается).
  makeCircleTexture(scene, TEX.shell, TEX_SIZE.shell, (g, s) => {
    const c = s / 2;
    g.lineStyle(1.5, COLORS.machineLine, 0.7);
    g.strokeCircle(c, c, 24);
    g.lineStyle(1, COLORS.machineLine, 0.3);
    g.strokeCircle(c, c, 21);
    g.lineStyle(2.5, COLORS.machineLine, 0.95);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      g.lineBetween(c + Math.cos(a) * 23, c + Math.sin(a) * 23,
        c + Math.cos(a) * 27, c + Math.sin(a) * 27);
    }
    // Один белый зубец — на нём читается вращение.
    const a0 = -Math.PI / 2;
    g.lineStyle(2.5, COLORS.machineMark, 0.95);
    g.lineBetween(c + Math.cos(a0) * 22.5, c + Math.sin(a0) * 22.5,
      c + Math.cos(a0) * 27.5, c + Math.sin(a0) * 27.5);
  });

  // Выстрел микробота: синее ядро (тот же язык, что у корпуса).
  makeCircleTexture(scene, TEX.bullet, TEX_SIZE.bullet, (g, s) => {
    const c = s / 2;
    g.fillStyle(COLORS.bullet, 0.35);
    g.fillCircle(c, c, 7);
    g.fillStyle(COLORS.bullet, 1);
    g.fillCircle(c, c, 4.5);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c, 2);
  });

  // Resource mote: pale glowing green fragment, distinct on the dark floor.
  makeCircleTexture(scene, TEX.mote, TEX_SIZE.mote, (g, s) => {
    const c = s / 2;
    g.fillStyle(COLORS.mote, 0.25);
    g.fillCircle(c, c, 9);
    g.fillStyle(COLORS.mote, 1);
    g.fillCircle(c, c, 5);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c, 2);
  });

  // Plasma drop: magenta-violet droplet with a bright core (≠ green biomass).
  makeCircleTexture(scene, TEX.plasma, TEX_SIZE.plasma, (g, s) => {
    const c = s / 2;
    g.fillStyle(PLASMA.color, 0.22);
    g.fillCircle(c, c, 11);
    g.fillStyle(PLASMA.color, 1);
    g.fillCircle(c, c, PLASMA.radius);
    g.fillStyle(PLASMA.glowColor, 1);
    g.fillCircle(c, c, 3);
  });

  // Growth: fleshy mauve blob with nodules — lootable, distinct from foes.
  if (!scene.textures.exists(TEX.growth)) {
    const s = TEX_SIZE.growth;
    const g = scene.add.graphics();
    const c = s / 2;
    const R = s / 2 - 2;
    g.fillStyle(0x8a4a5e, 1);
    g.fillCircle(c, c, R);
    g.fillStyle(0x6e2f44, 1);
    g.fillCircle(c - 7, c + 6, 7);
    g.fillCircle(c + 8, c + 3, 6);
    g.fillCircle(c + 1, c - 9, 5);
    g.fillStyle(0xc07a90, 1);
    g.fillCircle(c - 4, c - 3, 3.5);
    g.fillCircle(c + 6, c - 6, 2.5);
    g.lineStyle(2, 0x4a1d2b, 0.9);
    g.strokeCircle(c, c, R);
    g.generateTexture(TEX.growth, s, s);
    g.destroy();
  }

  // Shop stand: каменный нарост-постамент — физическая лавка (как в рогаликах).
  if (!scene.textures.exists(TEX.stand)) {
    const s = TEX_SIZE.stand;
    const g = scene.add.graphics();
    const c = s / 2;
    g.fillStyle(0x3a2530, 1);
    g.fillEllipse(c, c + 10, 52, 22);
    g.fillStyle(0x5a3648, 1);
    g.fillEllipse(c, c + 8, 46, 18);
    g.fillStyle(0x6e4458, 1);
    g.fillEllipse(c, c + 4, 34, 16);
    g.fillStyle(0x9a6a80, 1);
    g.fillEllipse(c, c + 1, 22, 10);
    g.lineStyle(2, 0xffd94d, 0.5);
    g.strokeEllipse(c, c + 8, 46, 18);
    g.generateTexture(TEX.stand, s, s);
    g.destroy();
  }

  // Shop icons: товар, лежащий на стенде (цвет = тип товара).
  makeCircleTexture(scene, TEX.coin, TEX_SIZE.coin, (g, s) => {
    const c = s / 2;
    g.fillStyle(0xffd94d, 0.25);
    g.fillCircle(c, c, 9);
    g.fillStyle(0xffd94d, 1);
    g.fillCircle(c, c, 6);
    g.fillStyle(0x7a5a10, 1);
    g.fillCircle(c, c, 2.5);
  });
  makeCircleTexture(scene, TEX.relic, TEX_SIZE.relic, (g, s) => {
    const c = s / 2;
    g.fillStyle(0xff7ada, 0.25);
    g.fillCircle(c, c, 13);
    g.fillStyle(0xff7ada, 1);
    g.fillTriangle(c, c - 10, c + 9, c + 7, c - 9, c + 7);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c - 1, 3);
  });
  makeCircleTexture(scene, TEX.tonic, TEX_SIZE.tonic, (g, s) => {
    const c = s / 2;
    g.fillStyle(0x40e0d0, 0.25);
    g.fillCircle(c, c, 11);
    g.fillStyle(0x40e0d0, 1);
    g.fillRoundedRect(c - 5, c - 8, 10, 16, 3);
    g.fillStyle(0xffffff, 1);
    g.fillRect(c - 5, c - 2, 10, 3);
  });

  // Portal: венозная дыра в плоти — мясистый валик, тёмная глубина внутри.
  // Базовые цвета — как у окружающих внутренностей, тинтом НЕ красится:
  // цвет пары живёт только на тонком кольце-жиле (см. spawnPortalView).
  if (!scene.textures.exists(TEX.portal)) {
    const s = TEX_SIZE.portal;
    const g = scene.add.graphics();
    const c = s / 2;
    // Мягкий ореол плоти вокруг дыры.
    g.fillStyle(COLORS.vein, 0.28);
    g.fillCircle(c, c, 26);
    // Мясистый валик: тёмная плоть → светлее к краю.
    g.fillStyle(COLORS.flesh, 1);
    g.fillCircle(c, c, 22);
    g.fillStyle(COLORS.fleshLight, 1);
    g.fillCircle(c, c, 19);
    g.fillStyle(COLORS.flesh, 1);
    g.fillCircle(c, c, 16);
    // Глубина: тёмный зев → почти чёрное дно.
    g.fillStyle(COLORS.hole, 1);
    g.fillCircle(c, c, 14);
    g.fillStyle(COLORS.holeDeep, 1);
    g.fillCircle(c, c, 10);
    // Узелки ткани на валике (асимметрия живого).
    g.fillStyle(COLORS.wallHighlight, 0.85);
    g.fillCircle(c - 11, c - 8, 3);
    g.fillCircle(c + 12, c + 4, 2.5);
    g.fillCircle(c + 2, c + 13, 2);
    g.fillStyle(COLORS.wallCrevice, 0.8);
    g.fillCircle(c + 9, c - 11, 2.5);
    // Тонкая кромка валика.
    g.lineStyle(2, COLORS.wallEdge, 0.55);
    g.strokeCircle(c, c, 21);
    g.generateTexture(TEX.portal, s, s);
    g.destroy();
  }

  // ------------------------------------------------ враги: язык ткани
  // Тёплое тело + тёмно-бордовая обводка + жгутики. Белого нет: белый = «свой».

  // Enemy A: жгутиковый дротик (быстрый, хрупкий).
  if (!scene.textures.exists(TEX['enemy-a'])) {
    const s = TEX_SIZE['enemy-a'];
    const g = scene.add.graphics();
    const c = s / 2;
    // Тело-капля остриём вверх.
    const body = [
      { x: c, y: 2 },
      { x: c + 8, y: c + 2 },
      { x: c + 6, y: s - 6 },
      { x: c - 6, y: s - 6 },
      { x: c - 8, y: c + 2 }
    ];
    g.fillStyle(COLORS.enemyA, 1);
    g.fillPoints(body, true);
    g.lineStyle(2.5, COLORS.tissueDark, 1);
    g.strokePoints(body, true);
    // Три жгутика сзади.
    g.lineStyle(2, COLORS.enemyA, 0.85);
    g.lineBetween(c - 4, s - 6, c - 6.5, s - 0.5);
    g.lineBetween(c, s - 6, c, s);
    g.lineBetween(c + 4, s - 6, c + 6.5, s - 0.5);
    // Ядро + влажный блик мембраны.
    g.fillStyle(COLORS.tissueDeep, 1);
    g.fillCircle(c, c + 1, 4.5);
    g.fillStyle(0xff9aa4, 1);
    g.fillCircle(c, c + 1, 1.8);
    g.fillStyle(COLORS.tissueWet, 0.5);
    g.fillCircle(c - 3, c - 4, 3);
    g.generateTexture(TEX['enemy-a'], s, s);
    g.destroy();
  }

  // Enemy B: жгутиковый узел (средний).
  if (!scene.textures.exists(TEX['enemy-b'])) {
    const s = TEX_SIZE['enemy-b'];
    const g = scene.add.graphics();
    const c = s / 2;
    // Неровный «мешок»: разные радиусы → живая асимметрия.
    const radii = [12.5, 11, 13, 11.5, 12.5, 11, 12, 11.5];
    const pts = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 - Math.PI / 2 + 0.2;
      pts.push({ x: c + Math.cos(a) * radii[i], y: c + Math.sin(a) * radii[i] });
    }
    g.fillStyle(COLORS.enemyB, 1);
    g.fillPoints(pts, true);
    g.lineStyle(2.5, COLORS.tissueDark, 1);
    g.strokePoints(pts, true);
    // Жгутики по кругу.
    g.lineStyle(2, COLORS.enemyB, 0.8);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.5;
      g.lineBetween(c + Math.cos(a) * 11, c + Math.sin(a) * 11,
        c + Math.cos(a) * 16.5, c + Math.sin(a) * 16.5);
    }
    // Ядро, вакуоль и влажный блик.
    g.fillStyle(COLORS.tissueDeep, 1);
    g.fillCircle(c + 1, c + 1, 6);
    g.fillStyle(0xffc9a0, 0.85);
    g.fillCircle(c - 4, c - 3, 2.5);
    g.fillStyle(COLORS.tissueWet, 0.45);
    g.fillCircle(c - 5, c - 5, 3.5);
    g.generateTexture(TEX['enemy-b'], s, s);
    g.destroy();
  }

  // Enemy C: бронированный узел (тяжёлый).
  if (!scene.textures.exists(TEX['enemy-c'])) {
    const s = TEX_SIZE['enemy-c'];
    const g = scene.add.graphics();
    const c = s / 2;
    const r = s / 2 - 6;
    // Шипы по вершинам (под телом, торчат наружу).
    g.lineStyle(3, COLORS.tissueDark, 1);
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * Math.PI * 2;
      g.lineBetween(c + Math.cos(a) * (r - 1), c + Math.sin(a) * (r - 1),
        c + Math.cos(a) * (r + 5), c + Math.sin(a) * (r + 5));
    }
    // Тело: шестигранник с толстой боровой обводкой.
    const hull = polyN(c, c, r, 6);
    g.fillStyle(COLORS.enemyC, 1);
    g.fillPoints(hull, true);
    g.lineStyle(3, COLORS.tissueDark, 1);
    g.strokePoints(hull, true);
    // Внутренняя мембрана.
    g.lineStyle(2, 0x8a1f2e, 0.9);
    g.strokeCircle(c, c, r - 5);
    // Ядро с вертикальным зрачком (глаз, а не значок).
    g.fillStyle(COLORS.tissueDeep, 1);
    g.fillCircle(c, c, 7);
    g.fillStyle(0xff9aa4, 1);
    g.fillCircle(c, c, 4.5);
    g.fillStyle(COLORS.tissueDark, 1);
    g.fillRect(c - 1, c - 3.5, 2, 7);
    // Влажный блик мембраны.
    g.fillStyle(COLORS.tissueWet, 0.4);
    g.fillCircle(c - 6, c - 8, 4);
    g.generateTexture(TEX['enemy-c'], s, s);
    g.destroy();
  }

  // Enemy D: игломёт (дальнобойный). Ядовитая железа: вздутый мешок,
  // венец игл наружу и зев-дуло по центру. Только синяк-фиолет, белого нет.
  if (!scene.textures.exists(TEX['enemy-d'])) {
    const s = TEX_SIZE['enemy-d'];
    const g = scene.add.graphics();
    const c = s / 2;
    const r = s / 2 - 8;
    // Венец игл (под телом).
    g.lineStyle(2.5, COLORS.tissueDark, 1);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + 0.15;
      g.lineBetween(c + Math.cos(a) * (r - 2), c + Math.sin(a) * (r - 2),
        c + Math.cos(a) * (r + 6), c + Math.sin(a) * (r + 6));
    }
    // Вздутое тело железы.
    g.fillStyle(COLORS.enemyD, 1);
    g.fillCircle(c, c, r);
    g.lineStyle(2.5, COLORS.tissueDark, 1);
    g.strokeCircle(c, c, r);
    // Внутренняя пульсация: тёмное кольцо.
    g.lineStyle(2, COLORS.tissueDeep, 0.9);
    g.strokeCircle(c, c, r - 5);
    // Зев-дуло: тёмная дыра с влажным валиком.
    g.fillStyle(COLORS.tissueDark, 1);
    g.fillCircle(c, c, 6);
    g.fillStyle(COLORS.holeDeep, 1);
    g.fillCircle(c, c, 4);
    g.lineStyle(1.5, COLORS.tissueWet, 0.7);
    g.strokeCircle(c, c, 7);
    // Капли яда на иглах.
    g.fillStyle(COLORS.enemyD, 1);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.6;
      g.fillCircle(c + Math.cos(a) * (r + 5), c + Math.sin(a) * (r + 5), 1.6);
    }
    // Влажный блик мембраны.
    g.fillStyle(COLORS.tissueWet, 0.4);
    g.fillCircle(c - 6, c - 7, 3.5);
    g.generateTexture(TEX['enemy-d'], s, s);
    g.destroy();
  }

  // Боссы: мясистая утроба с зубцами (maw) и костяной «хор» с ресничным венцом.
  BOSS.defs.forEach((def, i) => {
    const key = TEX[`boss-${i}`];
    if (!key || scene.textures.exists(key)) return;
    const s = TEX_SIZE[key] || 96;
    const g = scene.add.graphics();
    const c = s / 2;
    const R = s / 2 - 4;
    const isMaw = def.key === 'maw';
    // Гало плоти.
    g.fillStyle(def.tint, 0.16);
    g.fillCircle(c, c, R);
    // Тело слоями: темнеет к центру.
    g.fillStyle(shade(def.tint, 0.5), 1);
    g.fillCircle(c, c, R - 2);
    g.fillStyle(def.tint, 1);
    g.fillCircle(c, c, R - 8);
    g.fillStyle(shade(def.tint, 0.65), 1);
    g.fillCircle(c, c, R - 14);
    // Зев.
    g.fillStyle(COLORS.tissueDark, 1);
    g.fillCircle(c, c, R - 18);
    g.fillStyle(COLORS.holeDeep, 1);
    g.fillCircle(c, c, R - 24);
    // Зубцы по кромке зева.
    const teeth = isMaw ? 12 : 10;
    const inner = isMaw ? R - 19 : R - 25;
    const outer = isMaw ? R - 12 : R - 18;
    const w = (Math.PI * 2) / teeth / 2.6;
    for (let k = 0; k < teeth; k++) {
      const a = (k / teeth) * Math.PI * 2 + 0.1;
      g.fillStyle(0xf0e2d0, 0.92);
      g.fillPoints([
        { x: c + Math.cos(a - w) * outer, y: c + Math.sin(a - w) * outer },
        { x: c + Math.cos(a + w) * outer, y: c + Math.sin(a + w) * outer },
        { x: c + Math.cos(a) * inner, y: c + Math.sin(a) * inner }
      ], true);
    }
    // Вены по телу (под зубцами и ртами).
    g.lineStyle(2, COLORS.tissueDark, 0.5);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.35;
      g.lineBetween(c + Math.cos(a) * (R - 16), c + Math.sin(a) * (R - 16),
        c + Math.cos(a) * (R - 3), c + Math.sin(a) * (R - 3));
    }
    // «Хор»: венец малых ртов по мясистому кольцу.
    if (!isMaw) {
      const lobes = 8;
      for (let k = 0; k < lobes; k++) {
        const a = (k / lobes) * Math.PI * 2;
        const lx = c + Math.cos(a) * (R - 9);
        const ly = c + Math.sin(a) * (R - 9);
        g.fillStyle(shade(def.tint, 0.9), 1);
        g.fillCircle(lx, ly, 6);
        g.lineStyle(1.5, COLORS.tissueDark, 0.9);
        g.strokeCircle(lx, ly, 6);
        g.fillStyle(COLORS.tissueDark, 1);
        g.fillCircle(lx, ly, 2.6);
      }
    }
    // Шипы по внешнему краю.
    g.lineStyle(4, shade(def.tint, 0.8), 1);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2 + 0.15;
      g.lineBetween(c + Math.cos(a) * (R - 3), c + Math.sin(a) * (R - 3),
        c + Math.cos(a) * (R + 1), c + Math.sin(a) * (R + 1));
    }
    // «Хор»: дополнительный венец ресничек.
    if (!isMaw) {
      g.lineStyle(2, shade(def.tint, 0.9), 0.85);
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        g.lineBetween(c + Math.cos(a) * (R + 1), c + Math.sin(a) * (R + 1),
          c + Math.cos(a) * (R + 4.5), c + Math.sin(a) * (R + 4.5));
      }
    }
    // Влажный блик.
    g.fillStyle(COLORS.tissueWet, 0.22);
    g.fillCircle(c - R * 0.35, c - R * 0.4, R * 0.26);
    g.generateTexture(key, s, s);
    g.destroy();
  });

  // Enemy bullet (boss bullet-hell): hot magenta orb, distinct from hero shot.
  makeCircleTexture(scene, TEX.foe, TEX_SIZE.foe, (g, s) => {
    const c = s / 2;
    g.fillStyle(0xff2d78, 0.35);
    g.fillCircle(c, c, 9);
    g.fillStyle(0xff2d78, 1);
    g.fillCircle(c, c, BOSS.foeRadius);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c, 2.5);
  });

  // Friendly cells: distinct silhouettes, never red (enemies stay red).
  // Каждый уровень слияния чуть сложнее: кольца, шипы, яркое ядро.
  for (const type of ['hunter', 'defender', 'parasite', 'medic']) {
    for (let lv = 1; lv <= 3; lv++) {
      const key = TEX[`cell-${type}-${lv}`];
      if (!key || scene.textures.exists(key)) continue;
      const s = TEX_SIZE[key];
      const g = scene.add.graphics();
      drawAllyCell(g, s, type, lv);
      g.generateTexture(key, s, s);
      g.destroy();
    }
  }
}

/**
 * Клетки колонии — мини-микроботы той же машинной семьи, что и герой:
 * тёмный корпус + акцент роли + белая обводка (белый = «свой», у врагов его нет).
 * Уровни слияния: lv2 — панели/болты, lv3 — гало и яркое ядро.
 */
/**
 * Клетки колонии — мини-микроботы той же машинной семьи, что и герой:
 * тёмный корпус + акцент роли + белая обводка (белый = «свой»).
 * Уровень слияния меняет силуэт: lv2 добавляет лезвия/накладки/лапы,
 * lv3 — хвостовые булы, внешние пластины, корону шипов и гало.
 */
function drawAllyCell(g, s, type, lv) {
  const c = s / 2;
  const BODY = COLORS.machineBody;
  const MARK = COLORS.machineMark;
  /** Точка по углу и расстоянию от центра. */
  const P = (a, r) => ({ x: c + Math.cos(a) * r, y: c + Math.sin(a) * r });

  if (type === 'hunter') {
    const accent = ALLY_TYPES.hunter.tint;
    // Корпус-трапеция носом вверх.
    const hull = [
      { x: c - 4, y: s - 12 },
      { x: c + 4, y: s - 12 },
      { x: c + 9, y: s - 3 },
      { x: c - 9, y: s - 3 }
    ];
    g.fillStyle(BODY, 1);
    g.fillPoints(hull, true);
    // Акцентная панель-кокпит.
    g.fillStyle(accent, 0.88);
    g.fillPoints([
      { x: c, y: s - 12.5 },
      { x: c + 4.5, y: s - 6.5 },
      { x: c, y: s - 4 },
      { x: c - 4.5, y: s - 6.5 }
    ], true);
    g.lineStyle(2, MARK, 1);
    g.strokePoints(hull, true);
    // Загнутые плавники-крылья.
    g.lineStyle(2.5, MARK, 1);
    g.lineBetween(c - 4, s - 12, c - 9.5, s - 18.5);
    g.lineBetween(c + 4, s - 12, c + 9.5, s - 18.5);
    g.fillStyle(accent, 1);
    g.fillCircle(c - 9.5, s - 18.5, 1.4);
    g.fillCircle(c + 9.5, s - 18.5, 1.4);
    // Ядро-индикатор.
    g.fillStyle(COLORS.machineGlow, lv >= 3 ? 1 : 0.95);
    g.fillCircle(c, c + 3, lv >= 3 ? 2.6 : 2.2);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c + 3, lv >= 2 ? 1.1 : 0.8);
    if (lv >= 2) {
      // Боковые лезвия: силуэт становится шире.
      g.lineStyle(2, MARK, 0.95);
      g.lineBetween(c - 8.5, s - 6, c - 12.5, s - 8.5);
      g.lineBetween(c + 8.5, s - 6, c + 12.5, s - 8.5);
      g.fillStyle(accent, 1);
      g.fillCircle(c - 12.5, s - 8.5, 1.2);
      g.fillCircle(c + 12.5, s - 8.5, 1.2);
      // Внутренний контур корпуса.
      g.lineStyle(1, MARK, 0.35);
      g.strokePoints([
        { x: c - 2.5, y: s - 11 },
        { x: c + 2.5, y: s - 11 },
        { x: c + 6.5, y: s - 4.5 },
        { x: c - 6.5, y: s - 4.5 }
      ], true);
    }
    if (lv >= 3) {
      // Хвостовые булы: силуэт вытягивается назад.
      g.lineStyle(2, MARK, 0.9);
      g.lineBetween(c - 5.5, s - 3, c - 8.5, s - 1);
      g.lineBetween(c + 5.5, s - 3, c + 8.5, s - 1);
      g.fillStyle(accent, 0.85);
      g.fillPoints([
        { x: c - 8.5, y: s - 1 },
        { x: c - 5.5, y: s - 3 },
        { x: c - 6.5, y: s - 1 }
      ], true);
      g.fillPoints([
        { x: c + 8.5, y: s - 1 },
        { x: c + 5.5, y: s - 3 },
        { x: c + 6.5, y: s - 1 }
      ], true);
      // Гало вокруг дрона.
      g.lineStyle(1.5, accent, 0.4);
      g.strokeCircle(c, c, c - 1.5);
    }
  } else if (type === 'defender') {
    const accent = ALLY_TYPES.defender.tint;
    const r = s / 2 - 2;
    const hull = polyN(c, c, r, 6);
    g.fillStyle(BODY, 1);
    g.fillPoints(hull, true);
    // Панель-щит акцентного цвета.
    const plate = polyN(c, c, r * 0.72, 6);
    g.fillStyle(accent, 0.85);
    g.fillPoints(plate, true);
    // Швы панели.
    g.lineStyle(1.5, BODY, 0.7);
    g.lineBetween(c - r * 0.55, c, c + r * 0.55, c);
    g.lineBetween(c - r * 0.28, c - r * 0.48, c + r * 0.28, c - r * 0.48);
    g.lineBetween(c - r * 0.28, c + r * 0.48, c + r * 0.28, c + r * 0.48);
    g.lineStyle(2.5, MARK, 1);
    g.strokePoints(hull, true);
    // Ядро-индикатор.
    g.fillStyle(COLORS.machineGlow, 1);
    g.fillCircle(c, c, lv >= 3 ? 4 : 3.2);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c, lv >= 2 ? 1.6 : 1.2);
    if (lv >= 2) {
      // Усиленная кромка: накладки по граням + болты по вершинам.
      g.lineStyle(2.5, MARK, 0.95);
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + ((i + 0.5) / 6) * Math.PI * 2;
        const p1 = P(a, r * 0.92);
        const p2 = P(a, r * 1.1);
        g.lineBetween(p1.x, p1.y, p2.x, p2.y);
      }
      g.fillStyle(MARK, 0.95);
      for (const p of hull) g.fillCircle(p.x, p.y, 1.5);
      g.lineStyle(1.5, MARK, 0.45);
      g.strokePoints(polyN(c, c, r * 0.86, 6), true);
    }
    if (lv >= 3) {
      // Внешние пластины-щиты по граням + гало.
      g.fillStyle(accent, 0.9);
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + ((i + 0.5) / 6) * Math.PI * 2;
        g.fillPoints([
          P(a - 0.16, r * 0.95),
          P(a + 0.16, r * 0.95),
          P(a + 0.12, r * 1.06),
          P(a - 0.12, r * 1.06)
        ], true);
      }
      g.lineStyle(1.5, accent, 0.45);
      g.strokeCircle(c, c, r * 1.12);
    }
  } else if (type === 'medic') {
    const accent = ALLY_TYPES.medic.tint;
    // Медик — ремонтный дрон: круглый корпус-капсула с янтарным крестом.
    // lv1: капсула + крест + антенна. lv2: боковые манипуляторы-захваты.
    // lv3: рой нанитов по орбите + гало.
    if (lv >= 2) {
      // Манипуляторы-захваты (под корпусом): две угловые «клешни».
      g.lineStyle(2, MARK, 0.9);
      g.lineBetween(c - 6, c + 4, c - 11, c + 8);
      g.lineBetween(c - 11, c + 8, c - 11, c + 11);
      g.lineBetween(c + 6, c + 4, c + 11, c + 8);
      g.lineBetween(c + 11, c + 8, c + 11, c + 11);
      g.fillStyle(accent, 1);
      g.fillCircle(c - 11, c + 11, 1.4);
      g.fillCircle(c + 11, c + 11, 1.4);
    }
    // Капсула.
    g.fillStyle(BODY, 1);
    g.fillCircle(c, c, 8);
    g.lineStyle(2, MARK, 1);
    g.strokeCircle(c, c, 8);
    // Янтарный крест.
    g.fillStyle(accent, 1);
    g.fillRect(c - 2, c - 5.5, 4, 11);
    g.fillRect(c - 5.5, c - 2, 11, 4);
    // Ядро-индикатор в центре креста.
    g.fillStyle(COLORS.machineGlow, 1);
    g.fillCircle(c, c, lv >= 3 ? 2 : 1.6);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c, lv >= 2 ? 1 : 0.7);
    // Антенна со светодиодом.
    g.lineStyle(1.5, MARK, 0.9);
    g.lineBetween(c + 4, c - 6, c + 7, c - 10.5);
    g.fillStyle(accent, 1);
    g.fillCircle(c + 7, c - 10.5, 1.5);
    if (lv >= 3) {
      // Рой нанитов: три точки по орбите + гало.
      g.fillStyle(accent, 0.95);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 - Math.PI / 2;
        g.fillCircle(c + Math.cos(a) * 11.5, c + Math.sin(a) * 11.5, 1.5);
      }
      g.lineStyle(1, MARK, 0.5);
      g.strokeCircle(c, c, 11.5);
      g.lineStyle(1.5, accent, 0.4);
      g.strokeCircle(c, c, c - 1.5);
    }
  } else {
    const accent = ALLY_TYPES.parasite.tint;
    // Лапы-манипуляторы (рисуются под телом капсулы).
    const legAngles = lv >= 2
      ? [Math.PI / 6, Math.PI / 2, (Math.PI * 5) / 6, (Math.PI * 7) / 6, (Math.PI * 11) / 6]
      : [Math.PI / 2, (Math.PI * 7) / 6, (Math.PI * 11) / 6];
    const legOut = lv >= 3 ? 11.5 : 10.5;
    g.lineStyle(2, MARK, 0.9);
    for (const a of legAngles) {
      const p1 = P(a, 6);
      const p2 = P(a, legOut);
      g.lineBetween(p1.x, p1.y, p2.x, p2.y);
    }
    // Капсула.
    g.fillStyle(BODY, 1);
    g.fillCircle(c, c, 7.5);
    g.lineStyle(2, MARK, 1);
    g.strokeCircle(c, c, 7.5);
    // Акцентное кольцо и присоска.
    g.lineStyle(lv >= 2 ? 2.5 : 2, accent, 1);
    g.strokeCircle(c, c, 5.2);
    g.fillStyle(0x04090e, 1);
    g.fillCircle(c, c, 2.8);
    g.fillStyle(COLORS.machineGlow, 1);
    g.fillCircle(c, c, lv >= 3 ? 1.8 : 1.4);
    if (lv >= 2) {
      // Дорсальные шипы: колючий силуэт.
      g.lineStyle(2, MARK, 0.9);
      g.lineBetween(c - 3, c - 5.5, c - 4.5, c - 9.5);
      g.lineBetween(c + 3, c - 5.5, c + 4.5, c - 9.5);
      // Акцентные «подошвы» на лапах.
      g.fillStyle(accent, 1);
      for (const a of legAngles) {
        const p = P(a, legOut);
        g.fillCircle(p.x, p.y, 1.4);
      }
    }
    if (lv >= 3) {
      // Корона шипов + второй белый контур.
      g.lineStyle(1.8, MARK, 0.95);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const p1 = P(a, 7);
        const p2 = P(a, 11.5);
        g.lineBetween(p1.x, p1.y, p2.x, p2.y);
      }
      g.lineStyle(1, MARK, 0.5);
      g.strokeCircle(c, c, 9);
      g.fillStyle(0xffffff, 1);
      g.fillCircle(c, c, 1);
    }
  }
}

export class GameScene extends Phaser.Scene {
  constructor() {
    super('Game');
  }

  init() {
    // Full state reset so scene.restart() is a clean reboot on the same seed.
    this.seed = resolveSeed();
    console.log(`[viscera] world seed: ${this.seed} — reload for a new map, ?seed=N to reproduce`);
    this.run = new RunState();
    this.hero = null; // cached computed hero stats (dirty-flagged by cards)
    this.hp = HERO_BASE.maxHealth;
    this.kills = 0;
    this.bossesBeaten = 0; // игломёты открываются после второго босса
    this.motes = 0;
    this.elapsedMs = 0;
    this.fireAcc = 0;
    this.invulnUntil = 0;
    this.isGameOver = false;
    this.modalOpen = false; // draft / colony overlay up (scene paused)
    this.pendingLevels = 0;
    this.allyViews = new Map(); // cellId -> {sprite, barBg, bar, badge}
    this.retargetAcc = 0;
    this.lastHudHp = -1;
    this.lastHudKills = -1;
    this.lastHudMotes = -1;
    this.lastHudPlasma = -1;
    this.lastHudBio = -1;
    this.lastHudArtifacts = -1;
    this.lastHudLevel = -1;
    this.lastHudXp = -1;
    this.shellAngle = 0;
    this.markers = []; // pending spawn telegraphs {view, timer, roomId}
    this.joyVec = { x: 0, y: 0 }; // virtual stick (touch); consumed in updateMovement
    this.stashedCells = []; // colony hidden for boss fights (data kept, views gone)
    this.gatherMode = false; // сбор: клетки сходятся к герою, врагов игнорируют
    this.bossActive = null; // roomId of the running boss fight (null = none)
    this.retryAcc = 0;
    this.expandAcc = 0;
    this.wingCount = 0;
    this.expandRetryAt = 0;
    this.currentRoom = null;
  }

  /** Phaser-текстура → dataURL для DOM-панелей (с кешем, дёшево). */
  texDataURL(key) {
    if (!this._texURL) this._texURL = new Map();
    if (this._texURL.has(key)) return this._texURL.get(key);
    let url = null;
    try {
      const t = this.textures && this.textures.get ? this.textures.get(key) : null;
      const src = t && t.getSourceImage ? t.getSourceImage() : null;
      const cv = src && src.canvas ? src.canvas : src;
      if (cv && cv.toDataURL) url = cv.toDataURL();
    } catch {
      url = null;
    }
    this._texURL.set(key, url);
    return url;
  }

  /** Computed hero stats, cached until a card/merge dirties them. */
  heroStats() {
    if (!this.hero) this.hero = this.run.computeHero();
    return this.hero;
  }

  dirtyHero() {
    this.hero = null;
  }

  create() {
    this.physics.resume();
    ensureTextures(this);

    // --- Procedural tissue: rooms + tunnels (seeded, deterministic) ---
    const t0 = performance.now();
    // Режим карты: тоннели (по умолчанию) или врата-порталы (?tunnels=0).
    const withTunnels = resolveWithTunnels(DUNGEON.withTunnels);
    this.portalMode = withTunnels === false;
    this.layout = generateLayout(this.seed, {
      roomCountMin: DUNGEON.roomCountMin,
      roomCountMax: DUNGEON.roomCountMax,
      roomMin: DUNGEON.roomMin,
      roomMax: DUNGEON.roomMax,
      startRoomMin: DUNGEON.startRoomMin,
      tunnelWidth: DUNGEON.tunnelWidth,
      wall: DUNGEON.wall,
      spawnAreaPer: DUNGEON.spawnAreaPer,
      spawnMin: DUNGEON.spawnMin,
      spawnMax: DUNGEON.spawnMax,
      withTunnels
    });
    this.worldApi = new WorldBuilder(this, this.layout, COLORS).build();
    this.builder = this.worldApi.builder;
    const nav0 = performance.now();
    this.nav = new NavGrid(this.layout);
    const navMs = (performance.now() - nav0).toFixed(1);
    window.__world = { layout: this.layout, seed: this.seed, nav: this.nav };
    const genMs = (performance.now() - t0).toFixed(1);
    console.log(
      `[viscera] layout: ${this.layout.rooms.length} rooms, ` +
      `${this.layout.corridors.length} tunnels, ${this.layout.solids.length} solids in ${genMs}ms + nav ${navMs}ms`
    );
    if (this.layout.issues.length) console.warn('[viscera] layout issues:', this.layout.issues);

    ui.reset();
    ui.setSeed(this.seed);
    ui.setLevel(this.run.level, this.run.xp, this.run.requiredXp());
    ui.setColonyCount(0, this.run.maxCells);
    panels.hideAll();
    this.minimap = new Minimap();
    this.minimap.renderBase(this.layout);
    this.layout.rooms[0].visited = true;
    this.minimapAcc = 0;

    const b = this.worldApi.bounds;
    this.playBounds = b;
    this.physics.world.setBounds(b.x, b.y, b.w, b.h);

    // --- Groups (bounded; no accumulation) ---
    this.enemies = this.physics.add.group();
    this.bullets = this.physics.add.group({ maxSize: WEAPON.bulletPoolMax });
    this.foeShots = this.physics.add.group(); // вражеские снаряды боссов (bullet-hell)
    this.resources = this.physics.add.group();
    this.plasma = this.physics.add.group(); // вторая валюта
    this.growths = this.physics.add.group(); // разрушаемые наросты (не блокируют)
    this.stands = this.physics.add.staticGroup(); // стенды лавки (блокируют, покупаем на E)
    this.standViews = []; // { base, item, label, roomId, kind, key, price, sold }
    this.standPrompt = null;
    this.arenaBarriers = this.physics.add.staticGroup(); // барьеры закрытых дверей арены
    this.allies = this.physics.add.group();
    this.portalGroup = this.physics.add.staticGroup(); // тела врат (overlap, не блокируют)
    this.portalViews = new Map(); // portalId -> { zone, ring, data, locked }
    this.portalCooldownUntil = 0;
    this.spawnGrowths(this.layout.rooms[0]); // наросты стартовой комнаты — после создания групп

    // --- Player (center of the safe start room) ---
    const { x: cx, y: cy } = this.worldApi.start;
    this.player = this.physics.add.sprite(cx, cy, TEX.player);
    this.player.setDepth(6);
    this.player.setCollideWorldBounds(true);
    this.player.body.setCircle(PLAYER.bodyRadius * 0.85, 8, 8);
    this.shell = this.add.image(cx, cy, TEX.shell).setDepth(7);

    // --- Particles (one flow emitter + burst emitters, all short-lived) ---
    this.trail = this.add.particles(0, 0, TEX.dot, {
      speed: { min: 10, max: 50 },
      lifespan: 450,
      scale: { start: 0.8, end: 0 },
      alpha: { start: 0.55, end: 0 },
      tint: COLORS.sparkTrail,
      frequency: 70,
      blendMode: 'ADD'
    });
    this.trail.setDepth(5);
    this.trail.startFollow(this.player);

    this.hitSparks = this.add.particles(0, 0, TEX.dot, {
      speed: { min: 90, max: 260 },
      lifespan: 320,
      scale: { start: 0.9, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: COLORS.sparkHit,
      emitting: false,
      blendMode: 'ADD'
    });
    this.hitSparks.setDepth(9);

    this.deathSparks = this.add.particles(0, 0, TEX.dot, {
      speed: { min: 60, max: 320 },
      lifespan: 550,
      scale: { start: 1.1, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: [COLORS.sparkDeath, 0xff7a3d, 0xffffff],
      emitting: false,
      blendMode: 'ADD'
    });
    this.deathSparks.setDepth(9);

    this.moteSparks = this.add.particles(0, 0, TEX.dot, {
      speed: { min: 40, max: 160 },
      lifespan: 350,
      scale: { start: 0.8, end: 0 },
      alpha: { start: 1, end: 0 },
      tint: COLORS.sparkMote,
      emitting: false,
      blendMode: 'ADD'
    });
    this.moteSparks.setDepth(9);

    // --- Camera ---
    this.cameras.main.setBounds(b.x, b.y, b.w, b.h);
    this.cameras.main.startFollow(this.player, true, 0.09, 0.09);
    this.cameras.main.setBackgroundColor('#0a0507');

    // --- Touch: floating stick; focus lifts above the command bar ---
    if (isTouchDevice()) {
      initTouch({
        onMove: (x, y) => { this.joyVec.x = x; this.joyVec.y = y; }
      });
    }
    // Герой держится в центре зоны над нижней панелью — бой не прячется
    // под панелью и не уезжает под палец со стиком (сдвиг отрицательный:
    // followOffset вычитается из точки, за которой следит камера).
    // Высота панели меряется по-настоящему (safe-area и медиазапросы меняют
    // её), поэтому раз в секунду подтягиваем — сцена убьёт таймер сама.
    const applyLift = () => {
      const barEl = document.getElementById('bottom-bar');
      const barH = barEl ? barEl.offsetHeight : 0;
      const lift = barH > 0
        ? -Math.round(barH / 2) - (isTouchDevice() ? 34 : 0)
        : TOUCH.followOffsetY;
      if (!this.cameras.main.followOffset || this.cameras.main.followOffset.y !== lift) {
        this.cameras.main.setFollowOffset(0, lift);
      }
    };
    applyLift();
    this.time.addEvent({ delay: 1000, loop: true, callback: applyLift });

    // --- Input (created once per scene run; auto-cleaned on shutdown) ---
    this.cursors = this.input.keyboard ? this.input.keyboard.createCursorKeys() : null;
    this.wasd = this.input.keyboard
      ? this.input.keyboard.addKeys('W,A,S,D,E')
      : null;
    this.interactKey = this.input.keyboard
      ? this.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.E)
      : null;
    this._interactWasDown = false;

    // --- Collisions (registered once, never per-frame) ---
    // NOTE: hero/enemy and enemy/cell damage is timer-based at attack range
    // (single delivery path — no double hits from overlap + timer).
    this.physics.add.collider(this.player, this.worldApi.bodies);
    this.physics.add.collider(this.enemies, this.worldApi.bodies);
    this.physics.add.collider(this.enemies, this.enemies); // de-stack chasers
    this.physics.add.collider(this.player, this.stands); // стенды — твёрдые
    this.physics.add.collider(this.enemies, this.stands);
    this.physics.add.collider(this.allies, this.stands);
    // Барьеры арены держат всех внутри: игрока, врагов, колонию, стенды не нужны.
    this.physics.add.collider(this.player, this.arenaBarriers);
    this.physics.add.collider(this.enemies, this.arenaBarriers);
    this.physics.add.collider(this.allies, this.arenaBarriers);
    this.physics.add.collider(this.allies, this.worldApi.bodies);
    this.physics.add.collider(this.allies, this.allies); // de-stack colony
    this.physics.add.collider(this.bullets, this.worldApi.bodies, this.onBulletWall, null, this);
    // Барьеры арены держат и снаряды — нельзя расстрелять соседнюю комнату сквозь дверь.
    this.physics.add.collider(this.bullets, this.arenaBarriers, this.onBulletWall, null, this);
    this.physics.add.overlap(this.bullets, this.enemies, this.onBulletHit, null, this);
    // Наросты ловят снаряды overlap'ом (без collider — не блокируют движение).
    this.physics.add.overlap(this.bullets, this.growths, this.onBulletGrowth, null, this);
    // Врата — overlap-триггер: вход в зону телепортирует игрока и колонию.
    this.physics.add.overlap(this.player, this.portalGroup, this.onPortalTouch, null, this);
    // Снаряды боссов: гасят о стены/барьеры, бьют героя и колонию.
    this.physics.add.collider(this.foeShots, this.worldApi.bodies, this.onFoeShotWall, null, this);
    this.physics.add.collider(this.foeShots, this.arenaBarriers, this.onFoeShotWall, null, this);
    this.physics.add.overlap(this.player, this.foeShots, this.onFoeShotPlayer, null, this);
    this.physics.add.overlap(this.allies, this.foeShots, this.onFoeShotAlly, null, this);
    this.fireAcc = this.heroStats().intervalMs; // first shot ready immediately
    this.spawnAllPortals();
    this.refreshColonyStrip();
  }

  // ----------------------------------------------------------------- update

  update(time, delta) {
    if (this.isGameOver || !this.player || !this.player.active) return;
    const dt = Math.min(delta, 100); // clamp tab-switch spikes
    this.elapsedMs += dt;
    this.frameDt = dt;

    // Safety net BEFORE new input applies: positions are post-physics here.
    // Arcade skips separation when overlap exceeds one step's motion + bias
    // (its anti-teleport guard), which a combat knockback can trigger — then
    // input would ratchet the player through the wall. Resolve any embedding
    // deterministically so a pass-through can never accumulate.
    this.resolveEmbeddings();
    this.updateMovement();
    this.slideAlongTissue(this.player, PLAYER.bodyRadius * 0.85);
    this.updateRooms(dt);
    this.updateWeapon(dt);
    this.updateEnemies(dt);
    this.updateBosses(dt);
    this.resolveEnemyEmbeddings();
    this.updateAllies(dt);
    this.updateBullets(dt);
    this.updateFoeShots(dt);
    this.updatePickups();
    this.applyRegen(dt);
    this.updateShell(dt);
    this.updateAllyViews();
    this.updateShopStands();
    this.updatePortals();
    this.minimapAcc += dt;
    if (this.minimapAcc >= 300) {
      this.minimapAcc = 0;
      this.minimap.update(this.player.x, this.player.y, this.layout, this.currentRoom ? this.currentRoom.id : null);
    }
    // Сайд-панель колонии: HP дрейфует в бою — подтягиваем не чаще 0.8с.
    this.sideAcc = (this.sideAcc || 0) + dt;
    if (this.sideAcc >= 800) {
      this.sideAcc = 0;
      if (!this.modalOpen) this.refreshColonyStrip();
    }
    this.pushHud();
  }

  /**
   * Push a body out of any wall/obstacle it ended up inside.
   * Only triggers on real embedding (center inside a solid) — normal wall
   * contact keeps the center outside, so gameplay is otherwise untouched.
   * Two guards against jitter:
   * - solids thinner than ~a body diameter are skipped: the body straddles
   *   them and arcade face contact handles it (teleporting off a 12px stub
   *   every frame is what caused back-and-forth jerking at door frames);
   * - long walls push along their normal (never out the end of a run);
   *   compact blocks push out the nearest face (correct approach side).
   * `body.reset` also zeroes the frame's velocity, halting the drive inward.
   * Returns true if a resolution happened (velocity was stopped).
   */
  pushOutOfSolids(gameObject, bodyRadius) {
    const r = bodyRadius;
    const minDim = r * 2 - 4; // ~20px: thinner fragments are straddled, not embedded
    // Портальный режим: стен-тел нет, твёрдые только наросты-препятствия.
    const solids = this.portalMode && this.builder
      ? this.builder.collidableSolids()
      : this.layout.solids;
    const p = gameObject;
    for (let pass = 0; pass < 4; pass++) {
      const s = solids.find(
        (q) =>
          Math.min(q.w, q.h) > minDim &&
          p.x > q.x + 1 && p.x < q.x + q.w - 1 && p.y > q.y + 1 && p.y < q.y + q.h - 1
      );
      if (!s) return pass > 0;
      const longH = s.w >= s.h * 3; // long horizontal run: push vertically
      const longV = s.h >= s.w * 3; // long vertical run: push horizontally
      if (!longH && !longV) {
        // Compact block: nearest face (correct approach side, small move).
        const dxl = p.x - s.x;
        const dxr = s.x + s.w - p.x;
        const dyt = p.y - s.y;
        const dyb = s.y + s.h - p.y;
        const m = Math.min(dxl, dxr, dyt, dyb);
        if (m === dxl) p.body.reset(s.x - r, p.y);
        else if (m === dxr) p.body.reset(s.x + s.w + r, p.y);
        else if (m === dyt) p.body.reset(p.x, s.y - r);
        else p.body.reset(p.x, s.y + s.h + r);
      } else if (longH) {
        if (p.y - s.y < s.y + s.h - p.y) p.body.reset(p.x, s.y - r);
        else p.body.reset(p.x, s.y + s.h + r);
      } else {
        if (p.x - s.x < s.x + s.w - p.x) p.body.reset(s.x - r, p.y);
        else p.body.reset(s.x + s.w + r, p.y);
      }
    }
    return true;
  }

  resolveEmbeddings() {
    const p = this.player;
    if (!p || !p.active) return;
    this.pushOutOfSolids(p, PLAYER.bodyRadius * 0.85);
    this.constrainToTissue(p, PLAYER.bodyRadius * 0.85);
  }

  resolveEnemyEmbeddings() {
    // Enemies can ratchet through walls the same way (separation shoves trip
    // arcade's anti-teleport guard). Same deterministic rescue keeps them out.
    for (const e of this.enemies.getChildren()) {
      if (!e.active) continue;
      const er = (e.getData('radius') || 14) * 0.8;
      this.pushOutOfSolids(e, er);
      this.constrainToTissue(e, er);
      this.slideAlongTissue(e, er);
    }
  }

  /**
   * Слайд вдоль плоти — лечит дрожание у стены. Классика жанра: ввод каждый
   * кадр снова давит скоростью в стену, а коррекция отталкивает назад —
   * получается осцилляция. Вместо этого проецируем шаг: целиком свободен —
   * едем, иначе пробуем оси по отдельности (скольжение), иначе стоим.
   * Проверка та же, что держит тело (полигон + наросты), так что проникно-
   * вения нет и дёргать нечему. В тоннельном legacy — no-op.
   */
  slideAlongTissue(gameObject, bodyRadius) {
    if (!this.portalMode || !gameObject || !gameObject.active || !gameObject.body) return;
    const vx = gameObject.body.velocity.x;
    const vy = gameObject.body.velocity.y;
    if (vx === 0 && vy === 0) return;
    const step = Math.min(Math.max(this.frameDt || 16, 1), 100) / 1000;
    const walk = (x, y) => this.builder.isWalkable(x, y, bodyRadius);
    const [nvx, nvy] = slideVelocity(walk, gameObject.x, gameObject.y, vx, vy, step, bodyRadius);
    if (nvx !== vx || nvy !== vy) gameObject.setVelocity(nvx, nvy);
  }

  /**
   * Полигон-контейнмент (портальный режим): удерживает тело внутри того же
   * рисуемого контура пола, что видит игрок. Комнаты герметичны, так что
   * это и есть «стена». `body.reset` заодно гасит скорость в стену.
   * В тоннельном legacy — no-op, там держат прямоугольные тела.
   */
  constrainToTissue(gameObject, bodyRadius) {
    if (!this.portalMode || !this.builder) return false;
    const p = gameObject;
    let room = this.worldApi.roomAt(p.x, p.y);
    if (!room) {
      // Вне всех rect (не должно случаться) — ближайшая по центру.
      let best = null;
      let bestD2 = Infinity;
      for (const r of this.layout.rooms) {
        const d2 = (r.cx - p.x) * (r.cx - p.x) + (r.cy - p.y) * (r.cy - p.y);
        if (d2 < bestD2) { bestD2 = d2; best = r; }
      }
      room = best;
    }
    if (!room) return false;
    const spot = this.builder.constrainToRoom(room, p.x, p.y, bodyRadius);
    if (spot.x !== p.x || spot.y !== p.y) {
      p.body.reset(spot.x, spot.y);
      return true;
    }
    return false;
  }

  updateMovement() {
    let dx = 0;
    let dy = 0;
    if (this.cursors) {
      if (this.cursors.left.isDown) dx -= 1;
      if (this.cursors.right.isDown) dx += 1;
      if (this.cursors.up.isDown) dy -= 1;
      if (this.cursors.down.isDown) dy += 1;
    }
    if (this.wasd) {
      if (this.wasd.A && this.wasd.A.isDown) dx -= 1;
      if (this.wasd.D && this.wasd.D.isDown) dx += 1;
      if (this.wasd.W && this.wasd.W.isDown) dy -= 1;
      if (this.wasd.S && this.wasd.S.isDown) dy += 1;
      // E — купить со стенда (по нажатию, не по удержанию).
      const eDown = !!((this.wasd.E && this.wasd.E.isDown) || (this.interactKey && this.interactKey.isDown));
      if (eDown && !this._interactWasDown) this.tryBuyNearStand();
      this._interactWasDown = eDown;
    }
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
    }
    if (this.joyVec && (this.joyVec.x !== 0 || this.joyVec.y !== 0)) {
      // Виртуальный стик складывается с клавиатурой, нормализация общая.
      dx += this.joyVec.x;
      dy += this.joyVec.y;
      const len = Math.hypot(dx, dy) || 1;
      const cl = Math.min(len, 1);
      dx = (dx / len) * cl;
      dy = (dy / len) * cl;
    }
    // Arcade velocity is inherently FPS-independent (px/sec); walls resolve via collider.
    this.player.setVelocity(dx * this.heroStats().moveSpeed, dy * this.heroStats().moveSpeed);
  }

  applyRegen(dt) {
    const hs = this.heroStats();
    if (hs.regen > 0 && this.hp > 0 && this.hp < hs.maxHealth) {
      this.hp = Math.min(hs.maxHealth, this.hp + (hs.regen * dt) / 1000);
    }
  }

  // ---------------------------------------------------------- room spawning

  updateRooms(dt) {
    this.currentRoom = this.worldApi.roomAt(this.player.x, this.player.y);
    if (this.currentRoom) {
      this.currentRoom.visited = true; // minimap marks walked rooms
      if (!this.currentRoom.isStart && !this.currentRoom.activated) {
        this.activateRoom(this.currentRoom);
      }
    }
    // Retry deferred spawn points on a slow tick (not per-frame timers).
    this.retryAcc += dt;
    if (this.retryAcc >= SPAWNS.retryMs) {
      this.retryAcc = 0;
      for (const r of this.layout.rooms) {
        if (r.activated && !r.cleared && r.queue && r.queue.length) this.tryQueue(r);
      }
    }
    this.checkExpansion(dt);
  }

  activateRoom(room) {
    room.activated = true;
    room.spawnedTotal = 0;
    room.markersPending = 0;
    this.refreshRoomPortals(room);
    // Босс-зал: колония прячется, выходит босс крыла. Обычных спавнов нет.
    if (room.type === 'boss') {
      room.cleared = false;
      room.queue = [];
      this.spawnGrowths(room);
      this.stashColony();
      this.lockArena(room);
      this.spawnBoss(room);
      return;
    }
    // Лавка: монстров нет, считается зачищенной сразу, товар — физические стенды.
    if (room.type === 'shop') {
      room.cleared = SHOP_CLEAR;
      room.queue = [];
      if (!room.stock || !room.stock.length) {
        // Товар детерминирован для комнаты (seed + id) — сиды воспроизводимы.
        const rng = mulberry32(((this.seed ^ Math.imul(room.id + 1, 0x9e3779b9)) >>> 0) || 7);
        room.stock = generateShopStock(this.run, rng);
        room.stockBought = room.stockBought || [];
        room.visitsHere = (room.visitsHere || 0) + 1;
        this.run.noteShopVisit();
      }
      this.spawnShopStands(room); // идемпотентно: второй вход не дублирует
      ui.toast('Лавка: подойди к стенду и нажми E, чтобы купить');
      return;
    }
    this.spawnGrowths(room); // наросты появляются вместе с активацией комнаты
    room.cleared = false;
    // Арена: колония втягивается внутрь, двери закрываются, затем бой.
    this.gatherColony(room);
    this.lockArena(room);
    room.queue = room.spawns.map((p) => ({ ...p }));
    // Level scaling: extra spawn markers on top of the base points.
    const extra = (this.run.level - 1) * ENEMY_LEVEL.extraSpawnsPerLevel;
    for (const p of this.sampleExtraSpawns(room, extra)) room.queue.push(p);
    // Портальный режим: точки генератора прямоугольные — втягиваем каждую
    // внутрь рисуемого полигона, чтобы телеграф не лежал на кайме стены.
    if (this.portalMode) {
      room.queue = room.queue.map((p) =>
        this.worldApi.nearestWalkable(p.x, p.y, 16) || { x: room.cx, y: room.cy });
    }
    this.tryQueue(room);
    ui.toast('Арена закрыта — зачисти комнату');
  }

  /**
   * Колония втягивается в комнату: отставшие клетки телепортируются
   * к игроку (иначе двери закроются у них перед носом).
   */
  gatherColony(room) {
    const pad = 60;
    for (const cell of this.run.cells) {
      const v = this.allyViews.get(cell.id);
      if (!v || !v.sprite.active) continue;
      const sp = v.sprite;
      const inside =
        sp.x > room.x + pad && sp.x < room.x + room.w - pad &&
        sp.y > room.y + pad && sp.y < room.y + room.h - pad;
      if (inside) continue;
      const a = Math.random() * Math.PI * 2;
      const spot = this.worldApi.nearestWalkable(
        this.player.x + Math.cos(a) * 70,
        this.player.y + Math.sin(a) * 70, 16);
      if (!spot) continue;
      sp.body.reset(spot.x, spot.y);
      sp.setVelocity(0, 0);
      cell.path = null;
    }
  }

  /**
   * Закрыть двери комнаты барьерами: по одному статическому телу
   * на каждый дверной проём (данные уже есть в room.doors + gaps).
   * Идемпотентно: повторный вход барьеры не дублирует.
   */
  lockArena(room) {
    if (room.arenaLocked) return;
    room.arenaLocked = true;
    room.arenaBarrierViews = [];
    this.refreshRoomPortals(room);
    // Портальный режим: глухих стен нет, «закрытие» = блокировка врат.
    if (this.portalMode) {
      ui.toast('Врата закрыты — зачисти комнату');
      return;
    }
    // Игрок мог стоять прямо в проёме — выталкиваем внутрь до закрытия.
    const inner = this.worldApi.nearestWalkable(
      Math.max(room.x + 60, Math.min(room.x + room.w - 60, this.player.x)),
      Math.max(room.y + 60, Math.min(room.y + room.h - 60, this.player.y)), 14);
    if (inner) {
      this.player.body.reset(inner.x, inner.y);
      this.player.setVelocity(0, 0);
    }
    // Враги могли гнаться и стоять в проёме — втягиваем их внутрь арены.
    for (const e of this.enemies.getChildren()) {
      if (!e.active) continue;
      const er = e.getData('radius') || 14;
      const insideArena =
        e.x > room.x + er && e.x < room.x + room.w - er &&
        e.y > room.y + er && e.y < room.y + room.h - er;
      if (insideArena) continue;
      const spot = this.worldApi.nearestWalkable(
        Math.max(room.x + 60, Math.min(room.x + room.w - 60, e.x)),
        Math.max(room.y + 60, Math.min(room.y + room.h - 60, e.y)), er);
      if (spot) {
        e.body.reset(spot.x, spot.y);
        e.setVelocity(0, 0);
      }
    }
    const T = this.layout.wall || DUNGEON.wall;
    const spans = this.arenaDoorSpans(room, T);
    for (const s of spans) {
      const cx = s.x + s.w / 2;
      const cy = s.y + s.h / 2;
      const w = Math.max(8, s.w);
      const h = Math.max(8, s.h);
      const gfx = this.add.rectangle(cx, cy, w, h, ARENA.barrierColor, ARENA.barrierAlpha).setDepth(3);
      this.physics.add.existing(gfx, true); // static body под размер прямоугольника
      if (gfx.body) {
        if (gfx.body.setSize) gfx.body.setSize(w, h);
        if (gfx.body.updateFromGameObject) gfx.body.updateFromGameObject();
      }
      this.arenaBarriers.add(gfx);
      room.arenaBarrierViews.push(gfx);
      // Пульсация плоти-барьера чтобы закрытие читалось.
      this.tweens.add({ targets: gfx, alpha: 0.55, duration: 500, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
  }

  /**
   * Прямоугольники дверных проёмов комнаты в мировых координатах.
   * Источник — room.gaps (интервалы разрывов стен) + толщина стены.
   */
  arenaDoorSpans(room, T) {
    const spans = [];
    const gaps = room.gaps || { N: [], S: [], W: [], E: [] };
    const clampX = (a, b) => [
      Math.max(room.x - 4, Math.min(room.x + room.w + 4, a)),
      Math.max(room.x - 4, Math.min(room.x + room.w + 4, b))];
    const clampY = (a, b) => [
      Math.max(room.y - 4, Math.min(room.y + room.h + 4, a)),
      Math.max(room.y - 4, Math.min(room.y + room.h + 4, b))];
    for (const [a, b] of gaps.N || []) {
      const [x0, x1] = clampX(a, b);
      spans.push({ x: x0, y: room.y - T - 6, w: Math.max(8, x1 - x0), h: T + 12 });
    }
    for (const [a, b] of gaps.S || []) {
      const [x0, x1] = clampX(a, b);
      spans.push({ x: x0, y: room.y + room.h - 6, w: Math.max(8, x1 - x0), h: T + 12 });
    }
    for (const [a, b] of gaps.W || []) {
      const [y0, y1] = clampY(a, b);
      spans.push({ x: room.x - T - 6, y: y0, w: T + 12, h: Math.max(8, y1 - y0) });
    }
    for (const [a, b] of gaps.E || []) {
      const [y0, y1] = clampY(a, b);
      spans.push({ x: room.x + room.w - 6, y: y0, w: T + 12, h: Math.max(8, y1 - y0) });
    }
    // Fallback: если gaps пусты (старый сейв/wing) — строим по room.doors.
    if (!spans.length && room.doors) {
      for (const d of room.doors) {
        const half = DUNGEON.tunnelWidth / 2 + 12;
        if (d.side === 'N') spans.push({ x: d.at - half, y: room.y - T - 6, w: half * 2, h: T + 12 });
        else if (d.side === 'S') spans.push({ x: d.at - half, y: room.y + room.h - 6, w: half * 2, h: T + 12 });
        else if (d.side === 'W') spans.push({ x: room.x - T - 6, y: d.at - half, w: T + 12, h: half * 2 });
        else spans.push({ x: room.x + room.w - 6, y: d.at - half, w: T + 12, h: half * 2 });
      }
    }
    return spans;
  }

  /** Открыть двери комнаты: убрать барьеры после зачистки. */
  unlockArena(room) {
    if (!room || !room.arenaLocked) return;
    room.arenaLocked = false;
    for (const gfx of room.arenaBarrierViews || []) {
      if (!gfx) continue;
      this.tweens.killTweensOf(gfx);
      this.arenaBarriers.remove(gfx, true, true);
    }
    room.arenaBarrierViews = [];
    this.refreshRoomPortals(room);
    ui.toast(this.portalMode ? 'Врата открыты' : 'Арена открыта');
  }

  // ---------------------------------------------------------- portals

  /** Цвет пары врат по индексу линка — обе стороны одинаковые. */
  portalPairColor(linkIdx) {
    return PORTAL.pairColors[linkIdx % PORTAL.pairColors.length];
  }

  /** Заблокированы ли врата: незачищенная боевая/босс комната не выпускает. */
  portalLocked(room) {
    return !!room && (room.type === 'combat' || room.type === 'boss') && !room.isStart &&
      room.activated && !room.cleared;
  }

  /** Спавн всех врат карты (портальный режим). Идемпотентно по portalId. */
  spawnAllPortals() {
    if (!this.portalMode) return;
    for (const p of this.layout.portals || []) this.spawnPortalView(p);
  }

  /** Спавн врат крыла расширения (только новые portalId). */
  spawnNewPortals() {
    if (!this.portalMode) return;
    for (const p of this.layout.portals || []) {
      if (!this.portalViews.has(p.id)) this.spawnPortalView(p);
    }
  }

  /** Один портал: венозная дыра — валик плоти снаружи, тёмный зев внутри. */
  spawnPortalView(p) {
    if (this.portalViews.has(p.id)) return;
    const color = this.portalPairColor(p.linkIdx);
    const room = this.layout.rooms[p.roomId];
    // Наружная сторона — от центра комнаты к вратам (там стена, туда валик).
    let nx = 0, ny = 0;
    if (room) {
      const dx = p.x - room.cx;
      const dy = p.y - room.cy;
      const len = Math.hypot(dx, dy) || 1;
      nx = dx / len;
      ny = dy / len;
    }
    const ang = Math.atan2(ny, nx);
    // Небольшая мясистая выпуклость снаружи (валик вокруг дыры, в цвет плоти).
    const bulge = this.add.ellipse(
      p.x + nx * 12, p.y + ny * 12, 92, 76, COLORS.flesh, 0.95
    ).setDepth(2).setRotation(ang);
    if (bulge.setStrokeStyle) bulge.setStrokeStyle(2, COLORS.wallInner, 0.6);
    const zone = this.portalGroup.create(p.x, p.y, TEX.portal);
    if (!zone) {
      bulge.destroy();
      return;
    }
    zone.setDepth(4);
    // Ткань НЕ красится в цвет пары — пара читается по тонкой жиле-кольцу.
    if (zone.clearTint) zone.clearTint();
    zone.setData('portalId', p.id);
    zone.body.setCircle(PORTAL.radius, TEX_SIZE.portal / 2 - PORTAL.radius, TEX_SIZE.portal / 2 - PORTAL.radius);
    zone.body.updateFromGameObject();
    // Тонкая жила в цвете пары — обе стороны одного линка одинаковые.
    const ring = this.add.circle(p.x, p.y, PORTAL.bodyRadius + 8)
      .setStrokeStyle(2.5, color, 0.65).setDepth(3);
    // Сфинктер: закрытые врата затянуты плотью (видно только кольцо-блокаду).
    const membrane = this.add.circle(p.x, p.y, 13, COLORS.fleshLight, 1).setDepth(5);
    if (membrane.setStrokeStyle) membrane.setStrokeStyle(2, COLORS.wallEdge, 0.7);
    membrane.setVisible(false);
    this.tweens.add({
      targets: [zone, ring, membrane], scale: 1.07, duration: 800 + (p.id % 5) * 90,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
    });
    const view = { zone, ring, bulge, membrane, data: p, locked: false, color };
    this.portalViews.set(p.id, view);
    this.refreshPortalLock(view, room);
  }

  /** Сфинктер врат: закрытые затянуты плотью + красное кольцо, открытые — зев. */
  refreshPortalLock(view, room) {
    if (!view || !view.zone || !view.zone.active) return;
    const locked = this.portalLocked(room);
    view.locked = locked;
    if (view.membrane && view.membrane.active) view.membrane.setVisible(locked);
    if (view.ring && view.ring.active) {
      if (locked) view.ring.setStrokeStyle(3, PORTAL.lockedColor, 1);
      else view.ring.setStrokeStyle(2.5, view.color, 0.65);
    }
  }

  /** Обновить замки всех врат комнаты (вызывается при lock/unlock арены). */
  refreshRoomPortals(room) {
    if (!this.portalMode || !room) return;
    for (const view of this.portalViews.values()) {
      if (view.data.roomId === room.id) this.refreshPortalLock(view, room);
    }
  }

  /** Касание врат игроком: телепорт в парные врата + колония следом. */
  onPortalTouch(player, zone) {
    if (this.isGameOver || this.modalOpen) return;
    if (this.time.now < this.portalCooldownUntil) return;
    const view = this.portalViews.get(zone.getData('portalId'));
    if (!view) return;
    const room = this.layout.rooms[view.data.roomId];
    if (this.portalLocked(room)) {
      ui.toast('Врата закрыты — зачисти комнату');
      return;
    }
    const dest = (this.layout.portals || []).find(
      (q) => q.linkIdx === view.data.linkIdx && q.id !== view.data.id);
    if (!dest) return;
    this.teleportThroughPortal(dest);
  }

  /** Телепорт: игрок + вся колония к вратам назначения. */
  teleportThroughPortal(dest) {
    const destRoom = this.layout.rooms[dest.roomId];
    if (!destRoom) return;
    const dx = dest.x - destRoom.cx;
    const dy = dest.y - destRoom.cy;
    const len = Math.hypot(dx, dy) || 1;
    const ax = dest.x - (dx / len) * PORTAL.exitOffset;
    const ay = dest.y - (dy / len) * PORTAL.exitOffset;
    const arrival = this.worldApi.nearestWalkable(
      Math.max(destRoom.x + 40, Math.min(destRoom.x + destRoom.w - 40, ax)),
      Math.max(destRoom.y + 40, Math.min(destRoom.y + destRoom.h - 40, ay)), 14)
      || { x: destRoom.cx, y: destRoom.cy };
    this.player.body.reset(arrival.x, arrival.y);
    this.player.setVelocity(0, 0);
    const placed = [{ x: arrival.x, y: arrival.y }];
    for (const cell of this.run.cells) {
      const v = this.allyViews.get(cell.id);
      if (!v || !v.sprite.active) continue;
      let spot = null;
      for (let i = 0; i < 8 && !spot; i++) {
        const a = Math.random() * Math.PI * 2;
        const cand = this.worldApi.nearestWalkable(
          arrival.x + Math.cos(a) * (50 + i * 12),
          arrival.y + Math.sin(a) * (50 + i * 12), 12);
        if (cand && placed.every((p) => Math.hypot(p.x - cand.x, p.y - cand.y) > 34)) spot = cand;
      }
      if (!spot) spot = arrival;
      placed.push(spot);
      v.sprite.body.reset(spot.x, spot.y);
      v.sprite.setVelocity(0, 0);
      cell.path = null;
      cell.target = null;
    }
    this.portalCooldownUntil = this.time.now + PORTAL.cooldownMs;
    this.hitSparks.explode(10, arrival.x, arrival.y);
  }

  /** Замки врат зависят от cleared — проверяем дешёвым тиком. */
  updatePortals() {
    if (!this.portalMode || this.portalViews.size === 0) return;
    this._portalLockAcc = (this._portalLockAcc || 0) + 1;
    if (this._portalLockAcc < 30) return;
    this._portalLockAcc = 0;
    for (const view of this.portalViews.values()) {
      const room = this.layout.rooms[view.data.roomId];
      const locked = this.portalLocked(room);
      if (locked !== view.locked) this.refreshPortalLock(view, room);
    }
  }

  /** Открыть окно лавки (с генерацией товара под текущий прогресс). */
  openShop(room) {
    // Физическая лавка: модалка при входе больше не открывается.
    // Стенды заспавнены в activateRoom — покупка через E рядом со стендом.
    if (!room.stock || !room.stock.length) return;
    this.spawnShopStands(room);
  }

  /**
   * Физические стенды-наросты лавки: постамент + товар + ценник.
   * Идемпотентно: повторная активация комнаты стенды не дублирует.
   */
  spawnShopStands(room) {
    if (room.standsSpawned) return;
    if (!room.stock || !room.stock.length) return;
    room.standsSpawned = true;
    const n = room.stock.length;
    const cols = Math.ceil(Math.sqrt(n));
    const sx = SHOP.standSpacingX;
    const sy = SHOP.standSpacingY;
    const mouths = this.doorMouths(room);
    // В портальном режиме стенды не ставим на врата (иначе игрок застрянет
    // у входа в зону телепорта — стенд физически блокирует подход).
    const portals = this.portalMode
      ? (this.layout.portals || []).filter((p) => p.roomId === room.id)
      : [];
    const spots = [];
    const rows = Math.ceil(n / cols);
    for (let row = 0; row < rows + 2 && spots.length < n; row++) {
      const countInRow = Math.min(cols, n - spots.length);
      const y = room.cy + (row - (rows - 1) / 2) * sy;
      for (let i = 0; i < countInRow && spots.length < n; i++) {
        const x = room.cx + (i - (countInRow - 1) / 2) * sx;
        const px = Math.max(room.x + 70, Math.min(room.x + room.w - 70, x));
        const py = Math.max(room.y + 90, Math.min(room.y + room.h - 70, y));
        if (mouths.some((m) => Math.hypot(m.x - px, m.y - py) < SHOP.doorClearance)) continue;
        if (portals.some((p) => Math.hypot(p.x - px, p.y - py) < PORTAL.clearance)) continue;
        if (!this.worldApi.isWalkable(px, py, SHOP.standRadius)) continue;
        if (spots.some((p) => Math.hypot(p.x - px, p.y - py) < sx * 0.7)) continue;
        spots.push({ x: px, y: py });
      }
    }
    let fx = room.cx - n * 40;
    for (let i = spots.length; i < n; i++) {
      const p = this.worldApi.nearestWalkable(
        Math.max(room.x + 70, Math.min(room.x + room.w - 70, fx)),
        room.cy, SHOP.standRadius + 6);
      fx += 80;
      if (p) spots.push(p);
    }
    room.stock.forEach((offer, i) => {
      const spot = spots[i % Math.max(1, spots.length)] || { x: room.cx, y: room.cy };
      this.makeShopStand(room, offer, spot, i);
    });
  }

  /** Один стенд: твёрдая база, иконка товара, ценник. Купленное — тусклое. */
  makeShopStand(room, offer, spot, idx) {
    const key = offer.kind + ':' + offer.key;
    const sold = (room.stockBought || []).includes(key);
    const base = this.stands.create(spot.x, spot.y, TEX.stand);
    if (!base) return;
    base.setDepth(4);
    base.setData('roomId', room.id);
    base.setData('standKey', key);
    base.setInteractive({ useHandCursor: true });
    base.on('pointerdown', () => {
      if (this.modalOpen || this.isGameOver || !this.player) return;
      const d = Math.hypot(base.x - this.player.x, base.y - this.player.y);
      if (d > SHOP.interactRadius) {
        ui.toast('Подойди ближе к стенду');
        return;
      }
      this.tryBuyNearStand();
    });
    base.body.setCircle(
      SHOP.standRadius * 0.85,
      TEX_SIZE.stand / 2 - SHOP.standRadius * 0.85,
      TEX_SIZE.stand / 2 - SHOP.standRadius * 0.85);
    base.body.updateFromGameObject(); // static body: неподвижно по определению
    const iconTex = offer.kind === 'artifact' ? TEX.relic : TEX.tonic;
    const item = this.add.image(spot.x, spot.y - 26, iconTex).setDepth(5);
    if (sold) item.setAlpha(0.25);
    else {
      this.tweens.add({
        targets: item, y: spot.y - 32, duration: 900 + idx * 120,
        yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
      });
    }
    const label = this.add.text(spot.x, spot.y + 30, '', {
      fontFamily: 'monospace', fontSize: SHOP.labelFont, color: '#ffd94d',
      backgroundColor: 'rgba(5,7,10,0.75)', padding: { x: 5, y: 2 }, align: 'center',
      wordWrap: { width: 200, useAdvancedWrap: true }
    }).setOrigin(0.5, 0).setDepth(6);
    const view = { base, item, label, roomId: room.id, kind: offer.kind, key: offer.key, sold };
    this.refreshStandLabel(room, view);
    this.standViews.push(view);
  }

  /** Ценник стенда: имя + цена + описание. После покупки — «продано». */
  refreshStandLabel(room, view) {
    const price = this.shopPrice(room, { kind: view.kind, key: view.key });
    view.price = price;
    const offer = { kind: view.kind, key: view.key };
    const name = this.offerName(offer);
    const detail = this.offerDetail(offer);
    if (view.sold) view.label.setText(`${name}\nпродано`);
    else view.label.setText(`${name}\n${detail}\n${price} плазмы [E]`);
    const afford = this.run.plasma >= price;
    view.label.setColor(view.sold ? '#6f8f8b' : (afford ? '#ffd94d' : '#ff7a7a'));
  }

  /** Ближайший некупленный стенд в радиусе взаимодействия. */
  nearestStand() {
    if (!this.player || this.isGameOver) return null;
    let best = null;
    let bestD2 = SHOP.interactRadius * SHOP.interactRadius;
    for (const v of this.standViews) {
      if (!v || v.sold || !v.base || !v.base.active) continue;
      const dx = v.base.x - this.player.x;
      const dy = v.base.y - this.player.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = v; }
    }
    return best;
  }

  /** Покупка по E: ближайший стенд рядом с игроком. */
  tryBuyNearStand() {
    if (this.modalOpen || this.isGameOver || !this.player) return;
    const view = this.nearestStand();
    if (!view) return;
    const room = this.layout.rooms.find((r) => r.id === view.roomId);
    if (!room) return;
    const ok = this.buyOffer(room, { kind: view.kind, key: view.key });
    if (ok) {
      view.sold = true;
      view.item.setAlpha(0.25);
      this.tweens.killTweensOf(view.item);
      this.refreshStandLabel(room, view);
      this.hitSparks.explode(8, view.base.x, view.base.y - 20);
    } else {
      this.tweens.add({ targets: view.label, x: '+=6', duration: 50, yoyo: true, repeat: 3 });
      this.refreshStandLabel(room, view);
    }
  }

  /** Подсказка «E — купить» над ближайшим стендом + обновление ценников. */
  updateShopStands() {
    const near = (!this.modalOpen && !this.isGameOver) ? this.nearestStand() : null;
    // Ценники зависят от плазмы — обновляем только при её изменении.
    if (this.run.plasma !== this._standPlasma) {
      this._standPlasma = this.run.plasma;
      for (const v of this.standViews) {
        if (!v.base || !v.base.active || v.sold) continue;
        const rm = this.layout.rooms.find((r) => r.id === v.roomId);
        if (rm) this.refreshStandLabel(rm, v);
      }
    }
    if (!near) {
      if (this.standPrompt) { this.standPrompt.destroy(); this.standPrompt = null; }
      ui.hideAction();
      return;
    }
    const offer = { kind: near.kind, key: near.key };
    const txt = `${this.offerName(offer)}\n${this.offerDetail(offer)}\n${near.price} · [E] купить`;
    if (!this.standPrompt) {
      this.standPrompt = this.add.text(near.base.x, near.base.y - 62, txt, {
        fontFamily: 'monospace', fontSize: '13px', color: '#ffe86b',
        backgroundColor: 'rgba(5,7,10,0.85)', padding: { x: 6, y: 3 }, align: 'center',
        wordWrap: { width: 240, useAdvancedWrap: true }
      }).setOrigin(0.5, 1).setDepth(8);
    } else {
      this.standPrompt.setText(txt);
      this.standPrompt.setPosition(near.base.x, near.base.y - 62);
    }
    // Контекстная кнопка живёт ровно столько, сколько рядом есть стенд.
    ui.showAction({
      key: 'E',
      label: 'КУПИТЬ',
      sub: `${near.price} плазмы`,
      ok: this.run.plasma >= near.price
    });
  }

  offerName(o) {
    if (o.kind === 'upgrade') {
      const def = UPGRADE_NAME[o.key];
      return def || o.key;
    }
    const def = ARTIFACT_BY_ID[o.key];
    return def ? def.name : o.key;
  }

  offerDetail(o) {
    if (o.kind === 'upgrade') {
      const lvl = this.run.upgradeLevel(o.key);
      return lvl ? `Улучшение · ур. ${lvl} → ${lvl + 1}` : 'Улучшение · новый эффект';
    }
    const def = ARTIFACT_BY_ID[o.key];
    const lvl = artifactLevel(this.run, o.key);
    if (!def) return 'Артефакт';
    return lvl ? `Артефакт · ур. ${lvl} → ${lvl + 1}: ${def.desc}` : `Артефакт: ${def.desc}`;
  }

  /** Цена товара с учётом посещений лавок (наценка). */
  shopPrice(room, offer) {
    const level = offer.kind === 'upgrade'
      ? this.run.upgradeLevel(offer.key)
      : artifactLevel(this.run, offer.key);
    // Наценка считается от посещений до входа в эту лавку.
    const visits = Math.max(0, this.run.shopVisits - 1);
    const visitsHere = room.visitsHere || 0;
    const price = priceOf(offer.kind, offer.key, level, visits + visitsHere);
    return price;
  }

  buyOffer(room, offer) {
    room.stockBought = room.stockBought || [];
    const key = offer.kind + ':' + offer.key;
    if (room.stockBought.includes(key)) return false;
    const price = this.shopPrice(room, offer);
    if (this.run.plasma < price) {
      ui.toast('Недостаточно плазмы');
      return false;
    }
    if (offer.kind === 'upgrade') {
      if (!this.run.upgradeAvailable(offer.key)) return false;
      this.run.applyUpgrade(offer.key);
      this.dirtyHero();
    } else {
      const def = ARTIFACT_BY_ID[offer.key];
      if (!def || !canBuyArtifact(this.run, offer.key)) return false;
      const res = this.run.buyArtifact(offer.key, def);
      room.stockBought.push(key);
      if (def.effect.health) this.hp += def.effect.health; // панцирь лечит
      this.dirtyHero();
      ui.toast(res.activated ? `Артефакт «${def.name}» активен` : `Артефакт «${def.name}» усилен (слоты заняты)`);
      this.run.spendPlasma(price);
      this.pushHud();
      return true;
    }
    room.stockBought.push(key);
    this.run.spendPlasma(price);
    this.pushHud();
    return true;
  }

  closeShop() {
    // Физическая лавка модалки не открывает — заглушка для совместимости.
    panels.hideShop();
    this.pushHud();
  }

  // ----------------------------------------------------- artifact inventory

  openArtifacts() {
    if (this.modalOpen || this.isGameOver) return;
    this.modalOpen = true;
    ui.hideAction();
    this.renderArtifacts();
    setTimeout(() => {
      if (!this.isGameOver && this.modalOpen) this.scene.pause();
    }, 0);
  }

  renderArtifacts() {
    panels.showArtifacts(
      {
        slots: ARTIFACT_SLOTS,
        used: this.run.activeArtifacts.length,
        plasma: this.run.plasma,
        icon: this.texDataURL(TEX.relic),
        activeIds: [...this.run.activeArtifacts],
        items: ARTIFACT_CATALOG.map((a) => ({
          id: a.id,
          name: a.name,
          desc: a.desc,
          level: artifactLevel(this.run, a.id),
          maxLevel: a.maxLevel,
          active: this.run.activeArtifacts.includes(a.id)
        }))
      },
      {
        onToggle: (id, on) => this.toggleArtifact(id, on),
        onClose: () => this.closeArtifacts()
      }
    );
  }

  toggleArtifact(id, on) {
    const r = this.run.setArtifactActive(id, on);
    if (!r.ok && r.reason) ui.toast(r.reason);
    this.dirtyHero();
    // Панцирь при активации/снятии меняет максимум HP — подтягиваем текущее.
    const st = this.heroStats();
    this.hp = Math.min(this.hp, st.maxHealth);
    this.renderArtifacts();
    this.pushHud();
  }

  closeArtifacts() {
    panels.hideArtifacts();
    this.modalOpen = false;
    if (!this.isGameOver) this.scene.resume();
    this.pushHud();
  }

  /** Extra perimeter spawn points for higher levels (bounded attempts). */
  sampleExtraSpawns(room, n) {
    const pts = [];
    for (let i = 0; i < n * 12 && pts.length < n; i++) {
      const side = Math.floor(Math.random() * 4);
      const t = 0.12 + Math.random() * 0.76;
      const off = 72 + (Math.random() - 0.5) * 40;
      let x;
      let y;
      if (side === 0) [x, y] = [room.x + room.w * t, room.y + off];
      else if (side === 1) [x, y] = [room.x + room.w * t, room.y + room.h - off];
      else if (side === 2) [x, y] = [room.x + off, room.y + room.h * t];
      else [x, y] = [room.x + room.w - off, room.y + room.h * t];
      if (!this.worldApi.isWalkable(x, y, 20)) continue;
      const all = [...(room.queue || []), ...pts];
      if (all.some((p) => Math.hypot(p.x - x, p.y - y) < 100)) continue;
      pts.push({ x, y });
    }
    return pts;
  }

  /** Turn eligible queued points into telegraph markers (bounded by the global cap). */
  tryQueue(room) {
    if (!room.queue || !room.queue.length) return;
    const rest = [];
    let spawned = 0;
    // Farthest-first: the most distant threats materialize first.
    const ordered = [...room.queue].sort(
      (p, q) =>
        Math.hypot(q.x - this.player.x, q.y - this.player.y) -
        Math.hypot(p.x - this.player.x, p.y - this.player.y)
    );
    for (const p of ordered) {
      const d = Math.hypot(p.x - this.player.x, p.y - this.player.y);
      if (d < ENEMIES.minPlayerDist) {
        rest.push(p); // too close to the player — wait for the next tick
        continue;
      }
      if (this.enemies.countActive(true) + room.markersPending >= ENEMIES.maxAlive) {
        rest.push(p);
        continue;
      }
      this.spawnMarker(room, p);
      spawned += 1;
    }
    // Fallback: never leave an entered room permanently silent. The farthest
    // point still gets a full 0.6–0.9s telegraph, and auto-attack outranges it.
    if (spawned === 0 && rest.length && this.enemies.countActive(true) + room.markersPending < ENEMIES.maxAlive) {
      this.spawnMarker(room, rest.shift());
    }
    room.queue = rest;
  }

  /** Red pulsing tissue mark on the floor, then the enemy breaks through. */
  spawnMarker(room, p) {
    room.markersPending += 1;
    const view = this.add
      .circle(p.x, p.y, 15, COLORS.telegraph, 0.3)
      .setDepth(2)
      .setStrokeStyle(2, COLORS.telegraph, 0.9);
    this.tweens.add({ targets: view, scale: 1.3, alpha: 0.8, duration: 300, yoyo: true, repeat: -1 });
    const delay =
      ENEMIES.telegraphMinMs + Math.random() * (ENEMIES.telegraphMaxMs - ENEMIES.telegraphMinMs);
    const timer = this.time.delayedCall(delay, () => {
      this.markers = this.markers.filter((m) => m.view !== view);
      room.markersPending -= 1;
      view.destroy();
      if (this.isGameOver) {
        this.checkRoomCleared(room);
        return;
      }
      this.deathSparks.explode(8, p.x, p.y);
      this.spawnEnemyAt(p.x, p.y, room.id);
      this.checkRoomCleared(room);
    });
    this.markers.push({ view, timer, roomId: room.id });
  }

  spawnEnemyAt(x, y, roomId) {
    // Игломёт — только после второго босса; остальные типы доступны всегда.
    const pool = ENEMIES.types.filter((t) => (t.minBosses || 0) <= this.bossesBeaten);
    const type = pickEnemyType(Math.random, pool.length ? pool : ENEMIES.types);
    const e = this.enemies.create(x, y, type.key);
    if (!e) return;
    e.setDepth(4);
    e.setCollideWorldBounds(true);
    e.setData('typeKey', type.key);
    e.setData('roomId', roomId);
    e.setData('hp', type.hp);
    e.setData('maxHp', type.hp);
    e.setData('speed', type.speed * Phaser.Math.FloatBetween(0.9, 1.1));
    e.setData('damage', type.damage);
    e.setData('radius', type.radius);
    e.setData('seed', Math.random() * Math.PI * 2);
    const texSize = TEX_SIZE[type.key] || type.radius * 2;
    const bodyR = type.radius * 0.8;
    e.body.setCircle(bodyR, texSize / 2 - bodyR, texSize / 2 - bodyR);
    e.setVelocity(0, 0);
    // Gentle pop-in so spawns read clearly.
    e.setScale(0.3);
    this.tweens.add({ targets: e, scale: 1, duration: 180, ease: 'Back.easeOut' });
    const room = this.layout.rooms[roomId];
    if (room) room.spawnedTotal = (room.spawnedTotal || 0) + 1;
  }

  // ------------------------------------------------------------ boss fights

  /** Колония прячется на время боя с боссом (данные целы, виды снесены). */
  stashColony() {
    this.gatherMode = false; // некому собирать — клетки убраны
    this.stashedCells = this.run.cells.splice(0);
    for (const cell of this.stashedCells) this.destroyAllyView(cell.id);
    ui.setGather({ hasCells: false, active: false });
    this.refreshColonyStrip();
  }

  /** Колония возвращается после победы (добитые в бою клетки не воскресают). */
  restoreColony() {
    const back = this.stashedCells;
    this.stashedCells = [];
    for (const cell of back) {
      if (!this.run.getCell(cell.id)) this.run.cells.push(cell);
      cell.target = null;
      cell.path = null;
      this.spawnAllyView(cell);
    }
    this.refreshColonyStrip();
  }

  /** Босс крыла в центре зала: гоняется и бьёт вближнюю как обычный враг. */
  spawnBoss(room) {
    const defIdx = (room.wing || 0) % BOSS.defs.length;
    const def = BOSS.defs[defIdx];
    const hp = Math.round(def.hp * (1 + BOSS.hpScalePerWing * (room.wing || 0)));
    const spot = this.worldApi.nearestWalkable(room.cx, room.cy, def.radius) || { x: room.cx, y: room.cy };
    const texKey = TEX[`boss-${defIdx}`] || TEX['enemy-c'];
    const b = this.enemies.create(spot.x, spot.y, texKey);
    if (!b) return;
    b.setDepth(4);
    b.setCollideWorldBounds(true);
    b.setData('isBoss', true);
    b.setData('bossIdx', defIdx);
    b.setData('bossName', def.name);
    b.setData('typeKey', 'boss');
    b.setData('roomId', room.id);
    b.setData('hp', hp);
    b.setData('maxHp', hp);
    b.setData('speed', def.speed);
    b.setData('damage', def.damage);
    b.setData('radius', def.radius);
    b.setData('contactMs', def.contactCooldownMs);
    b.setData('seed', Math.random() * Math.PI * 2);
    const texSize = TEX_SIZE[`boss-${defIdx}`] || def.radius * 2;
    const bodyR = def.radius * 0.8;
    b.body.setCircle(bodyR, texSize / 2 - bodyR, texSize / 2 - bodyR);
    b.setVelocity(0, 0);
    const now = this.time.now;
    b.setData('atk', def.attacks.map((a, i) => ({ nextAt: now + 2600 + i * 1600 })));
    b.setData('tele', null);
    b.setData('teleRing', null);
    b.setData('spiral', null);
    room.spawnedTotal = 1;
    this.bossActive = room.id;
    b.setScale(0.3);
    this.tweens.add({ targets: b, scale: 1, duration: 350, ease: 'Back.easeOut' });
    this.deathSparks.explode(20, spot.x, spot.y);
    this.cameras.main.shake(180, 0.005);
    ui.showBoss(def.name);
    ui.setBossHp(hp, hp);
    ui.toast(`БОСС: ${def.name} — паразиты прячутся, суператаки по кольцу!`);
  }

  /** Кулдауны и телеграфы суператак. Движение/ближний бой — общий updateEnemies. */
  updateBosses(dt) {
    if (this.isGameOver) return;
    const now = this.time.now;
    for (const b of this.enemies.getChildren()) {
      if (!b.active || !b.getData('isBoss') || b.getData('dying')) continue;
      const def = BOSS.defs[b.getData('bossIdx')];
      if (!def) continue;
      // Активная спираль: сеем снаряды, пока не вышло время.
      const sp = b.getData('spiral');
      if (sp) {
        if (now < sp.until) {
          sp.acc += dt;
          while (sp.acc >= sp.tickMs) {
            sp.acc -= sp.tickMs;
            sp.ang += sp.step;
            this.foeShot(b.x, b.y, sp.ang, sp.speed, sp.dmg);
            this.foeShot(b.x, b.y, sp.ang + Math.PI, sp.speed, sp.dmg);
          }
        } else {
          b.setData('spiral', null);
        }
      }
      // Телеграф тикает — остальные атаки ждут своей очереди.
      const tele = b.getData('tele');
      if (tele) {
        if (now >= tele.until) {
          b.setData('tele', null);
          this.destroyTeleRing(b);
          this.fireBossAttack(b, def, tele.idx);
        }
        continue;
      }
      const states = b.getData('atk') || [];
      for (let i = 0; i < states.length; i++) {
        if (now >= states[i].nextAt) {
          this.startBossTelegraph(b, def, i);
          break;
        }
      }
    }
  }

  /** Знак перед суперударом: пульсирующее кольцо + вспышка + название. */
  startBossTelegraph(b, def, idx) {
    const atk = def.attacks[idx];
    if (!atk) return;
    b.setData('tele', { idx, until: this.time.now + atk.telegraphMs });
    const ring = this.add
      .circle(b.x, b.y, def.radius + 16, COLORS.telegraph, 0.25)
      .setDepth(2)
      .setStrokeStyle(3, COLORS.telegraph, 0.95);
    this.tweens.add({ targets: ring, scale: 1.35, duration: 320, yoyo: true, repeat: -1 });
    b.setData('teleRing', ring);
    setFillTint(b, 0xffffff);
    ui.toast(`БОСС: ${atk.label}!`, 1600);
  }

  destroyTeleRing(b) {
    const ring = b.getData('teleRing');
    b.setData('teleRing', null);
    if (ring && ring.active) {
      this.tweens.killTweensOf(ring);
      ring.destroy();
    }
    if (b.active) b.clearTint();
  }

  /** Выстрел состоялся: планируем следующий и исполняем паттерн. */
  fireBossAttack(b, def, idx) {
    if (!b.active || this.isGameOver) return;
    const atk = def.attacks[idx];
    if (!atk) return;
    const states = b.getData('atk') || [];
    if (states[idx]) states[idx].nextAt = this.time.now + atk.cooldownMs * (0.9 + Math.random() * 0.3);
    const room = this.layout.rooms[b.getData('roomId')];
    if (atk.kind === 'radial') {
      const off = Math.random() * Math.PI * 2;
      for (let r = 0; r < (atk.rings || 1); r++) {
        this.time.delayedCall(r * (atk.ringDelayMs || 0), () => {
          if (!b.active || this.isGameOver) return;
          for (let i = 0; i < atk.count; i++) {
            this.foeShot(b.x, b.y, off + (i / atk.count) * Math.PI * 2 + r * 0.3, atk.speed, atk.dmg);
          }
        });
      }
    } else if (atk.kind === 'aimed') {
      const base = Math.atan2(this.player.y - b.y, this.player.x - b.x);
      for (let i = 0; i < atk.count; i++) {
        const t = atk.count === 1 ? 0 : (i / (atk.count - 1) - 0.5);
        this.foeShot(b.x, b.y, base + t * (atk.spread || 0.4), atk.speed, atk.dmg);
      }
    } else if (atk.kind === 'spiral') {
      b.setData('spiral', {
        until: this.time.now + atk.durationMs, acc: 0,
        ang: Math.random() * Math.PI * 2,
        tickMs: atk.tickMs, step: atk.step, speed: atk.speed, dmg: atk.dmg
      });
    } else if (atk.kind === 'summon') {
      if (!room || this.enemies.countActive(true) >= ENEMIES.maxAlive) return;
      for (let i = 0; i < atk.count; i++) {
        const a = (i / atk.count) * Math.PI * 2 + Math.random() * 0.5;
        const spot = this.worldApi.nearestWalkable(
          b.x + Math.cos(a) * 220, b.y + Math.sin(a) * 220, 16);
        if (spot) this.spawnMarker(room, spot);
      }
    }
    this.deathSparks.explode(6, b.x, b.y);
  }

  /** Вражеский снаряд с лимитом группы (старые гаснут, накопления нет). */
  foeShot(x, y, angle, speed, dmg) {
    if (this.foeShots.countActive(true) >= BOSS.foeCap) {
      const oldest = this.foeShots.getFirstAlive();
      if (oldest) oldest.destroy();
    }
    const s = this.foeShots.create(x, y, TEX.foe);
    if (!s) return;
    s.setDepth(5);
    s.setData('age', 0);
    s.setData('dmg', dmg);
    s.body.setAllowGravity(false);
    s.body.setCircle(BOSS.foeRadius, TEX_SIZE.foe / 2 - BOSS.foeRadius, TEX_SIZE.foe / 2 - BOSS.foeRadius);
    s.setVelocity(Math.cos(angle) * speed, Math.sin(angle) * speed);
  }

  updateFoeShots(dt) {
    const b = this.playBounds;
    const margin = 60;
    for (const s of this.foeShots.getChildren()) {
      if (!s.active) continue;
      s.setData('age', s.getData('age') + dt);
      if (
        s.getData('age') > BOSS.foeLifeMs ||
        s.x < b.x - margin || s.y < b.y - margin ||
        s.x > b.x + b.w + margin || s.y > b.y + b.h + margin
      ) {
        s.destroy();
        continue;
      }
      if (this.portalMode && this.builder && !this.builder.isInsideAnyRoom(s.x, s.y, 2)) {
        this.hitSparks.explode(2, s.x, s.y);
        s.destroy();
      }
    }
  }

  onFoeShotWall(a, shot) {
    // Пары прилетают перевёрнутыми (стена, снаряд) — ищем снаряд по текстуре.
    const isFoe = (o) => !!o && !!o.active && !!o.texture && o.texture.key === TEX.foe;
    const s = isFoe(a) ? a : isFoe(shot) ? shot : null;
    if (!s || this.isGameOver) return;
    this.hitSparks.explode(3, s.x, s.y);
    s.destroy();
  }

  onFoeShotPlayer(player, shot) {
    if (!shot || !shot.active || this.isGameOver) return;
    const dmg = shot.getData('dmg') ?? 10;
    const sx = shot.x, sy = shot.y;
    shot.destroy();
    this.applyHeroHit(dmg, sx, sy, null);
  }

  onFoeShotAlly(ally, shot) {
    if (!shot || !shot.active || !ally || !ally.active || this.isGameOver) return;
    const cell = this.run.getCell(ally.getData('cellId'));
    const dmg = shot.getData('dmg') ?? 10;
    shot.destroy();
    if (cell) this.damageCell(cell, dmg);
  }

  /**
   * Смертельный удар: босс входит в агонию (не бьёт, не колдует, урон не
   * принимает), а награда выдаётся только после анимации — в finishBossKill.
   */
  killBoss(boss) {
    if (!boss.active || boss.getData('dying')) return;
    boss.setData('dying', true);
    boss.setVelocity(0, 0);
    boss.setData('spiral', null);
    this.destroyTeleRing(boss);
    this.cameras.main.shake(150, 0.004);
    // Вспышки + разрывы по телу: агония читается издалека.
    const flashes = Math.max(3, Math.floor(BOSS.deathAnimMs / 130));
    for (let i = 0; i < flashes; i++) {
      this.time.delayedCall(i * 130, () => {
        if (!boss.active) return;
        setFillTint(boss, i % 2 ? 0xff4d5e : 0xffffff);
        this.deathSparks.explode(5,
          boss.x + (Math.random() - 0.5) * 70, boss.y + (Math.random() - 0.5) * 70);
      });
    }
    this.tweens.add({ targets: boss, scale: 1.3, duration: BOSS.deathAnimMs, ease: 'Sine.easeIn' });
    const roomId = boss.getData('roomId');
    const name = boss.getData('bossName') || 'Босс';
    ui.toast(`Босс «${name}» издыхает…`);
    this.time.delayedCall(BOSS.deathAnimMs, () => this.finishBossKill(boss, roomId, name));
  }

  /** Финал агонии: взрыв, щедрая награда, колония возвращается, зал зачищается. */
  finishBossKill(boss, roomId, name) {
    if (!boss.active) return;
    const x = boss.x, y = boss.y;
    const room = typeof roomId === 'number' ? this.layout.rooms[roomId] : null;
    this.deathSparks.explode(40, x, y);
    this.hitSparks.explode(16, x, y);
    this.cameras.main.shake(220, 0.006);
    boss.destroy();
    this.bossActive = null;
    ui.hideBoss();
    this.kills += 1;
    this.run.addPlasma(BOSS.rewardPlasma);
    // Не даём отложенным телеграфам призыва доставить свиту после победы.
    if (room) this.cancelRoomMarkers(room);
    // Свита дохнет вместе с хозяином (обычные награды за каждую).
    for (const e of [...this.enemies.getChildren()]) {
      if (e.active && !e.getData('isBoss') && e.getData('roomId') === roomId) this.killEnemy(e);
    }
    this.restoreColony();
    this.pendingLevels += BOSS.rewardLevels;
    this.bossesBeaten += 1;
    this.pushHud();
    if (room) this.checkRoomCleared(room);
    ui.toast(`Босс «${name}» повержен! +${BOSS.rewardLevels} уровня · +${BOSS.rewardPlasma} плазмы`);
    if (this.bossesBeaten === 2) {
      ui.toast('Ткань мутирует: в глубине завелись Игломёты — держат дистанцию и плюются иглами', 5000);
    }
    if (!this.isGameOver) this.openDraft();
  }

  /** Снять отложенные телеграфные метки комнаты (победа/перезапуск боя). */
  cancelRoomMarkers(room) {
    if (!room) return;
    let cut = 0;
    for (const m of this.markers) {
      if (m.roomId !== room.id) continue;
      this.tweens.killTweensOf(m.view);
      if (m.timer) m.timer.remove(false);
      if (m.view && m.view.active) m.view.destroy();
      cut += 1;
    }
    this.markers = this.markers.filter((m) => m.roomId !== room.id);
    room.markersPending = Math.max(0, (room.markersPending || 0) - cut);
  }

  checkRoomCleared(room) {
    if (!room || room.isStart || room.cleared || !room.activated) return;
    if ((room.markersPending || 0) > 0 || (room.queue && room.queue.length)) return;
    if (!room.spawnedTotal) {
      room.cleared = true; // activated but nothing ever queued: vacuously done
      this.unlockArena(room);
      return;
    }
    // Зачистка — только по врагам арены: зашедшие снаружи (roomId чужой)
    // двери не блокируют, их добьём после открытия.
    const alive = this.enemies.getChildren().some(
      (e) => e.active && e.getData('roomId') === room.id &&
        e.x > room.x && e.x < room.x + room.w && e.y > room.y && e.y < room.y + room.h);
    if (!alive) {
      room.cleared = true; // stays cleared for the rest of the run
      this.unlockArena(room);
    }
  }

  // ------------------------------------------------------ map expansion

  /** Every room walked and every fight finished (start needs visit only). */
  allRoomsDone() {
    for (const r of this.layout.rooms) {
      if (!r.visited) return false;
      if (!r.isStart && !r.cleared) return false;
    }
    return true;
  }

  /**
   * Точка роста следующего чанка: пройденный босс-зал самого свежего крыла.
   * Зачистил босса — ткань растёт дальше из его зала. Фолбэк (босса нет):
   * ближайший тупик, как раньше.
   */
  pickGateway() {
    let bossGate = null;
    for (const r of this.layout.rooms) {
      if (!r.isBoss || !r.cleared) continue;
      if (!bossGate || (r.wing || 0) > (bossGate.wing || 0)) bossGate = r;
    }
    if (bossGate) return bossGate;
    const deg = roomDegrees(this.layout);
    const cands = this.layout.rooms.filter((r) => !r.isBoss);
    for (const pool of [cands.length ? cands : this.layout.rooms]) {
      let best = null;
      let bestScore = null;
      for (const r of pool) {
        const d = deg.get(r.id) ?? 99;
        const dist = Math.hypot(r.cx - this.player.x, r.cy - this.player.y);
        // Leaves first (degree 1), then nearest — score sorts degree, then dist.
        const score = d * 1e9 + dist;
        if (bestScore === null || score < bestScore) {
          bestScore = score;
          best = r;
        }
      }
      if (best) return best;
    }
    return null;
  }

  checkExpansion(dt) {
    this.expandAcc += dt;
    if (this.expandAcc < 2000) return; // slow tick, not per-frame work
    this.expandAcc = 0;
    if (this.isGameOver || this.modalOpen || this.wingCount >= 99) return;
    if (this.time.now < this.expandRetryAt) return;
    if (!this.allRoomsDone()) return;
    this.doExpansion();
  }

  doExpansion() {
    const gateway = this.pickGateway();
    if (!gateway) return;
    const wingIndex = this.wingCount + 1;
    const t0 = performance.now();
    // Крыло в тех же размерах, что база (иначе комнаты выходят мелкими),
    // и сопоставимого размера (иначе 15 больших залов не влезают в поле).
    const res = generateWing(this.seed, wingIndex, this.layout, gateway.id, {
      roomMin: DUNGEON.roomMin,
      roomMax: DUNGEON.roomMax,
      startRoomMin: DUNGEON.startRoomMin,
      tunnelWidth: DUNGEON.tunnelWidth,
      wall: DUNGEON.wall,
      spawnAreaPer: DUNGEON.spawnAreaPer,
      spawnMin: DUNGEON.spawnMin,
      spawnMax: DUNGEON.spawnMax,
      wingRooms: DUNGEON.roomCountMax,
    });
    if (!res) {
      // No free space found from here — try again later (player may move on).
      this.expandRetryAt = this.time.now + 15000;
      return;
    }
    this.wingCount = wingIndex;
    // New floors first (under old walls), then full wall/body refresh so the
    // gateway's fresh door actually opens. Bodies array mutates in place —
    // live colliders keep working without re-registration.
    const newRooms = res.roomIds.map((id) => this.layout.rooms[id]);
    const newCorridors = this.layout.corridors.slice(-res.corridorCount);
    this.builder.addExpansion(newRooms, newCorridors, 0x1000 * wingIndex + 0x77);
    this.spawnNewPortals();
    // World + camera bounds grow; bullets use playBounds live.
    const b = this.layout.bounds;
    this.playBounds = b;
    this.physics.world.setBounds(b.x, b.y, b.w, b.h);
    this.cameras.main.setBounds(b.x, b.y, b.w, b.h);
    // Fresh nav grid (ms-scale) + drop stale agent paths.
    this.nav = new NavGrid(this.layout);
    window.__world.nav = this.nav;
    for (const e of this.enemies.getChildren()) {
      if (e.active) e.setData('path', null);
    }
    for (const cell of this.run.cells) cell.path = null;
    this.minimap.renderBase(this.layout);
    console.log(
      `[viscera] wing ${wingIndex}: +${res.roomIds.length} rooms via dead-end ${gateway.id} ` +
      `in ${(performance.now() - t0).toFixed(0)}ms (total ${this.layout.rooms.length})`
    );
    ui.toast(`Выросла новая ткань — ${res.roomIds.length} камер (крыло ${wingIndex})`);
    this.pushHud();
  }

  // ---------------------------------------------------------------- combat

  updateWeapon(dt) {
    const hs = this.heroStats();
    this.fireAcc += dt;
    if (this.fireAcc < hs.intervalMs) return;
    // Нет врагов рядом — герой разбивает ближайший нарост в радиусе.
    const target = this.findNearestEnemy(hs.attackRange) ?? this.findNearestGrowth(hs.attackRange);
    if (!target) {
      this.fireAcc = hs.intervalMs; // hold ready until a target enters range
      return;
    }
    this.fireAcc -= hs.intervalMs;
    this.fireBulletAt(target, hs.attack);
  }

  findNearestEnemy(range) {
    let best = null;
    let bestD2 = range * range;
    const px = this.player.x;
    const py = this.player.y;
    for (const e of this.enemies.getChildren()) {
      if (!e.active || e.getData('dying')) continue;
      const dx = e.x - px;
      const dy = e.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  /** Ближайший целый нарост в радиусе (для добивания, когда врагов нет). */
  findNearestGrowth(range) {
    let best = null;
    let bestD2 = range * range;
    const px = this.player.x;
    const py = this.player.y;
    for (const g of this.growths.getChildren()) {
      if (!g.active) continue;
      const dx = g.x - px;
      const dy = g.y - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = g;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ growths

  /** Устья дверей комнаты (точки внутри, для отступа наростов от проходов). */
  doorMouths(room) {
    return (room.doors || []).map((d) => {
      if (d.side === 'N') return { x: Math.max(room.x + 20, Math.min(room.x + room.w - 20, d.at)), y: room.y + 30 };
      if (d.side === 'S') return { x: Math.max(room.x + 20, Math.min(room.x + room.w - 20, d.at)), y: room.y + room.h - 30 };
      if (d.side === 'W') return { x: room.x + 30, y: Math.max(room.y + 20, Math.min(room.y + room.h - 20, d.at)) };
      return { x: room.x + room.w - 30, y: Math.max(room.y + 20, Math.min(room.y + room.h - 20, d.at)) };
    });
  }

  /** Один нарост в комнате: позиция, хп, вид. Не загораживает врата. */
  spawnGrowths(room) {
    if (room.growthsSpawned) return;
    room.growthsSpawned = true;
    const rng = mulberry32(((this.seed ^ Math.imul(room.id + 1, 0x51ed270b)) >>> 0) || 13);
    const n = room.isStart
      ? (rng() < 0.7 ? 1 : 0)
      : GROWTHS.minPerRoom + Math.floor(rng() * (GROWTHS.maxPerRoom - GROWTHS.minPerRoom + 1));
    const mouths = this.doorMouths(room);
    const portals = this.portalMode
      ? (this.layout.portals || []).filter((p) => p.roomId === room.id)
      : [];
    const placed = [];
    for (let i = 0; i < n * 30 && placed.length < n; i++) {
      const x = room.x + GROWTHS.inset + rng() * (room.w - GROWTHS.inset * 2);
      const y = room.y + GROWTHS.inset + rng() * (room.h - GROWTHS.inset * 2);
      const radius = GROWTHS.radiusMin + rng() * (GROWTHS.radiusMax - GROWTHS.radiusMin);
      if (!this.worldApi.isWalkable(x, y, radius)) continue; // стены и препятствия
      if (mouths.some((m) => Math.hypot(m.x - x, m.y - y) < GROWTHS.doorClearance)) continue;
      if (portals.some((p) => Math.hypot(p.x - x, p.y - y) < PORTAL.clearance)) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < GROWTHS.minSeparation)) continue;
      placed.push({ x, y, radius });
    }
    for (const p of placed) {
      const hp = GROWTHS.hpMin + Math.floor(rng() * (GROWTHS.hpMax - GROWTHS.hpMin + 1));
      const img = this.growths.create(p.x, p.y, TEX.growth);
      if (!img) continue;
      img.setDepth(4);
      img.setScale((p.radius * 2) / TEX_SIZE.growth);
      img.body.setAllowGravity(false);
      img.body.setCircle(p.radius * 0.8, 24 - p.radius * 0.8, 24 - p.radius * 0.8);
      img.body.setImmovable(true);
      img.setVelocity(0, 0);
      img.setData('hp', hp);
      img.setData('maxHp', hp);
      img.setData('radius', p.radius);
    }
  }

  onBulletGrowth(bullet, growth) {
    if (!bullet.active || !growth.active || this.isGameOver) return;
    const dmg = bullet.getData('dmg') ?? this.heroStats().attack;
    const bx = bullet.x;
    const by = bullet.y;
    bullet.destroy();
    const hp = (growth.getData('hp') ?? 1) - dmg;
    this.hitSparks.explode(4, bx, by);
    if (hp <= 0) {
      this.breakGrowth(growth);
      return;
    }
    growth.setData('hp', hp);
    // Нарост «трескается»: вспышка и ужатие по мере урона.
    setFillTint(growth, 0xffffff);
    this.time.delayedCall(60, () => {
      if (growth.active) growth.clearTint();
    });
    const frac = hp / (growth.getData('maxHp') || 1);
    const r = growth.getData('radius') || 18;
    growth.setScale(((r * 2) / TEX_SIZE.growth) * (0.7 + 0.3 * frac));
  }

  /** Разбиение нароста: биомасса, плазма, редко — артефакт или клетка. */
  breakGrowth(g) {
    const x = g.x;
    const y = g.y;
    const G = GROWTHS;
    this.hitSparks.explode(10, x, y);
    this.moteSparks.explode(6, x, y);
    g.destroy();
    // Лут определяется одним вызовом до любых эффектов (предсказуемо и тестируемо).
    const roll = rollGrowthLoot();
    if (roll.biomass) {
      this.spawnMotes(x, y,
        rollCount(Math.random, G.dropBiomassMin, G.dropBiomassMax));
    }
    if (roll.plasma) {
      this.spawnPlasmaDrops(x, y,
        rollCount(Math.random, G.dropPlasmaMin, G.dropPlasmaMax));
    }
    if (roll.artifact) this.grantGrowthArtifact(x, y);
    else if (roll.cell) this.grantGrowthCell(x, y);
  }

  grantGrowthArtifact(x, y) {
    const pool = ARTIFACT_CATALOG.filter((a) => !artifactMaxed(this.run, a.id));
    if (!pool.length) {
      this.spawnPlasmaDrops(x, y, GROWTHS.fallbackPlasma);
      ui.toast('Все артефакты улучшены — вместо этого плазма');
      return;
    }
    const def = pool[Math.floor(Math.random() * pool.length)];
    const res = this.run.buyArtifact(def.id, def);
    this.dirtyHero();
    if (def.effect.health) this.hp = Math.min(this.heroStats().maxHealth, this.hp + def.effect.health);
    ui.toast(res.activated ? `Артефакт «${def.name}» из нароста — активен!` : `Артефакт «${def.name}» из нароста усилен!`);
    this.pushHud();
  }

  grantGrowthCell(x, y) {
    void x;
    void y;
    const types = Object.keys(ALLY_TYPES);
    const type = types[Math.floor(Math.random() * types.length)];
    if (this.run.freeCellSlots() <= 0) {
      this.spawnPlasmaDrops(x, y, GROWTHS.fallbackPlasma);
      ui.toast('Нет места для клетки — вместо неё плазма');
      return;
    }
    const cell = this.run.addCell(type);
    if (!cell) return;
    this.spawnAllyView(cell);
    ui.setColonyCount(this.run.cells.length, this.run.maxCells);
    this.refreshColonyStrip();
    ui.toast(`Клетка «${ALLY_TYPES[type].name}» вылупилась из нароста!`);
    this.pushHud();
  }

  fireBulletAt(target, damage) {
    if (this.bullets.countActive(true) >= WEAPON.bulletPoolMax) return;
    const b = this.bullets.create(this.player.x, this.player.y, TEX.bullet);
    if (!b) return;
    b.setDepth(5);
    b.setData('age', 0);
    b.setData('dmg', damage);
    b.body.setAllowGravity(false);
    b.body.setCircle(5, 3, 3);
    const dx = target.x - this.player.x;
    const dy = target.y - this.player.y;
    const len = Math.hypot(dx, dy) || 1;
    b.setVelocity((dx / len) * WEAPON.bulletSpeed, (dy / len) * WEAPON.bulletSpeed);
    b.setRotation(Math.atan2(dy, dx));
    this.hitSparks.explode(2, this.player.x, this.player.y);
  }

  // ------------------------------------------------- enemy targeting (foes)

  /** Resolve an enemy's stored target to a live {kind,id,x,y,r} or null. */
  resolveFoeTarget(e) {
    const kind = e.getData('tKind');
    const id = e.getData('tId');
    if (kind === 'cell') {
      const cell = this.run.getCell(id);
      const v = cell ? this.allyViews.get(id) : null;
      if (cell && v && v.sprite.active) {
        return { kind, id, x: v.sprite.x, y: v.sprite.y, r: ALLY_TYPES[cell.type].bodyR };
      }
      return null;
    }
    // hero (default, incl. unset targets)
    if (!this.isGameOver && this.player && this.player.active) {
      return { kind: 'hero', id: null, x: this.player.x, y: this.player.y, r: PLAYER.bodyRadius };
    }
    return null;
  }

  /** Nearest living foe (hero + colony) with distance. */
  nearestFoe(x, y) {
    let best = null;
    let bestD = Infinity;
    if (!this.isGameOver && this.player && this.player.active) {
      bestD = Math.hypot(this.player.x - x, this.player.y - y);
      best = { kind: 'hero', id: null, x: this.player.x, y: this.player.y, r: PLAYER.bodyRadius, d: bestD };
    }
    for (const cell of this.run.cells) {
      const v = this.allyViews.get(cell.id);
      if (!v || !v.sprite.active) continue;
      const d = Math.hypot(v.sprite.x - x, v.sprite.y - y);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'cell', id: cell.id, x: v.sprite.x, y: v.sprite.y, r: ALLY_TYPES[cell.type].bodyR, d };
      }
    }
    return best;
  }

  /** Stable retarget tick: switch only on death/loss or a clearly closer rival. */
  retargetEnemies() {
    for (const e of this.enemies.getChildren()) {
      if (!e.active) continue;
      const cur = this.resolveFoeTarget(e);
      const near = this.nearestFoe(e.x, e.y);
      if (!near) {
        e.setVelocity(0, 0);
        continue;
      }
      if (!cur) {
        e.setData('tKind', near.kind);
        e.setData('tId', near.id);
        e.setData('atkCd', 0);
      } else {
        const curD = Math.hypot(cur.x - e.x, cur.y - e.y);
        const same = near.kind === cur.kind && near.id === cur.id;
        if (!same && near.d < curD * ENEMIES.retargetHysteresis) {
          e.setData('tKind', near.kind);
          e.setData('tId', near.id);
          e.setData('atkCd', 0);
        }
      }
    }
  }

  updateEnemies(dt) {
    this.pathBudget = 5; // A* calls per frame shared with allies (rest staggers)
    this.retargetAcc += dt;
    if (this.retargetAcc >= ENEMIES.retargetMs) {
      this.retargetAcc = 0;
      this.retargetEnemies();
    }
    for (const e of this.enemies.getChildren()) {
      if (!e.active) continue;
      if (e.getData('dying')) { e.setVelocity(0, 0); continue; } // агония: лежит
      const tgt = this.resolveFoeTarget(e) || this.nearestFoe(e.x, e.y);
      if (!tgt) {
        e.setVelocity(0, 0);
        continue;
      }
      e.setData('tKind', tgt.kind);
      e.setData('tId', tgt.id);
      const dx = tgt.x - e.x;
      const dy = tgt.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      // Stop at attack range + small margin so bodies never visually overlap.
      const range = e.getData('radius') * 0.8 + tgt.r + 4;
      // Игломёт: держит дистанцию и плюётся иглами; в упор — обычный укус.
      if (e.getData('typeKey') === ENEMIES.shooter.key && len > range) {
        this.updateShooter(e, tgt, dx, dy, len, dt);
        continue;
      }
      if (len > range) {
        this.steerEnemy(e, tgt.x, tgt.y, e.getData('speed'), dt);
        e.rotation += 0.015;
      } else {
        e.setVelocity(0, 0);
        const cd = (e.getData('atkCd') || 0) + dt;
        // Босс бьёт вближнюю по своему кулдауну из конфига.
        if (cd >= (e.getData('contactMs') || ENEMIES.attackCooldownMs)) {
          e.setData('atkCd', 0);
          this.enemyStrike(e, tgt);
        } else {
          e.setData('atkCd', cd);
        }
      }
    }
  }

  // ------------------------------------------------------ path steering

  /** Per-enemy path holder stored in Data (dropped with the enemy). */
  agentPath(e) {
    let h = e.getData('path');
    if (!h) {
      h = { pts: null, i: 0, gx: 0, gy: 0, age: 99, cd: 0 };
      e.setData('path', h);
    }
    return h;
  }

  pathNeedsRepath(h, tx, ty, interval) {
    if (!h.pts) return true;
    if (h.age > interval) return true;
    const dx = tx - h.gx;
    const dy = ty - h.gy;
    // arrived but target still far, or goal drifted: replan
    if (h.i >= h.pts.length) return dx * dx + dy * dy > 60 * 60;
    return dx * dx + dy * dy > 150 * 150;
  }

  repath(h, sx, sy, tx, ty) {
    if (this.pathBudget <= 0) return false;
    this.pathBudget -= 1;
    const pts = this.nav.findPath(sx, sy, tx, ty);
    if (pts && pts.length) {
      h.pts = pts;
      h.i = 0;
      h.gx = tx;
      h.gy = ty;
      h.age = 0;
      h.cd = 0;
      return true;
    }
    h.pts = null;
    h.cd = 1.5; // unreachable for now — don't hammer A* every frame
    return false;
  }

  /** Follow waypoints; true while a path is being followed. Always sets an
   * explicit velocity (never coasts on stale motion when a waypoint is hit). */
  followPath(obj, h, speed, reach = 34) {
    if (!h.pts) return false;
    let wp = h.pts[h.i];
    while (wp) {
      const dx = wp.x - obj.x;
      const dy = wp.y - obj.y;
      const d = Math.hypot(dx, dy);
      if (d >= reach) {
        obj.setVelocity((dx / d) * speed, (dy / d) * speed);
        return true;
      }
      h.i += 1;
      wp = h.pts[h.i];
    }
    return false; // path consumed: caller falls back to direct steering
  }

  steerEnemy(e, tx, ty, speed, dt) {
    const h = this.agentPath(e);
    h.age += dt;
    if (h.cd > 0) h.cd -= dt;
    const interval = 1000 + (((e.getData('seed') || 0) * 1000) % 500); // ms, staggered
    if (this.pathNeedsRepath(h, tx, ty, interval) && h.cd <= 0) {
      this.repath(h, e.x, e.y, tx, ty);
    }
    if (this.followPath(e, h, speed)) return;
    // Direct fallback (no path yet / budget exhausted): wobble chase.
    const dx = tx - e.x;
    const dy = ty - e.y;
    const len = Math.hypot(dx, dy) || 1;
    const seed = e.getData('seed') || 0;
    const wob = Math.sin((this.elapsedMs / 1000) * 2.2 + seed) * 0.25;
    const nx = dx / len;
    const ny = dy / len;
    e.setVelocity((nx - ny * wob) * speed, (ny + nx * wob) * speed);
  }

  /**
   * Игломёт: подходит к комфортной дистанции, пятится в упор,
   * на дистанции — плевок иглой из общего пула снарядов боссов.
   */
  updateShooter(e, tgt, dx, dy, len, dt) {
    const def = ENEMIES.shooter;
    const speed = e.getData('speed');
    if (len > def.shootRange + 60) {
      this.steerEnemy(e, tgt.x, tgt.y, speed, dt);
      e.rotation += 0.015;
      return;
    }
    if (len < def.shootRange - 90) {
      // Пятится от цели, не разворачиваясь.
      e.setVelocity(-(dx / len) * speed * 0.55, -(dy / len) * speed * 0.55);
      return;
    }
    e.setVelocity(0, 0);
    const cd = (e.getData('shotCd') || 0) + dt;
    if (cd >= def.shotCooldownMs) {
      e.setData('shotCd', 0);
      this.foeShot(e.x, e.y, Math.atan2(dy, dx), def.shotSpeed, def.shotDmg);
      this.hitSparks.explode(3, e.x, e.y);
    } else {
      e.setData('shotCd', cd);
    }
  }

  /** One melee swing at the resolved target (single delivery path). */
  enemyStrike(e, tgt) {
    if (!e.active || this.isGameOver) return;
    const dmg = e.getData('damage');
    if (tgt.kind === 'hero') this.applyHeroHit(dmg, e.x, e.y, e);
    else {
      const cell = this.run.getCell(tgt.id);
      if (cell) this.damageCell(cell, dmg, e.x, e.y);
    }
  }

  updateBullets(dt) {
    const b = this.playBounds;
    const margin = 60;
    for (const bullet of this.bullets.getChildren()) {
      if (!bullet.active) continue;
      bullet.setData('age', bullet.getData('age') + dt);
      if (
        bullet.getData('age') > WEAPON.bulletLifeMs ||
        bullet.x < b.x - margin || bullet.y < b.y - margin ||
        bullet.x > b.x + b.w + margin || bullet.y > b.y + b.h + margin
      ) {
        bullet.destroy(); // bounded by pool cap + lifespan; never accumulates
        continue;
      }
      // Портальный режим: стен-тел нет — снаряд гаснет, выйдя из плоти.
      if (this.portalMode && this.builder && !this.builder.isInsideAnyRoom(bullet.x, bullet.y, 2)) {
        this.hitSparks.explode(3, bullet.x, bullet.y);
        bullet.destroy();
      }
    }
  }

  // --------------------------------------------------------------- resources
  dropResources(typeKey, x, y) {
    const type = ENEMIES.types.find((t) => t.key === typeKey) || ENEMIES.types[0];
    if (Math.random() > type.dropChance) return;
    const [nMin, nMax] = type.dropCount;
    this.spawnMotes(x, y, nMin + Math.floor(Math.random() * (nMax - nMin + 1)));
  }

  /** Моты биомассы в свободных точках рядом (с лимитом группы). */
  spawnMotes(x, y, n) {
    for (let i = 0; i < n; i++) {
      if (this.resources.countActive(true) >= RESOURCE.cap) {
        const oldest = this.resources.getFirstAlive();
        if (oldest) oldest.destroy(); // recycle, never accumulate
      }
      const spot = this.freeSpotNear(x, y) || { x, y };
      const m = this.resources.create(spot.x, spot.y, TEX.mote);
      if (!m) continue;
      m.setDepth(3);
      m.body.setAllowGravity(false);
      m.body.setCircle(8, 2, 2);
      m.body.setImmovable(true);
      m.setVelocity(0, 0);
      this.tweens.add({ targets: m, y: spot.y + 5, duration: 900, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
  }

  /** Плазма: падает чаще биомассы и ценнее (она — валюта лавок). */
  dropPlasma(typeKey, x, y) {
    const chance = PLASMA.perEnemyChance[typeKey] ?? PLASMA.baseChance;
    if (Math.random() > chance) return;
    this.spawnPlasmaDrops(x, y,
      PLASMA.valueMin + Math.floor(Math.random() * (PLASMA.valueMax - PLASMA.valueMin + 1)));
  }

  /** Капли плазмы в свободных точках рядом (с лимитом группы). */
  spawnPlasmaDrops(x, y, n) {
    for (let i = 0; i < n; i++) {
      if (this.plasma.countActive(true) >= PLASMA.cap) {
        const oldest = this.plasma.getFirstAlive();
        if (oldest) oldest.destroy(); // recycle, never accumulate
      }
      const spot = this.freeSpotNear(x + (Math.random() - 0.5) * 40, y + (Math.random() - 0.5) * 40) ||
        this.freeSpotNear(x, y);
      if (!spot) continue;
      const m = this.plasma.create(spot.x, spot.y, TEX.plasma);
      if (!m) continue;
      m.setDepth(3);
      m.body.setAllowGravity(false);
      m.body.setCircle(9, 3, 3);
      m.body.setImmovable(true);
      m.setVelocity(0, 0);
      this.tweens.add({ targets: m, y: spot.y + 6, duration: 800, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    }
  }

  /** Ближайшая свободная от стен/препятствий точка (для выпадения ресурсов). */
  freeSpotNear(x, y) {
    return this.worldApi.nearestWalkable(x, y, 12);
  }

  updatePickups() {
    const st = this.heroStats();
    const r2 = st.pickupRadius * st.pickupRadius;
    const px = this.player.x;
    const py = this.player.y;
    for (const m of this.resources.getChildren()) {
      if (!m.active) continue;
      const dx = m.x - px;
      const dy = m.y - py;
      if (dx * dx + dy * dy < r2) {
        this.motes += 1;
        this.run.addBiomass(1); // биоматериал: валюта колонии (слияния)
        this.moteSparks.explode(6, m.x, m.y);
        m.destroy();
        // Биомасса — опыт: излишек за порогом уровня сохраняется.
        const gained = this.run.addXp(1);
        if (gained > 0) {
          this.pendingLevels += gained;
          this.pushHud();
          if (!this.modalOpen) this.openDraft();
        }
      }
    }
    for (const m of this.plasma.getChildren()) {
      if (!m.active) continue;
      const dx = m.x - px;
      const dy = m.y - py;
      if (dx * dx + dy * dy < r2) {
        this.run.addPlasma(1);
        this.moteSparks.explode(4, m.x, m.y);
        m.destroy();
      }
    }
  }

  updateShell(dt) {
    if (this.shell && this.player) {
      this.shell.setPosition(this.player.x, this.player.y);
      this.shellAngle += dt * 0.0014;
      this.shell.setRotation(this.shellAngle);
      const pulse = 1 + Math.sin(this.elapsedMs * 0.005) * 0.04;
      this.shell.setScale(pulse);
    }
  }

  pushHud() {
    const hs = this.heroStats();
    const hpChanged = Math.abs(this.hp - this.lastHudHp) >= 0.5;
    const plasmaChanged = this.lastHudPlasma !== this.run.plasma;
    const bioChanged = this.lastHudBio !== this.run.biomass; // баланс биоматериала
    if (hpChanged || this.kills !== this.lastHudKills || this.motes !== this.lastHudMotes || plasmaChanged || bioChanged) {
      this.lastHudHp = this.hp;
      this.lastHudKills = this.kills;
      this.lastHudMotes = this.motes;
      this.lastHudPlasma = this.run.plasma;
      this.lastHudBio = this.run.biomass;
      ui.update(this.hp, hs.maxHealth, this.kills, this.run.biomass, this.run.plasma);
    }
    if (this.run.level !== this.lastHudLevel || this.run.xp !== this.lastHudXp) {
      this.lastHudLevel = this.run.level;
      this.lastHudXp = this.run.xp;
      ui.setLevel(this.run.level, this.run.xp, this.run.requiredXp());
    }
    ui.setColonyCount(this.run.cells.length, this.run.maxCells);
    if (this.lastHudArtifacts !== this.run.activeArtifacts.length) {
      this.lastHudArtifacts = this.run.activeArtifacts.length;
      ui.setArtifacts(this.run.activeArtifacts.length, ARTIFACT_SLOTS);
    }
  }

  // -------------------------------------------------- draft & colony UI

  openDraft() {
    if (this.modalOpen || this.isGameOver || this.pendingLevels <= 0) return;
    this.modalOpen = true;
    ui.hideAction();
    this.draftCards = this.run.draftOptions().map((c) => {
      const d = describeCard(c, this.run);
      // Клетка — спрайт как в игре; мутации и улучшения рисуют свои иконки.
      if (c.kind === 'cell') d.img = this.texDataURL(allyTexKey(c.cellType, 1));
      return d;
    });
    panels.showDraft({
      level: this.run.level,
      cards: this.draftCards,
      onPick: (card) => this.onPickCard(card)
    });
    // Pause after this frame so the current update finishes cleanly.
    setTimeout(() => {
      if (!this.isGameOver && this.modalOpen) this.scene.pause();
    }, 0);
  }

  onPickCard(card) {
    if (card.kind === 'mutation') {
      panels.showTargets({
        title: card.title,
        options: this.mutationTargetOptions(card.mutation),
        onSelect: (target) => this.finishPick(card, target)
      });
      return;
    }
    this.finishPick(card, null);
  }

  mutationTargetOptions(key) {
    const opts = [
      { id: 'hero', label: 'Герой (ты)', sub: `мутация ур. ${this.run.mutationLevel('hero', key)}` }
    ];
    for (const cell of this.run.cells) {
      const t = ALLY_TYPES[cell.type];
      opts.push({
        id: `cell:${cell.id}`,
        label: `${t.name} #${cell.id}${cell.merge > 1 ? ` · слияние ${cell.merge}` : ''}`,
        sub: `мутация ур. ${this.run.mutationLevel('cell', key, cell.id)} · ЗДР ${Math.ceil(cell.hp)}`
      });
    }
    return opts;
  }

  finishPick(card, target) {
    const result = this.run.applyCard(card, target);
    if (card.kind === 'cell' && result) {
      this.spawnAllyView(result);
      ui.setColonyCount(this.run.cells.length, this.run.maxCells);
    }
    if (card.kind === 'mutation') {
      if (target && target.scope === 'hero' && card.mutation === 'membrane') {
        this.hp += MUTATIONS.membrane.healthBonus; // grow into the new tissue
      }
      if (target && target.scope === 'cell' && card.mutation === 'membrane' && target.id) {
        const cell = this.run.getCell(target.id);
        if (cell) cell.hp += MUTATIONS.membrane.healthBonus;
      }
    }
    this.dirtyHero();
    this.pendingLevels -= 1;
    this.refreshColonyStrip();
    this.pushHud();
    if (this.pendingLevels > 0 && !this.isGameOver) {
      // Chain: next level's draft while staying paused.
      this.draftCards = this.run.draftOptions().map((c) => {
        const d = describeCard(c, this.run);
        // Клетка — спрайт как в игре; мутации и улучшения рисуют свои иконки.
        if (c.kind === 'cell') d.img = this.texDataURL(allyTexKey(c.cellType, 1));
        return d;
      });
      panels.showDraft({
        level: this.run.level,
        cards: this.draftCards,
        onPick: (c) => this.onPickCard(c)
      });
      return;
    }
    panels.hideDraft();
    this.modalOpen = false;
    if (!this.isGameOver) this.scene.resume();
    this.pushHud();
  }

  openColony() {
    if (this.modalOpen || this.isGameOver) return;
    this.modalOpen = true;
    ui.hideAction();
    this.renderColony();
    setTimeout(() => {
      if (!this.isGameOver && this.modalOpen) this.scene.pause();
    }, 0);
  }

  /** Сбор/роспуск колонии: клетки сходятся к герою и игнорируют врагов. */
  toggleGatherMode() {
    if (this.isGameOver || this.run.cells.length === 0) return;
    this.gatherMode = !this.gatherMode;
    // Сброс целей, чтобы клетки сразу развернулись к герою.
    for (const cell of this.run.cells) {
      cell.target = null;
      cell.cd = 0;
      if (cell.path) { cell.path.pts = null; cell.path.cd = 0; }
      cell.orbit = null;
    }
    ui.setGather({ hasCells: true, active: this.gatherMode });
  }

  closeColony() {
    panels.hideColony();
    this.modalOpen = false;
    if (!this.isGameOver) this.scene.resume();
  }

  renderColony() {
    panels.showColony(this.colonySnapshot(), {
      onMerge: (aId, bId) => this.doMerge(aId, bId),
      onSplit: (id) => this.doSplit(id),
      onClose: () => this.closeColony()
    });
  }

  colonySnapshot() {
    return {
      run: this.run,
      hero: this.heroStats(),
      heroHp: this.hp,
      cells: this.run.cells.map((c) => ({
        cell: c,
        stats: this.run.computeCell(c),
        img: this.texDataURL(allyTexKey(c.type, c.merge))
      }))
    };
  }

  /** Гекс-лента колонии внизу: картинки, бейдж уровня, полоски здоровья. */
  refreshColonyStrip() {
    ui.setGather({
      hasCells: this.run.cells.length > 0 && !this.isGameOver,
      active: this.gatherMode
    });
    ui.renderColonyStrip(
      {
        hero: { level: this.run.level, xp: this.run.xp, req: this.run.requiredXp(), hp: this.hp, maxHp: this.heroStats().maxHealth },
        stashed: this.stashedCells.length,
        maxCells: this.run.maxCells,
        cells: this.run.cells.map((c) => {
          const st = this.run.computeCell(c);
          return {
            id: c.id, type: c.type, merge: c.merge,
            name: `${(ALLY_TYPES[c.type] || {}).name || c.type} #${c.id}`,
            img: this.texDataURL(allyTexKey(c.type, c.merge)),
            hp: Math.max(0, Math.ceil(c.hp == null ? st.maxHealth : c.hp)),
            maxHp: st.maxHealth, attack: st.attack,
            muts: Object.entries(c.mutations).map(([k, v]) => ({ name: (MUTATIONS[k] || {}).name || k, v }))
          };
        })
      },
      () => { if (!this.modalOpen && !this.isGameOver) this.openColony(); }
    );
  }

  doMerge(aId, bId) {
    const merged = this.run.mergeCells(aId, bId);
    if (!merged) return false;
    this.destroyAllyView(bId);
    this.refreshAllyBadge(merged);
    this.dirtyHero();
    ui.setColonyCount(this.run.cells.length, this.run.maxCells);
    this.renderColony();
    this.refreshColonyStrip();
    this.pushHud();
    return true;
  }

  /** Расщепить клетку на биоматериал (из окна колонии). */
  doSplit(id) {
    const cell = this.run.getCell(id);
    if (!cell) return false;
    const gained = this.run.splitCell(id);
    if (gained == null) return false;
    const v = this.allyViews.get(id);
    const x = v ? v.sprite.x : this.player.x;
    const y = v ? v.sprite.y : this.player.y;
    this.deathSparks.explode(12, x, y);
    this.moteSparks.explode(8, x, y);
    this.destroyAllyView(id);
    this.dirtyHero();
    ui.setColonyCount(this.run.cells.length, this.run.maxCells);
    this.renderColony();
    this.refreshColonyStrip();
    this.pushHud();
    ui.toast(`Клетка расщеплена · +${gained} биоматериала`);
    return true;
  }

  onBulletWall(a, b) {
    // NOTE: arcade delivers group-vs-array pairs SWAPPED as (wall, bullet)
    // (collideHandler routes them through collideSpriteVsGroup(object2, object1)).
    // Identify the bullet defensively — destroying the wall instead leaves a
    // permanent hole that everything passes through. When in doubt, destroy
    // nothing: a stray bullet expires by age, a dead wall does not come back.
    const isBullet = (o) => !!o && !!o.active && !!o.texture && o.texture.key === TEX.bullet;
    const bullet = isBullet(a) ? a : isBullet(b) ? b : null;
    if (!bullet || this.isGameOver) return;
    this.hitSparks.explode(3, bullet.x, bullet.y);
    bullet.destroy();
  }

  onBulletHit(bullet, enemy) {
    if (!bullet.active || !enemy.active || this.isGameOver) return;
    const dmg = bullet.getData('dmg') ?? this.heroStats().attack;
    bullet.destroy();
    this.damageEnemy(enemy, dmg);
  }

  /** Shared enemy-damage path (bullets + ally melee): flash, sparks, death. */
  damageEnemy(enemy, dmg) {
    if (!enemy.active || this.isGameOver) return;
    if (enemy.getData('dying')) return; // агония босса: урон уже не принимает
    const hp = enemy.getData('hp') - dmg;
    enemy.setData('hp', hp);
    if (enemy.getData('isBoss')) ui.setBossHp(Math.max(0, hp), enemy.getData('maxHp') || hp);
    this.hitSparks.explode(5, enemy.x, enemy.y);
    if (hp <= 0) {
      this.killEnemy(enemy);
    } else {
      // Brief white flash; guarded in case the enemy dies before the timer fires.
      setFillTint(enemy, 0xffffff);
      this.time.delayedCall(60, () => {
        if (enemy.active) enemy.clearTint();
      });
    }
  }

  /** Hero melee-range hit (replaces the old overlap damage; single path). */
  applyHeroHit(dmg, fromX, fromY, attacker = null) {
    if (this.isGameOver || !this.player || !this.player.active) return;
    const now = this.time.now;
    if (now < this.invulnUntil) return; // i-frames
    this.invulnUntil = now + PLAYER.invulnMs;

    this.hp -= dmg;
    this.hitSparks.explode(8, this.player.x, this.player.y);
    this.cameras.main.shake(90, 0.003);

    // Артефакт «Шипы»: урон атакующему в ответ.
    const thorns = this.heroStats().thorns;
    if (thorns > 0 && attacker && attacker.active) this.damageEnemy(attacker, thorns);

    // Knockback away from the attacker + red flash. Kept modest on purpose:
    // arcade ignores separation when overlap exceeds one step of motion,
    // so huge shoves into walls could ratchet through (see resolveEmbeddings).
    const dx = this.player.x - fromX;
    const dy = this.player.y - fromY;
    const len = Math.hypot(dx, dy) || 1;
    this.player.setVelocity((dx / len) * PLAYER.knockback * 1.4, (dy / len) * PLAYER.knockback * 1.4);
    setFillTint(this.player, 0xff4d5e);
    this.time.delayedCall(120, () => {
      if (this.player.active && !this.isGameOver) this.player.clearTint();
    });
    // Blink shell during i-frames.
    this.tweens.add({ targets: this.shell, alpha: 0.25, duration: 90, yoyo: true, repeat: 5,
      onComplete: () => this.shell && this.shell.setAlpha(1) });

    this.pushHud();
    if (this.hp <= 0) this.gameOver();
  }

  // ------------------------------------------------------- friendly cells

  spawnAllyView(cell) {
    const key = allyTexKey(cell.type, cell.merge);
    const size = TEX_SIZE[key] || 28;
    const a = Math.random() * Math.PI * 2;
    const spot =
      this.worldApi.nearestWalkable(
        this.player.x + Math.cos(a) * 70, this.player.y + Math.sin(a) * 70, 16
      ) || { x: this.player.x, y: this.player.y };
    const img = this.allies.create(spot.x, spot.y, key);
    if (!img) return null;
    img.setDepth(5);
    img.setCollideWorldBounds(true);
    const st = this.run.computeCell(cell);
    const br = st.bodyR * 0.8;
    img.body.setCircle(br, size / 2 - br, size / 2 - br);
    img.setScale(1 + ALLIES.scalePerMerge * (cell.merge - 1)); // клетка растёт с уровнем
    img.setData('cellId', cell.id);
    const lift = 22 + 5 * (cell.merge - 1); // полоска выше у выросших клеток
    const barBg = this.add.rectangle(spot.x, spot.y - lift, 30, 4, 0x0a0f0e, 0.85).setDepth(8);
    const bar = this.add.rectangle(spot.x, spot.y - lift, 30, 4, 0x3ddc84, 1).setDepth(8);
    const badge = this.add
      .text(spot.x, spot.y - 38 - 5 * (cell.merge - 1), MERGE_BADGE[Math.min(cell.merge, MERGE_BADGE.length) - 1] || 'I', {
        fontFamily: 'monospace', fontSize: '12px', color: '#9dffb0',
        backgroundColor: 'rgba(5,7,10,0.7)', padding: { x: 4, y: 2 }
      })
      .setOrigin(0.5)
      .setDepth(8)
      .setVisible(cell.merge > 1);
    this.allyViews.set(cell.id, { sprite: img, barBg, bar, badge });
    return img;
  }

  destroyAllyView(id) {
    const v = this.allyViews.get(id);
    if (!v) return;
    this.allyViews.delete(id);
    for (const o of [v.sprite, v.barBg, v.bar, v.badge]) {
      if (o && o.active) o.destroy();
    }
  }

  refreshAllyBadge(cell) {
    const v = this.allyViews.get(cell.id);
    if (!v) return;
    v.badge.setText(MERGE_BADGE[Math.min(cell.merge, MERGE_BADGE.length) - 1] || 'I');
    v.badge.setVisible(cell.merge > 1);
    v.sprite.setTexture(allyTexKey(cell.type, cell.merge)); // вид растёт с уровнем
    v.sprite.setScale(1 + ALLIES.scalePerMerge * (cell.merge - 1));
    this.refreshColonyStrip();
  }

  damageCell(cell, dmg) {
    const live = this.run.getCell(cell.id);
    if (!live || this.isGameOver) return;
    live.hp -= dmg;
    const v = this.allyViews.get(live.id);
    if (v && v.sprite.active) {
      setFillTint(v.sprite, 0xff4d5e);
      this.time.delayedCall(90, () => {
        if (v.sprite.active) v.sprite.clearTint();
      });
    }
    if (live.hp <= 0) this.killCell(live);
  }

  killCell(cell) {
    const v = this.allyViews.get(cell.id);
    const x = v ? v.sprite.x : this.player.x;
    const y = v ? v.sprite.y : this.player.y;
    this.deathSparks.explode(10, x, y);
    this.destroyAllyView(cell.id);
    this.run.removeCell(cell.id); // frees one colony slot
    ui.setColonyCount(this.run.cells.length, this.run.maxCells);
    if (panels.isColonyOpen()) this.renderColony();
    this.refreshColonyStrip();
  }

  /** Nearest live enemy within aggro, or null. */
  nearestEnemyFor(x, y, aggro) {
    let best = null;
    let bestD2 = aggro * aggro;
    for (const e of this.enemies.getChildren()) {
      if (!e.active) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  /**
   * Медик: лечит самую раненую цель в радиусе (герой или клетка).
   * Сила лечения = атака клетки, растёт со слияниями и мутациями.
   */
  medicHeal(cell, st) {
    const v = this.allyViews.get(cell.id);
    const sx = v ? v.sprite.x : this.player.x;
    const sy = v ? v.sprite.y : this.player.y;
    const radius = st.range;
    let best = null; // {apply(amount), frac, x, y, missing}
    const heroMax = this.heroStats().maxHealth;
    if (this.hp < heroMax && Math.hypot(this.player.x - sx, this.player.y - sy) <= radius) {
      best = {
        frac: this.hp / heroMax, x: this.player.x, y: this.player.y,
        missing: heroMax - this.hp,
        apply: (n) => { this.hp = Math.min(heroMax, this.hp + n); }
      };
    }
    for (const other of this.run.cells) {
      if (other.id === cell.id) continue;
      const ost = this.run.computeCell(other);
      const ohp = Math.max(0, other.hp == null ? ost.maxHealth : other.hp);
      if (ohp >= ost.maxHealth) continue;
      const ov = this.allyViews.get(other.id);
      if (!ov || !ov.sprite.active) continue;
      if (Math.hypot(ov.sprite.x - sx, ov.sprite.y - sy) > radius) continue;
      const frac = ohp / ost.maxHealth;
      if (!best || frac < best.frac) {
        best = {
          frac, x: ov.sprite.x, y: ov.sprite.y,
          missing: ost.maxHealth - ohp,
          apply: (n) => { other.hp = Math.min(ost.maxHealth, ohp + n); }
        };
      }
    }
    if (!best) return;
    best.apply(Math.min(st.attack, best.missing));
    this.hitSparks.explode(4, best.x, best.y);
  }

  updateAllies(dt) {
    for (const cell of [...this.run.cells]) {
      const v = this.allyViews.get(cell.id);
      if (!v || !v.sprite.active) continue;
      const st = this.run.computeCell(cell);
      const sp = v.sprite;
      cell.resting = false; // намеренная остановка — только в ветках ниже
      // Медик не атакует: держится орбиты героя и лечит вместо укусов.
      const isMedic = cell.type === 'medic';
      // Sticky target: keep until dead or far away, then nearest in aggro.
      let tgt = cell.target && cell.target.active ? cell.target : null;
      if (this.gatherMode || isMedic) {
        tgt = null; // сбор и медик: врагов игнорируем, цель — только герой
        cell.target = null;
        cell.cd = isMedic ? cell.cd : 0;
      } else if (tgt && Math.hypot(tgt.x - sp.x, tgt.y - sp.y) > ALLIES.dropAggroRadius) {
        tgt = null;
      }
      if (!tgt && !this.gatherMode && !isMedic) {
        tgt = this.nearestEnemyFor(sp.x, sp.y, ALLIES.aggroRadius);
        cell.target = tgt;
        cell.cd = 0;
      }
      if (tgt) {
        const dx = tgt.x - sp.x;
        const dy = tgt.y - sp.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > st.range) {
          if (!cell.path) cell.path = { pts: null, i: 0, gx: 0, gy: 0, age: 99, cd: 0 };
          const h = cell.path;
          h.age += dt;
          if (h.cd > 0) h.cd -= dt;
          if (this.pathNeedsRepath(h, tgt.x, tgt.y, 600) && h.cd <= 0) {
            this.repath(h, sp.x, sp.y, tgt.x, tgt.y);
          }
          if (!this.followPath(sp, h, st.moveSpeed)) {
            sp.setVelocity((dx / d) * st.moveSpeed, (dy / d) * st.moveSpeed);
          }
        } else {
          sp.setVelocity(0, 0);
          cell.resting = true;
          cell.cd += dt;
          if (cell.cd >= st.intervalMs) {
            cell.cd = 0;
            this.damageEnemy(tgt, st.attack);
          }
        }
      } else {
        // No foes (or gather mode): route back to the hero's orbit so the
        // colony stays together (paths lead through doors/tunnels instead of
        // pushing into walls). В сборе орбита плотнее — клетки сходятся к герою.
        // Якорь орбиты — всегда проходимая точка: сырой слот может лежать
        // внутри нароста/стенда, и тогда клетка вечно давила бы в стену.
        const ang = cell.id * 2.4;
        const orbR = this.gatherMode ? 34 : 95;
        let orb = cell.orbit;
        if (!orb || Math.hypot(this.player.x - orb.hx, this.player.y - orb.hy) > (this.gatherMode ? 20 : 50)) {
          const rawX = this.player.x + Math.cos(ang) * orbR;
          const rawY = this.player.y + Math.sin(ang) * orbR;
          const spot = this.worldApi.nearestWalkable(rawX, rawY, st.bodyR) ||
            { x: this.player.x, y: this.player.y };
          orb = cell.orbit = { x: spot.x, y: spot.y, hx: this.player.x, hy: this.player.y };
          if (cell.path) { cell.path.pts = null; cell.path.cd = 0; }
        }
        const dx = orb.x - sp.x;
        const dy = orb.y - sp.y;
        const d = Math.hypot(dx, dy);
        if (!cell.path) cell.path = { pts: null, i: 0, gx: 0, gy: 0, age: 99, cd: 0 };
        const h = cell.path;
        if (d < 30) {
          sp.setVelocity(0, 0);
          cell.resting = true;
          h.pts = null;
          h.cd = 0.4;
        } else {
          h.age += dt;
          if (h.cd > 0) h.cd -= dt;
          if (this.pathNeedsRepath(h, orb.x, orb.y, 800) && h.cd <= 0) {
            this.repath(h, sp.x, sp.y, orb.x, orb.y);
          }
          if (!this.followPath(sp, h, st.moveSpeed)) {
            const s = d > ALLIES.leashRadius ? 1 : 0.5;
            sp.setVelocity((dx / d) * st.moveSpeed * s, (dy / d) * st.moveSpeed * s);
          }
        }
      }
      if (isMedic) {
        cell.cd += dt;
        if (cell.cd >= st.intervalMs) {
          cell.cd = 0;
          this.medicHeal(cell, st);
        }
      }
      this.pushOutOfSolids(sp, st.bodyR * 0.8);
      this.constrainToTissue(sp, st.bodyR * 0.8);
      this.slideAlongTissue(sp, st.bodyR * 0.8);
      this.trackAllyStuck(cell, sp, dt);
    }
  }

  /**
   * Детектор застревания: клетка не отдыхает (есть цель/орбита), но почти не
   * смещается ~1.2с — значит, её зажало (толкотня колонии, узость, угол).
   * Спасаем переносом в свободную точку у героя и сбросом пути.
   */
  trackAllyStuck(cell, sp, dt) {
    if (!cell.stuck) cell.stuck = { x: sp.x, y: sp.y, acc: 0, bad: 0 };
    const mark = cell.stuck;
    if (cell.resting) {
      mark.acc = 0;
      mark.bad = 0;
      mark.x = sp.x;
      mark.y = sp.y;
      return;
    }
    mark.acc += dt;
    if (mark.acc < 600) return;
    mark.acc = 0;
    if (Math.hypot(sp.x - mark.x, sp.y - mark.y) < 12) {
      mark.bad += 1;
    } else {
      mark.bad = 0;
    }
    mark.x = sp.x;
    mark.y = sp.y;
    if (mark.bad >= 2) {
      mark.bad = 0;
      this.rescueAlly(cell, sp);
    }
  }

  /** Вытащить застрявшую клетку: свободное место у героя + новый план пути. */
  rescueAlly(cell, sp) {
    const st = this.run.computeCell(cell);
    let spot = null;
    for (let i = 0; i < 6 && !spot; i++) {
      const a = Math.random() * Math.PI * 2;
      spot = this.worldApi.nearestWalkable(
        this.player.x + Math.cos(a) * (80 + i * 15),
        this.player.y + Math.sin(a) * (80 + i * 15), st.bodyR);
    }
    if (!spot) return;
    sp.body.reset(spot.x, spot.y);
    sp.setVelocity(0, 0);
    cell.path = null;
    cell.orbit = null;
  }

  updateAllyViews() {
    for (const cell of this.run.cells) {
      const v = this.allyViews.get(cell.id);
      if (!v || !v.sprite.active) continue;
      const st = this.run.computeCell(cell);
      const frac = Math.max(0, Math.min(1, cell.hp / st.maxHealth));
      const x = v.sprite.x;
      const y = v.sprite.y;
      const lift = 22 + 5 * (cell.merge - 1);
      v.barBg.setPosition(x, y - lift);
      v.bar.setPosition(x - (30 * (1 - frac)) / 2, y - lift);
      v.bar.width = Math.max(1, 30 * frac);
      v.bar.setFillStyle(frac <= 0.3 ? 0xff4d5e : 0x3ddc84, 1);
      v.badge.setPosition(x + 16, y - lift + 2);
    }
  }

  killEnemy(enemy) {
    // Босс умирает по-своему: награда, свита, колония, зачистка зала.
    if (enemy.getData && enemy.getData('isBoss')) {
      this.killBoss(enemy);
      return;
    }
    // Capture everything before destroy(): post-destroy reads are unreliable.
    const x = enemy.x;
    const y = enemy.y;
    const roomId = enemy.getData('roomId');
    const typeKey = enemy.getData('typeKey');
    this.deathSparks.explode(14, x, y);
    enemy.destroy();
    this.kills += 1;
    this.dropResources(typeKey, x, y);
    this.dropPlasma(typeKey, x, y);
    this.applyLeech();
    const room = typeof roomId === 'number' ? this.layout.rooms[roomId] : null;
    this.checkRoomCleared(room);
    this.pushHud();
  }

  /** Артефакт «Пиявка»: лечение за каждое убийство. */
  applyLeech() {
    const st = this.heroStats();
    if (st.leech > 0 && this.hp < st.maxHealth) {
      this.hp = Math.min(st.maxHealth, this.hp + st.leech);
    }
  }

  gameOver() {
    if (this.isGameOver) return;
    this.isGameOver = true;
    this.hp = 0;
    this.gatherMode = false;
    ui.setGather({ hasCells: false, active: false });
    ui.hideBoss();
    ui.hideAction();
    panels.hideAll();
    this.modalOpen = false;
    this.pendingLevels = 0;
    this.pushHud();
    this.deathSparks.explode(40, this.player.x, this.player.y);
    this.cameras.main.shake(220, 0.006);
    this.trail.stop();
    // Cancel pending telegraphs so nothing spawns after death.
    for (const m of this.markers) {
      this.tweens.killTweensOf(m.view);
      if (m.timer) m.timer.remove(false);
      m.view.destroy();
    }
    this.markers = [];
    this.player.setVelocity(0, 0);
    this.player.disableBody(true, false);
    this.player.setVisible(false);
    this.shell.setVisible(false);
    // Freeze gameplay but keep the scene alive so Restart works via scene.restart().
    this.physics.pause();
    ui.showGameOver(this.kills, this.motes);
  }
}
