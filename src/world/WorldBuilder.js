/**
 * WorldBuilder: turns a pure generator layout into a living scene.
 * - Draws void / floors / walls / organic decor with Phaser Graphics.
 * - Creates invisible static Arcade bodies for every solid rect
 *   (room walls, tunnel walls, interior wall-block obstacles).
 * - Exposes spatial queries used by gameplay code and tests:
 *   roomAt(x, y), isWalkable(x, y, pad), nearestWalkable(x, y).
 */

import { mulberry32, range, int } from './rng.js';
import { pointInRect } from './generator.js';
import {
  genRoomShape, shapeSeed, chaikinClosed, pointInPoly, polyMetrics, constrainPoint
} from './organic.js';

// ------------------------------------------------------------ organic tissue
// Контуры комнат — из общего модуля organic.js (тот же полигон видят
// генератор, рендер, коллизия и сетка). Здесь только рисование.
// Детерминировано от (seed, room.id): перерисовки крыла дают тот же контур.

function fillPoly(g, pts) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.fillPath();
}

function strokePoly(g, pts) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
  g.strokePath();
}

function ensureShape(layout, room) {
  if (!room.shape) room.shape = genRoomShape(room, layout.seed);
  return room.shape;
}

/** Мясистый нарост поверх препятствия-блока (визуал шире коллайдера на ~8px). */
function genLumpPoly(rect, rng) {
  const m = 8;
  const x0 = rect.x - m, y0 = rect.y - m;
  const x1 = rect.x + rect.w + m, y1 = rect.y + rect.h + m;
  const cr = Math.min(30, Math.min(rect.w, rect.h) * 0.28) + rng() * 6;
  const pts = [];
  const per = 5;
  for (let i = 0; i <= per; i++) {
    const t = i / per;
    pts.push({ x: x0 + cr + t * (x1 - x0 - cr * 2), y: y0 + (rng() - 0.5) * 10 });
  }
  for (let i = 0; i <= per; i++) {
    const t = i / per;
    pts.push({ x: x1 + (rng() - 0.5) * 10, y: y0 + cr + t * (y1 - y0 - cr * 2) });
  }
  for (let i = 0; i <= per; i++) {
    const t = i / per;
    pts.push({ x: x1 - cr - t * (x1 - x0 - cr * 2), y: y1 + (rng() - 0.5) * 10 });
  }
  for (let i = 0; i <= per; i++) {
    const t = i / per;
    pts.push({ x: x0 + (rng() - 0.5) * 10, y: y1 - cr - t * (y1 - y0 - cr * 2) });
  }
  return chaikinClosed(pts, 1);
}

export class WorldBuilder {
  constructor(scene, layout, palette) {
    this.scene = scene;
    this.layout = layout;
    this.pal = palette;
    this.bodies = [];
    this.pulsers = [];
    this.floorGfx = [];
    this.wallGfx = null;
    this.voidRect = null;
  }

  build() {
    const { bounds } = this.layout;
    this.buildVoid(bounds);
    this.buildFloors(this.layout.rooms, this.layout.corridors.flatMap((c) => c.rects), 0x51f3);
    this.buildWalls();
    this.buildBodies();
    this.buildDecor(this.layout.rooms, 0xa53c);
    return {
      builder: this,
      bodies: this.bodies,
      bounds,
      start: { x: this.layout.rooms[0].cx, y: this.layout.rooms[0].cy },
      roomAt: (x, y) => this.roomAt(x, y),
      isWalkable: (x, y, pad) => this.isWalkable(x, y, pad),
      nearestWalkable: (x, y, pad) => this.nearestWalkable(x, y, pad)
    };
  }

