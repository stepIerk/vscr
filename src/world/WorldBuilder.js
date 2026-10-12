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

export class WorldBuilder {
  constructor(scene, layout, palette) {
    this.scene = scene;
    this.layout = layout;
    this.pal = palette;
    this.bodies = [];
    this.pulsers = [];
  }

  build() {
    const { bounds } = this.layout;
    this.buildVoid(bounds);
    this.buildFloors();
    this.buildWalls();
    this.buildBodies();
    this.buildDecor();
    return {
      bodies: this.bodies,
      bounds,
      start: { x: this.layout.rooms[0].cx, y: this.layout.rooms[0].cy },
      roomAt: (x, y) => this.roomAt(x, y),
      isWalkable: (x, y, pad) => this.isWalkable(x, y, pad),
      nearestWalkable: (x, y, pad) => this.nearestWalkable(x, y, pad)
    };
  }

  buildVoid(bounds) {
    this.scene.add
      .rectangle(bounds.x + bounds.w / 2, bounds.y + bounds.h / 2, bounds.w, bounds.h, this.pal.void)
      .setDepth(-12);
  }

  buildFloors() {
    const g = this.scene.add.graphics().setDepth(-10);
    const rng = mulberry32(this.layout.seed ^ 0x51f3);
    // Room floors: two alternating muted dark-red tones for variety.
    for (const r of this.layout.rooms) {
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
    for (const c of this.layout.corridors) {
      for (const t of c.rects) {
        g.fillStyle(this.pal.tunnel, 1);
        g.fillRect(t.x, t.y, t.w, t.h);
      }
    }
  }

  buildWalls() {
    const g = this.scene.add.graphics().setDepth(-8);
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
    for (const s of this.layout.solids) {
      const rect = this.scene.add.rectangle(s.x + s.w / 2, s.y + s.h / 2, s.w, s.h);
      rect.setVisible(false);
      this.scene.physics.add.existing(rect, true); // static body, sized to rect
      this.bodies.push(rect);
    }
  }

  buildDecor() {
    // A few barely-visible pulsating tissue nodes on room floors (bounded, cheap).
    const rng = mulberry32(this.layout.seed ^ 0xa53c);
    const rooms = this.layout.rooms;
    const n = Math.min(12, rooms.length);
    for (let i = 0; i < n; i++) {
      const r = rooms[Math.floor(rng() * rooms.length)];
      const x = range(rng, r.x + 60, r.x + r.w - 60);
      const y = range(rng, r.y + 60, r.y + r.h - 60);
      if (r.obstacles.some((b) => pointInRect(x, y, b, 40))) continue;
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
    for (const f of this.layout.floors) {
      if (pointInRect(x, y, f, 0)) return f;
    }
    return null;
  }

  isWalkable(x, y, pad = 0) {
    if (!this.floorAt(x, y)) return false;
    for (const s of this.layout.solids) {
      if (pointInRect(x, y, s, pad)) return false;
    }
    return true;
  }

  /** Spiral search for a nearby walkable point (drops, nudges). Bounded. */
  nearestWalkable(x, y, pad = 14) {
    if (this.isWalkable(x, y, pad)) return { x, y };
    for (let ring = 1; ring <= 8; ring++) {
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

  destroy() {
    for (const b of this.bodies) b.destroy();
    this.bodies = [];
    for (const p of this.pulsers) this.scene.tweens.killTweensOf(p);
    this.pulsers = [];
  }
}
