import Phaser from 'phaser';
import {
  COLORS, DUNGEON, PLAYER, HERO_BASE, ENEMIES, ENEMY_LEVEL, SPAWNS, RESOURCE, WEAPON,
  ALLIES, ALLY_TYPES, MUTATIONS, PLASMA, SHOP, ARTIFACTS, ARTIFACT_CATALOG, UPGRADES,
  GROWTHS, ARENA, PORTAL, pickEnemyType, resolveSeed, resolveWithTunnels
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
  'cell-hunter': 'cell-hunter',
  'cell-defender': 'cell-defender',
  'cell-parasite': 'cell-parasite'
};

const TEX_SIZE = { dot: 8, player: 40, shell: 56, bullet: 16, mote: 20, plasma: 24, growth: 48, stand: 64, coin: 20, relic: 28, tonic: 24, portal: 56, 'enemy-a': 32, 'enemy-b': 36, 'enemy-c': 48, 'cell-hunter': 28, 'cell-defender': 36, 'cell-parasite': 24 };

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

function ensureTextures(scene) {
  // Shared 8px soft dot for all particle emitters.
  makeCircleTexture(scene, TEX.dot, TEX_SIZE.dot, (g, s) => {
    g.fillStyle(0xffffff, 1);
    g.fillCircle(s / 2, s / 2, s / 2 - 1);
  });

  // Player core: dark disc + yellow nucleus (kept bright vs. the red dungeon).
  makeCircleTexture(scene, TEX.player, TEX_SIZE.player, (g, s) => {
    const c = s / 2;
    g.fillStyle(0x0a1512, 1);
    g.fillCircle(c, c, 15);
    g.lineStyle(2, COLORS.playerShell, 0.9);
    g.strokeCircle(c, c, 15);
    g.fillStyle(COLORS.playerCore, 1);
    g.fillCircle(c, c, 8);
    g.fillStyle(0xffffff, 0.9);
    g.fillCircle(c - 2.5, c - 2.5, 2.5);
  });

  // Thin glowing shell ring with 4 notches (rotates slowly in update).
  makeCircleTexture(scene, TEX.shell, TEX_SIZE.shell, (g, s) => {
    const c = s / 2;
    g.lineStyle(1.5, COLORS.playerShell, 0.85);
    g.strokeCircle(c, c, 24);
    g.lineStyle(2, COLORS.playerShell, 0.9);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const x1 = c + Math.cos(a) * 24;
      const y1 = c + Math.sin(a) * 24;
      const x2 = c + Math.cos(a) * 27;
      const y2 = c + Math.sin(a) * 27;
      g.lineBetween(x1, y1, x2, y2);
    }
  });

  // Bullet: yellow-hot core.
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

  // Portal: белая основа-«мембрана», красится тинтом в цвет пары врат.
  if (!scene.textures.exists(TEX.portal)) {
    const s = TEX_SIZE.portal;
    const g = scene.add.graphics();
    const c = s / 2;
    g.fillStyle(0xffffff, 0.22);
    g.fillCircle(c, c, 26);
    g.fillStyle(0xffffff, 0.85);
    g.fillCircle(c, c, 20);
    g.fillStyle(0x0a0507, 1);
    g.fillCircle(c, c, 13);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c, 10);
    g.lineStyle(2, 0xffffff, 0.9);
    g.strokeCircle(c, c, 24);
    g.generateTexture(TEX.portal, s, s);
    g.destroy();
  }

  // Enemy A: triangle (fast, fragile).
  if (!scene.textures.exists(TEX['enemy-a'])) {
    const s = TEX_SIZE['enemy-a'];
    const g = scene.add.graphics();
    g.fillStyle(COLORS.enemyA, 1);
    g.fillTriangle(s / 2, 3, s - 3, s - 4, 3, s - 4);
    g.lineStyle(1.5, 0xffffff, 0.55);
    g.strokeTriangle(s / 2, 3, s - 3, s - 4, 3, s - 4);
    g.generateTexture(TEX['enemy-a'], s, s);
    g.destroy();
  }

  // Enemy B: square (balanced).
  if (!scene.textures.exists(TEX['enemy-b'])) {
    const s = TEX_SIZE['enemy-b'];
    const g = scene.add.graphics();
    const m = 5;
    g.fillStyle(COLORS.enemyB, 1);
    g.fillRect(m, m, s - m * 2, s - m * 2);
    g.lineStyle(1.5, 0xffffff, 0.5);
    g.strokeRect(m, m, s - m * 2, s - m * 2);
    g.fillStyle(0x3d0d08, 1);
    g.fillCircle(s / 2, s / 2, 5);
    g.generateTexture(TEX['enemy-b'], s, s);
    g.destroy();
  }

  // Enemy C: pentagon (tank).
  if (!scene.textures.exists(TEX['enemy-c'])) {
    const s = TEX_SIZE['enemy-c'];
    const g = scene.add.graphics();
    const c = s / 2;
    const r = s / 2 - 3;
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i / 5) * Math.PI * 2;
      pts.push({ x: c + Math.cos(a) * r, y: c + Math.sin(a) * r });
    }
    g.fillStyle(COLORS.enemyC, 1);
    g.fillPoints(pts, true);
    g.lineStyle(2, 0xffffff, 0.5);
    g.strokePoints(pts, true);
    g.fillStyle(0x2b060d, 1);
    g.fillCircle(c, c, 7);
    g.generateTexture(TEX['enemy-c'], s, s);
    g.destroy();
  }

  // Friendly cells: distinct silhouettes, never red (enemies stay red).
  if (!scene.textures.exists(TEX['cell-hunter'])) {
    const s = TEX_SIZE['cell-hunter'];
    const g = scene.add.graphics();
    g.fillStyle(ALLY_TYPES.hunter.tint, 1); // cyan dart
    g.fillTriangle(s / 2, 2, s - 2, s - 2, 2, s - 2);
    g.lineStyle(1.5, 0xffffff, 0.6);
    g.strokeTriangle(s / 2, 2, s - 3, s - 3, 3, s - 3);
    g.fillStyle(0x06232b, 1);
    g.fillCircle(s / 2, s / 2 + 4, 4);
    g.generateTexture(TEX['cell-hunter'], s, s);
    g.destroy();
  }
  if (!scene.textures.exists(TEX['cell-defender'])) {
    const s = TEX_SIZE['cell-defender'];
    const g = scene.add.graphics();
    const c = s / 2;
    const r = s / 2 - 2;
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      pts.push({ x: c + Math.cos(a) * r, y: c + Math.sin(a) * r });
    }
    g.fillStyle(ALLY_TYPES.defender.tint, 1); // bulky teal hexagon
    g.fillPoints(pts, true);
    g.lineStyle(2, 0xffffff, 0.55);
    g.strokePoints(pts, true);
    g.lineStyle(2, 0x06231c, 0.9);
    g.strokeCircle(c, c, r * 0.55);
    g.generateTexture(TEX['cell-defender'], s, s);
    g.destroy();
  }
  if (!scene.textures.exists(TEX['cell-parasite'])) {
    const s = TEX_SIZE['cell-parasite'];
    const g = scene.add.graphics();
    const c = s / 2;
    g.fillStyle(ALLY_TYPES.parasite.tint, 1); // small lime node with tail
    g.fillCircle(c, c - 2, 7);
    g.lineStyle(2, ALLY_TYPES.parasite.tint, 0.9);
    g.lineBetween(c - 4, c + 4, c - 7, c + 10);
    g.lineBetween(c + 4, c + 4, c + 7, c + 10);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(c, c - 2, 2.2);
    g.generateTexture(TEX['cell-parasite'], s, s);
    g.destroy();
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
    this.lastHudArtifacts = -1;
    this.lastHudLevel = -1;
    this.lastHudXp = -1;
    this.shellAngle = 0;
    this.markers = []; // pending spawn telegraphs {view, timer}
    this.retryAcc = 0;
    this.expandAcc = 0;
    this.wingCount = 0;
    this.expandRetryAt = 0;
    this.currentRoom = null;
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
    this.fireAcc = this.heroStats().intervalMs; // first shot ready immediately
    this.spawnAllPortals();
  }

  // ----------------------------------------------------------------- update

  update(time, delta) {
    if (this.isGameOver || !this.player || !this.player.active) return;
    const dt = Math.min(delta, 100); // clamp tab-switch spikes
    this.elapsedMs += dt;

    // Safety net BEFORE new input applies: positions are post-physics here.
    // Arcade skips separation when overlap exceeds one step's motion + bias
    // (its anti-teleport guard), which a combat knockback can trigger — then
    // input would ratchet the player through the wall. Resolve any embedding
    // deterministically so a pass-through can never accumulate.
    this.resolveEmbeddings();
    this.updateMovement();
    this.updateRooms(dt);
    this.updateWeapon(dt);
    this.updateEnemies(dt);
    this.resolveEnemyEmbeddings();
    this.updateAllies(dt);
    this.updateBullets(dt);
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
    const solids = this.layout.solids;
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
  }

  resolveEnemyEmbeddings() {
    // Enemies can ratchet through walls the same way (separation shoves trip
    // arcade's anti-teleport guard). Same deterministic rescue keeps them out.
    for (const e of this.enemies.getChildren()) {
      if (!e.active) continue;
      this.pushOutOfSolids(e, (e.getData('radius') || 14) * 0.8);
    }
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

  /** Заблокированы ли врата: незачищенная боевая комната не выпускает. */
  portalLocked(room) {
    return !!room && room.type === 'combat' && !room.isStart &&
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

  /** Один портал: зона-триггер + кольцо в цвете пары + мягкая пульсация. */
  spawnPortalView(p) {
    if (this.portalViews.has(p.id)) return;
    const color = this.portalPairColor(p.linkIdx);
    const zone = this.portalGroup.create(p.x, p.y, TEX.portal);
    if (!zone) return;
    zone.setDepth(4);
    zone.setTint(color);
    zone.setData('portalId', p.id);
    zone.body.setCircle(PORTAL.radius, TEX_SIZE.portal / 2 - PORTAL.radius, TEX_SIZE.portal / 2 - PORTAL.radius);
    zone.body.updateFromGameObject();
    const ring = this.add.circle(p.x, p.y, PORTAL.bodyRadius + 8)
      .setStrokeStyle(3, color, 0.8).setDepth(3);
    this.tweens.add({
      targets: [zone, ring], scale: 1.08, duration: 800 + (p.id % 5) * 90,
      yoyo: true, repeat: -1, ease: 'Sine.easeInOut'
    });
    const view = { zone, ring, data: p, locked: false, color };
    this.portalViews.set(p.id, view);
    this.refreshPortalLock(view, this.layout.rooms[p.roomId]);
  }

  /** Перекраска врат при блокировке/разблокировке комнаты. */
  refreshPortalLock(view, room) {
    if (!view || !view.zone || !view.zone.active) return;
    const locked = this.portalLocked(room);
    view.locked = locked;
    const tint = locked ? PORTAL.lockedColor : view.color;
    view.zone.setTint(tint);
    if (view.ring && view.ring.active) view.ring.setStrokeStyle(3, tint, locked ? 1 : 0.8);
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
    this.markers.push({ view, timer });
  }

  spawnEnemyAt(x, y, roomId) {
    const type = pickEnemyType();
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

  /** Nearest dead-end (leaf) room to the player; lowest degree breaks ties. */
  pickGateway() {
    const deg = roomDegrees(this.layout);
    let best = null;
    let bestScore = null;
    for (const r of this.layout.rooms) {
      const d = deg.get(r.id) ?? 99;
      const dist = Math.hypot(r.cx - this.player.x, r.cy - this.player.y);
      // Leaves first (degree 1), then nearest — score sorts degree, then dist.
      const score = d * 1e9 + dist;
      if (bestScore === null || score < bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best;
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
    const res = generateWing(this.seed, wingIndex, this.layout, gateway.id);
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
    ui.toast(`New tissue grown — ${res.roomIds.length} chambers (wing ${wingIndex})`);
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
      if (!e.active) continue;
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
      if (len > range) {
        this.steerEnemy(e, tgt.x, tgt.y, e.getData('speed'), dt);
        e.rotation += 0.015;
      } else {
        e.setVelocity(0, 0);
        const cd = (e.getData('atkCd') || 0) + dt;
        if (cd >= ENEMIES.attackCooldownMs) {
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
    if (hpChanged || this.kills !== this.lastHudKills || this.motes !== this.lastHudMotes || plasmaChanged) {
      this.lastHudHp = this.hp;
      this.lastHudKills = this.kills;
      this.lastHudMotes = this.motes;
      this.lastHudPlasma = this.run.plasma;
      ui.update(this.hp, hs.maxHealth, this.kills, this.motes, this.run.plasma);
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
    this.draftCards = this.run.draftOptions().map((c) => describeCard(c, this.run));
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
      { id: 'hero', label: 'Hero (you)', sub: `mutation Lv ${this.run.mutationLevel('hero', key)}` }
    ];
    for (const cell of this.run.cells) {
      const t = ALLY_TYPES[cell.type];
      opts.push({
        id: `cell:${cell.id}`,
        label: `${t.name} #${cell.id}${cell.merge > 1 ? ` · merge ${cell.merge}` : ''}`,
        sub: `mutation Lv ${this.run.mutationLevel('cell', key, cell.id)} · HP ${Math.ceil(cell.hp)}`
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
    this.pushHud();
    if (this.pendingLevels > 0 && !this.isGameOver) {
      // Chain: next level's draft while staying paused.
      this.draftCards = this.run.draftOptions().map((c) => describeCard(c, this.run));
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
    this.renderColony();
    setTimeout(() => {
      if (!this.isGameOver && this.modalOpen) this.scene.pause();
    }, 0);
  }

  closeColony() {
    panels.hideColony();
    this.modalOpen = false;
    if (!this.isGameOver) this.scene.resume();
  }

  renderColony() {
    panels.showColony(this.colonySnapshot(), {
      onMerge: (aId, bId) => this.doMerge(aId, bId),
      onClose: () => this.closeColony()
    });
  }

  colonySnapshot() {
    return {
      run: this.run,
      hero: this.heroStats(),
      heroHp: this.hp,
      cells: this.run.cells.map((c) => ({ cell: c, stats: this.run.computeCell(c) }))
    };
  }

  doMerge(aId, bId) {
    const merged = this.run.mergeCells(aId, bId);
    if (!merged) return false;
    this.destroyAllyView(bId);
    this.refreshAllyBadge(merged);
    this.dirtyHero();
    ui.setColonyCount(this.run.cells.length, this.run.maxCells);
    this.renderColony();
    this.pushHud();
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
    const hp = enemy.getData('hp') - dmg;
    enemy.setData('hp', hp);
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
    const key = `cell-${cell.type}`;
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
    img.setScale(1 + 0.12 * (cell.merge - 1));
    img.setData('cellId', cell.id);
    const barBg = this.add.rectangle(spot.x, spot.y - 22, 30, 4, 0x0a0f0e, 0.85).setDepth(8);
    const bar = this.add.rectangle(spot.x, spot.y - 22, 30, 4, 0x3ddc84, 1).setDepth(8);
    const badge = this.add
      .text(spot.x, spot.y - 38, MERGE_BADGE[Math.min(cell.merge, MERGE_BADGE.length) - 1] || 'I', {
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
    v.sprite.setScale(1 + 0.12 * (cell.merge - 1));
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

  updateAllies(dt) {
    for (const cell of [...this.run.cells]) {
      const v = this.allyViews.get(cell.id);
      if (!v || !v.sprite.active) continue;
      const st = this.run.computeCell(cell);
      const sp = v.sprite;
      // Sticky target: keep until dead or far away, then nearest in aggro.
      let tgt = cell.target && cell.target.active ? cell.target : null;
      if (tgt && Math.hypot(tgt.x - sp.x, tgt.y - sp.y) > ALLIES.dropAggroRadius) tgt = null;
      if (!tgt) {
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
          cell.cd += dt;
          if (cell.cd >= st.intervalMs) {
            cell.cd = 0;
            this.damageEnemy(tgt, st.attack);
          }
        }
      } else {
        // No foes: route back to the hero's orbit so the colony stays together
        // (paths lead through doors/tunnels instead of pushing into walls).
        const ang = cell.id * 2.4;
        const ax = this.player.x + Math.cos(ang) * 95;
        const ay = this.player.y + Math.sin(ang) * 95;
        const dx = ax - sp.x;
        const dy = ay - sp.y;
        const d = Math.hypot(dx, dy);
        if (!cell.path) cell.path = { pts: null, i: 0, gx: 0, gy: 0, age: 99, cd: 0 };
        const h = cell.path;
        if (d < 30) {
          sp.setVelocity(0, 0);
          h.pts = null;
          h.cd = 0.4;
        } else {
          h.age += dt;
          if (h.cd > 0) h.cd -= dt;
          if (this.pathNeedsRepath(h, ax, ay, 800) && h.cd <= 0) {
            this.repath(h, sp.x, sp.y, ax, ay);
          }
          if (!this.followPath(sp, h, st.moveSpeed)) {
            const s = d > ALLIES.leashRadius ? 1 : 0.5;
            sp.setVelocity((dx / d) * st.moveSpeed * s, (dy / d) * st.moveSpeed * s);
          }
        }
      }
      this.pushOutOfSolids(sp, st.bodyR * 0.8);
    }
  }

  updateAllyViews() {
    for (const cell of this.run.cells) {
      const v = this.allyViews.get(cell.id);
      if (!v || !v.sprite.active) continue;
      const st = this.run.computeCell(cell);
      const frac = Math.max(0, Math.min(1, cell.hp / st.maxHealth));
      const x = v.sprite.x;
      const y = v.sprite.y;
      v.barBg.setPosition(x, y - 22);
      v.bar.setPosition(x - (30 * (1 - frac)) / 2, y - 22);
      v.bar.width = Math.max(1, 30 * frac);
      v.bar.setFillStyle(frac <= 0.3 ? 0xff4d5e : 0x3ddc84, 1);
      v.badge.setPosition(x + 16, y - 20);
    }
  }

  killEnemy(enemy) {
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