  /**
   * Integrate an expansion wing: draw new floors, refresh void + all walls
   * (an existing room gains a door), rebuild static bodies in place so live
   * colliders keep working. Synchronous; call only when nothing is mid-flight
   * through the changed walls (e.g. right after a full clear).
   */
  addExpansion(newRooms, newCorridors, wingSalt) {
    this.buildFloors(newRooms, newCorridors.flatMap((c) => c.rects), wingSalt);
    this.buildVoid(this.layout.bounds);
    this.buildWalls();
    // Destroy old static rects, then recreate from the current solids list.
    // The bodies ARRAY object is mutated in place (length=0 + push) so the
    // colliders registered on it keep colliding without re-registration.
    for (const b of this.bodies) b.destroy();
    this.bodies.length = 0;
    this.refreshCollidables();
    this.buildBodies();
    this.buildDecor(newRooms, wingSalt);
  }

  buildVoid(bounds) {
    if (this.voidRect) this.voidRect.destroy();
    this.voidRect = this.scene.add
      .rectangle(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2, bounds.w, bounds.h, this.pal.void)
      .setDepth(-12);
  }

  buildFloors(rooms, corrRects, salt) {
    const g = this.scene.add.graphics().setDepth(-10);
    this.floorGfx.push(g);
    const organic = this.layout.withTunnels === false;
    const rng = mulberry32((this.layout.seed ^ salt) >>> 0);
    for (const r of rooms) {
      if (organic) {
        // Органический пол: неправильный округлый контур внутри rect.
        const { floor } = ensureShape(this.layout, r);
        const tone = r.id % 2 === 0 ? this.pal.floorA : this.pal.floorB;
        g.fillStyle(tone, 1);
        fillPoly(g, floor);
        // Тонкие прожилки поперёк пола (концы за краем накроет стена).
        const frng = mulberry32(shapeSeed(this.layout.seed, r.id) ^ 0xbeef);
        const veins = int(frng, 2, 4);
        g.lineStyle(1.5, this.pal.vein, 0.3);
        for (let i = 0; i < veins; i++) {
          let px = range(frng, r.x + 40, r.x + r.w - 40);
          let py = range(frng, r.y + 40, r.y + r.h - 40);
          g.beginPath();
          g.moveTo(px, py);
          const segs = int(frng, 3, 5);
          for (let s = 0; s < segs; s++) {
            px += range(frng, -90, 90);
            py += range(frng, -90, 90);
            px = Math.max(r.x + 14, Math.min(r.x + r.w - 14, px));
            py = Math.max(r.y + 14, Math.min(r.y + r.h - 14, py));
            g.lineTo(px, py);
          }
          g.strokePath();
        }
        // Редкая тёмная пятнистость — только внутри контура.
        g.fillStyle(this.pal.mottle, 0.5);
        const dots = Math.floor((r.w * r.h) / 90000);
        for (let i = 0; i < dots; i++) {
          const dx = range(frng, r.x + 24, r.x + r.w - 24);
          const dy = range(frng, r.y + 24, r.y + r.h - 24);
          if (!pointInPoly(dx, dy, floor)) continue;
          g.fillCircle(dx, dy, range(frng, 3, 10));
        }
        continue;
      }
      const tone = r.id % 2 === 0 ? this.pal.floorA : this.pal.floorB;
      g.fillStyle(tone, 1);
      g.fillRect(r.x, r.y, r.w, r.h);
      // Faint inner rim so the floor reads against the void.
      g.lineStyle(2, this.pal.floorRim, 0.5);
      g.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
      // Thin organic veins across the floor (a few per room, never dense).
      const veins = int(rng, 2, 4);
      g.lineStyle(1.5, this.pal.vein, 0.3);
      for (let i = 0; i < veins; i++) {
        let px = range(rng, r.x + 30, r.x + r.w - 30);
        let py = range(rng, r.y + 30, r.y + r.h - 30);
        g.beginPath();
        g.moveTo(px, py);
        const segs = int(rng, 3, 5);
        for (let s = 0; s < segs; s++) {
          px += range(rng, -90, 90);
          py += range(rng, -90, 90);
          px = Math.max(r.x + 12, Math.min(r.x + r.w - 12, px));
          py = Math.max(r.y + 12, Math.min(r.y + r.h - 12, py));
          g.lineTo(px, py);
        }
        g.strokePath();
      }
      // Sparse darker mottling.
      g.fillStyle(this.pal.mottle, 0.5);
      const dots = Math.floor((r.w * r.h) / 90000);
      for (let i = 0; i < dots; i++) {
        g.fillCircle(range(rng, r.x + 20, r.x + r.w - 20), range(rng, r.y + 20, r.y + r.h - 20), range(rng, 3, 10));
      }
    }
    // Tunnel floors: slightly different tone + dim center line.
    for (const t of corrRects) {
      g.fillStyle(this.pal.tunnel, 1);
      g.fillRect(t.x, t.y, t.w, t.h);
    }
  }

