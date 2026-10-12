import Phaser from 'phaser';
import {
  COLORS, DUNGEON, PLAYER, HERO_BASE, ENEMIES, ENEMY_LEVEL, SPAWNS, RESOURCE, WEAPON,
  ALLIES, ALLY_TYPES, MUTATIONS, pickEnemyType, resolveSeed
} from '../config.js';
import { generateLayout } from '../world/generator.js';
import { WorldBuilder } from '../world/WorldBuilder.js';
import { NavGrid } from '../world/navgrid.js';
import { RunState } from '../game/run.js';
import { describeCard } from '../game/cards.js';
import { ui } from '../ui.js';
import { Minimap } from '../ui/minimap.js';
import * as panels from '../ui/progression.js';

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
  'enemy-a': 'enemy-a',
  'enemy-b': 'enemy-b',
  'enemy-c': 'enemy-c',
  'cell-hunter': 'cell-hunter',
  'cell-defender': 'cell-defender',
  'cell-parasite': 'cell-parasite'
};

const TEX_SIZE = { dot: 8, player: 40, shell: 56, bullet: 16, mote: 20, 'enemy-a': 32, 'enemy-b': 36, 'enemy-c': 48, 'cell-hunter': 28, 'cell-defender': 36, 'cell-parasite': 24 };

const MERGE_BADGE = ['I', 'II', 'III', 'IV', 'V'];

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
    this.lastHudLevel = -1;
    this.lastHudXp = -1;
    this.shellAngle = 0;
    this.markers = []; // pending spawn telegraphs {view, timer}
    this.retryAcc = 0;
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
      spawnMax: DUNGEON.spawnMax
    });
    this.worldApi = new WorldBuilder(this, this.layout, COLORS).build();
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
    ui.setColonyCount(0, ALLIES.max);
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
    this.allies = this.physics.add.group();

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
      ? this.input.keyboard.addKeys('W,A,S,D')
      : null;

    // --- Collisions (registered once, never per-frame) ---
    // NOTE: hero/enemy and enemy/cell damage is timer-based at attack range
    // (single delivery path — no double hits from overlap + timer).
    this.physics.add.collider(this.player, this.worldApi.bodies);
    this.physics.add.collider(this.enemies, this.worldApi.bodies);
    this.physics.add.collider(this.enemies, this.enemies); // de-stack chasers
    this.physics.add.collider(this.allies, this.worldApi.bodies);
    this.physics.add.collider(this.allies, this.allies); // de-stack colony
    this.physics.add.collider(this.bullets, this.worldApi.bodies, this.onBulletWall, null, this);
    this.physics.add.overlap(this.bullets, this.enemies, this.onBulletHit, null, this);
    this.fireAcc = this.heroStats().intervalMs; // first shot ready immediately
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
    this.minimapAcc += dt;
    if (this.minimapAcc >= 300) {
      this.minimapAcc = 0;
      this.minimap.update(this.player.x, this.player.y, this.layout.rooms, this.currentRoom ? this.currentRoom.id : null);
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
  }

  activateRoom(room) {
    room.activated = true;
    room.spawnedTotal = 0;
    room.markersPending = 0;
    room.cleared = false;
    room.queue = room.spawns.map((p) => ({ ...p }));
    // Level scaling: extra spawn markers on top of the base points.
    const extra = (this.run.level - 1) * ENEMY_LEVEL.extraSpawnsPerLevel;
    for (const p of this.sampleExtraSpawns(room, extra)) room.queue.push(p);
    this.tryQueue(room);
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
    if (!room.spawnedTotal) return;
    const alive = this.enemies.getChildren().some((e) => e.active && e.getData('roomId') === room.id);
    if (!alive) room.cleared = true; // stays cleared for the rest of the run
  }

  // ---------------------------------------------------------------- combat

  updateWeapon(dt) {
    const hs = this.heroStats();
    this.fireAcc += dt;
    if (this.fireAcc < hs.intervalMs) return;
    const target = this.findNearestEnemy(WEAPON.range);
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
    if (tgt.kind === 'hero') this.applyHeroHit(dmg, e.x, e.y);
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

  dropResources(typeKey, x, y) {    const type = ENEMIES.types.find((t) => t.key === typeKey) || ENEMIES.types[0];
    if (Math.random() > type.dropChance) return;
    const [nMin, nMax] = type.dropCount;
    const n = nMin + Math.floor(Math.random() * (nMax - nMin + 1));
    for (let i = 0; i < n; i++) {
      if (this.resources.countActive(true) >= RESOURCE.cap) {
        const oldest = this.resources.getFirstAlive();
        if (oldest) oldest.destroy(); // recycle, never accumulate
      }
      const px = x + (Math.random() - 0.5) * 60;
      const py = y + (Math.random() - 0.5) * 60;
      const spot = this.worldApi.nearestWalkable(px, py, 14) ||
        this.worldApi.nearestWalkable(x, y, 14);
      if (!spot) continue; // no free floor nearby — skip rather than embed in a wall
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

  updatePickups() {
    const r2 = RESOURCE.pickupRadius * RESOURCE.pickupRadius;
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
        // Biomass doubles as XP: surplus past a threshold is kept.
        const gained = this.run.addXp(1);
        if (gained > 0) {
          this.pendingLevels += gained;
          this.pushHud();
          if (!this.modalOpen) this.openDraft();
        }
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
    if (hpChanged || this.kills !== this.lastHudKills || this.motes !== this.lastHudMotes) {
      this.lastHudHp = this.hp;
      this.lastHudKills = this.kills;
      this.lastHudMotes = this.motes;
      ui.update(this.hp, hs.maxHealth, this.kills, this.motes);
    }
    if (this.run.level !== this.lastHudLevel || this.run.xp !== this.lastHudXp) {
      this.lastHudLevel = this.run.level;
      this.lastHudXp = this.run.xp;
      ui.setLevel(this.run.level, this.run.xp, this.run.requiredXp());
    }
    ui.setColonyCount(this.run.cells.length, this.run.maxCells);
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
    if (card.kind === 'mutation' && target && target.scope === 'hero' && card.mutation === 'membrane') {
      this.hp += MUTATIONS.membrane.healthBonus; // grow into the new tissue
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
    } else {
      panels.hideDraft();
      this.modalOpen = false;
      if (!this.isGameOver) this.scene.resume();
      this.pushHud();
    }
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
  applyHeroHit(dmg, fromX, fromY) {
    if (this.isGameOver || !this.player || !this.player.active) return;
    const now = this.time.now;
    if (now < this.invulnUntil) return; // i-frames
    this.invulnUntil = now + PLAYER.invulnMs;

    this.hp -= dmg;
    this.hitSparks.explode(8, this.player.x, this.player.y);
    this.cameras.main.shake(90, 0.003);

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
    const room = typeof roomId === 'number' ? this.layout.rooms[roomId] : null;
    this.checkRoomCleared(room);
    this.pushHud();
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