  buildWalls() {
    if (this.wallGfx) this.wallGfx.destroy();
    const g = this.scene.add.graphics().setDepth(-8);
    this.wallGfx = g;
    const organic = this.layout.withTunnels === false;
    if (organic) {
      // Слоистая плоть вокруг каждой комнаты: тёмная масса → средняя плоть →
      // внутренняя кайма → тонкая кромка. Плюс доли-блики и впадины.
      for (const r of this.layout.rooms) {
        const { floor, outer } = ensureShape(this.layout, r);
        // 1. Наружная тёмная масса (уходит в пустоту крупными долями).
        g.fillStyle(this.pal.wall, 1);
        fillPoly(g, outer);
        g.lineStyle(3, 0x000000, 0.3);
        strokePoly(g, outer);
        // 2. Средняя плоть — широкая полоса вокруг пола.
        g.lineStyle(40, this.pal.wallMid ?? this.pal.wall, 1);
        strokePoly(g, floor);
        // 3. Внутренняя кайма вдоль проходимого пола.
        g.lineStyle(22, this.pal.wallInner ?? this.pal.floorRim, 1);
        strokePoly(g, floor);
        // 4. Тонкая читаемая кромка (без толстой чёрной обводки).
        g.lineStyle(3, this.pal.wallEdge, 0.6);
        strokePoly(g, floor);
        // 5. Доли: светлые выпуклости вдоль каймы + тёмные впадины между ними.
        const drng = mulberry32((shapeSeed(this.layout.seed, r.id) ^ 0xf017) >>> 0);
        const lobes = 6 + Math.floor(drng() * 4);
        for (let i = 0; i < lobes; i++) {
          const p = floor[Math.floor((i / lobes) * floor.length) % floor.length];
          const jx = (drng() - 0.5) * 24;
          const jy = (drng() - 0.5) * 24;
          g.fillStyle(this.pal.wallHighlight ?? this.pal.vein, 0.13);
          g.fillCircle(p.x + jx, p.y + jy, 18 + drng() * 18);
        }
        const crev = 4 + Math.floor(drng() * 3);
        for (let i = 0; i < crev; i++) {
          const p = floor[Math.floor(((i + 0.5) / crev) * floor.length) % floor.length];
          g.fillStyle(this.pal.wallCrevice ?? 0x000000, 0.5);
          g.fillCircle(p.x, p.y, 9 + drng() * 9);
        }
        // 6. Складки и прожилки возле стен: короткие линии внутрь пола.
        g.lineStyle(1.5, this.pal.vein, 0.4);
        const folds = 2 + Math.floor(drng() * 3);
        for (let i = 0; i < folds; i++) {
          let px = range(drng, r.x + 70, r.x + r.w - 70);
          let py = range(drng, r.y + 70, r.y + r.h - 70);
          if (!pointInPoly(px, py, floor)) continue;
          g.beginPath();
          g.moveTo(px, py);
          for (let s = 0; s < 3; s++) {
            px += range(drng, -60, 60);
            py += range(drng, -60, 60);
            if (!pointInPoly(px, py, floor)) break;
            g.lineTo(px, py);
          }
          g.strokePath();
        }
      }
      // Наросты-препятствия — округлые мясистые бугры (визуал шире тела).
      const obstacles = this.layout.rooms.flatMap((r) => r.obstacles);
      const brng = mulberry32(((this.layout.seed ^ 0xb10c) >>> 0) || 1);
      for (const s of obstacles) {
        const lump = genLumpPoly(s, brng);
        g.fillStyle(this.pal.wallMid ?? this.pal.wall, 1);
        fillPoly(g, lump);
        g.lineStyle(6, this.pal.wallInner ?? this.pal.floorRim, 1);
        strokePoly(g, lump);
        g.lineStyle(2, this.pal.wallEdge, 0.5);
        strokePoly(g, lump);
        g.lineStyle(1.5, this.pal.vein, 0.5);
        g.lineBetween(s.x + 6, s.y + s.h * 0.35, s.x + s.w - 6, s.y + s.h * 0.6);
        g.lineBetween(s.x + s.w * 0.3, s.y + 6, s.x + s.w * 0.55, s.y + s.h - 6);
      }
      return;
    }
    // Every solid shares the same dense tissue-wall look: room perimeters,
    // tunnel sides and interior blocks are visually identical.
    const obstacles = new Set(this.layout.rooms.flatMap((r) => r.obstacles));
    for (const s of this.layout.solids) {
      g.fillStyle(this.pal.wall, 1);
      g.fillRect(s.x, s.y, s.w, s.h);
      // Crisp crimson edge so walls read instantly against floors.
      g.lineStyle(2, this.pal.wallEdge, 0.85);
      g.strokeRect(s.x + 1, s.y + 1, Math.max(1, s.w - 2), Math.max(1, s.h - 2));
      // Dark outer shade for density.
      g.lineStyle(4, 0x000000, 0.35);
      g.strokeRect(s.x - 2, s.y - 2, s.w + 4, s.h + 4);
      if (obstacles.has(s)) {
        // A couple of vein strokes across interior blocks for an organic feel.
        g.lineStyle(1.5, this.pal.vein, 0.5);
        g.lineBetween(s.x + 6, s.y + s.h * 0.35, s.x + s.w - 6, s.y + s.h * 0.6);
        g.lineBetween(s.x + s.w * 0.3, s.y + 6, s.x + s.w * 0.55, s.y + s.h - 6);
      }
    }
  }

  buildBodies() {
    // Портальный режим: комнаты герметичны, их держит полигон-контейнмент
    // (тот же контур, что рисуется), поэтому твёрдые тела нужны только
    // наростам-препятствиям. Тоннельный legacy — все стены как раньше.
    const solids = this.collidableSolids();
    for (const s of solids) {
      const rect = this.scene.add.rectangle(s.x + s.w / 2, s.y + s.h / 2, s.w, s.h);
      rect.setVisible(false);
      this.scene.physics.add.existing(rect, true); // static body, sized to rect
      this.bodies.push(rect);
    }
  }

  /** Твёрдые тела, реально участвующие в коллизиях (портал: только наросты). */
  collidableSolids() {
    if (this.layout.withTunnels === false) {
      if (!this._obstacleList) {
        this._obstacleList = this.layout.rooms.flatMap((r) => r.obstacles);
      }
      return this._obstacleList;
    }
    return this.layout.solids;
  }

  /** Сбросить кеш препятствий (после достройки крыла). */
  refreshCollidables() {
    this._obstacleList = null;
  }

  buildDecor(rooms, salt) {
    // Barely-visible pulsating tissue nodes on room floors (bounded, cheap).
    if (this.pulsers.length >= 24) return;
    const organic = this.layout.withTunnels === false;
    const rng = mulberry32(((this.layout.seed ^ salt) >>> 0) || 1);
    const n = Math.min(12, rooms.length);
    for (let i = 0; i < n; i++) {
      const r = rooms[Math.floor(rng() * rooms.length)];
      const x = range(rng, r.x + 80, r.x + r.w - 80);
      const y = range(rng, r.y + 80, r.y + r.h - 80);
      if (r.obstacles.some((b) => pointInRect(x, y, b, 40))) continue;
      // В органике узел обязан лежать внутри видимого пола, иначе его
      // наполовину накроет кайма стены.
      if (organic && r.shape && !pointInPoly(x, y, r.shape.floor)) continue;
      const node = this.scene.add.circle(x, y, range(rng, 6, 12), this.pal.vein, 0.35).setDepth(-9);
      this.pulsers.push(node);
      this.scene.tweens.add({
        targets: node,
        alpha: 0.12,
        scale: 1.25,
        duration: int(rng, 900, 1600),
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      });
    }
  }

  roomAt(x, y) {
    for (const r of this.layout.rooms) {
      if (pointInRect(x, y, r, 0)) return r;
    }
    return null;
  }

  floorAt(x, y) {
    if (this.layout.withTunnels === false) return this.roomContainingPoly(x, y, 0);
    for (const f of this.layout.floors) {
      if (pointInRect(x, y, f, 0)) return f;
    }
    return null;
  }

  /** Комната, чей рисуемый полигон содержит точку с зазором pad от края. */
  roomContainingPoly(x, y, pad = 0) {
    for (const r of this.layout.rooms) {
      const sh = r.shape || (r.shape = genRoomShape(r, this.layout.seed));
      const m = polyMetrics(sh.floor, x, y);
      if (m.inside && m.minDist >= pad) return r;
    }
    return null;
  }

  /** Внутри ли хоть одного рисуемого пола (снаряды гаснут снаружи ткани). */
  isInsideAnyRoom(x, y, pad = 0) {
    return this.roomContainingPoly(x, y, pad) !== null;
  }

  isWalkable(x, y, pad = 0) {
    if (this.layout.withTunnels === false) {
      // Тот же полигон, что нарисован: внутри + зазор от каймы + мимо наростов.
      if (!this.roomContainingPoly(x, y, pad)) return false;
      for (const s of this.collidableSolids()) {
        if (pointInRect(x, y, s, pad)) return false;
      }
      return true;
    }
    if (!this.floorAt(x, y)) return false;
    for (const s of this.layout.solids) {
      if (pointInRect(x, y, s, pad)) return false;
    }
    return true;
  }

  /** Spiral search for a nearby walkable point (drops, nudges). Bounded. */
  nearestWalkable(x, y, pad = 14) {
    if (this.isWalkable(x, y, pad)) return { x, y };
    for (let ring = 1; ring <= 12; ring++) {
      const step = ring * 22;
      const candidates = [
        [x + step, y], [x - step, y], [x, y + step], [x, y - step],
        [x + step, y + step], [x - step, y - step], [x + step, y - step], [x - step, y + step]
      ];
      const ok = candidates.find(([cx, cy]) => this.isWalkable(cx, cy, pad));
      if (ok) return { x: ok[0], y: ok[1] };
    }
    return null;
  }

  /**
   * Вдавить точку внутрь рисуемого полигона комнаты с зазором radius.
   * Граница та же, что видит игрок. Идёт к центру (комнаты звёздчатые —
   * луч внутрь попадает всегда), центр — гарантированный фолбэк.
   */
  constrainToRoom(room, x, y, radius) {
    if (!room) return { x, y };
    const sh = room.shape || (room.shape = genRoomShape(room, this.layout.seed));
    return constrainPoint(sh.floor, room.cx, room.cy, x, y, radius);
  }

  destroy() {
    for (const b of this.bodies) b.destroy();
    this.bodies.length = 0;
    for (const p of this.pulsers) this.scene.tweens.killTweensOf(p);
    this.pulsers = [];
    for (const g of this.floorGfx) g.destroy();
    this.floorGfx = [];
    if (this.wallGfx) this.wallGfx.destroy();
    this.wallGfx = null;
    if (this.voidRect) this.voidRect.destroy();
    this.voidRect = null;
  }
}
