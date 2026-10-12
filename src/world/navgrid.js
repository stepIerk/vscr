/**
 * NavGrid: coarse navigation grid over a dungeon layout + A* pathfinding.
 * Engine-free (no Phaser): build once per map, query from gameplay code.
 *
 * - Cell centers must sit on floor (room/tunnel) and outside solids+pad.
 * - 8-directional A* with corner-cut prevention, octile heuristic, binary heap.
 * - lineOfSight() for greedy path smoothing.
 */

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]
];

class MinHeap {
  constructor() {
    this.k = [];
    this.v = [];
  }
  get size() {
    return this.k.length;
  }
  push(key, val) {
    const k = this.k;
    const v = this.v;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const k = this.k;
    const v = this.v;
    const top = v[0];
    const lk = k.pop();
    const lv = v.pop();
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

function pointInRect(x, y, r, pad = 0) {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

export class NavGrid {
  /**
   * @param {object} layout generator layout (rooms/floors/solids/bounds)
   * @param {number} cell cell size in game coords
   * @param {number} pad clearance around solids in game coords
   */
  constructor(layout, cell = 48, pad = 18) {
    this.cell = cell;
    this.pad = pad;
    const b = layout.bounds;
    this.x0 = b.x;
    this.y0 = b.y;
    this.cols = Math.ceil(b.w / cell);
    this.rows = Math.ceil(b.h / cell);
    const walk = new Uint8Array(this.cols * this.rows);
    const t0 = performance.now();
    for (let r = 0; r < this.rows; r++) {
      const y = b.y + (r + 0.5) * cell;
      for (let c = 0; c < this.cols; c++) {
        const x = b.x + (c + 0.5) * cell;
        let floor = false;
        for (const f of layout.floors) {
          if (pointInRect(x, y, f, 0)) { floor = true; break; }
        }
        if (!floor) continue;
        let blocked = false;
        for (const s of layout.solids) {
          if (pointInRect(x, y, s, pad)) { blocked = true; break; }
        }
        if (!blocked) walk[r * this.cols + c] = 1;
      }
    }
    this.walk = walk;
    this.buildMs = performance.now() - t0;
  }

  get count() {
    return this.cols * this.rows;
  }

  walkableCount() {
    let n = 0;
    for (let i = 0; i < this.walk.length; i++) n += this.walk[i];
    return n;
  }

  inBounds(c, r) {
    return c >= 0 && r >= 0 && c < this.cols && r < this.rows;
  }

  isWalk(c, r) {
    return this.inBounds(c, r) && this.walk[r * this.cols + c] === 1;
  }

  toCell(x, y) {
    return [
      Math.floor((x - this.x0) / this.cell),
      Math.floor((y - this.y0) / this.cell)
    ];
  }

  toWorld(c, r) {
    return [this.x0 + (c + 0.5) * this.cell, this.y0 + (r + 0.5) * this.cell];
  }

  isWalkWorld(x, y) {
    const [c, r] = this.toCell(x, y);
    return this.isWalk(c, r);
  }

  /** Nearest walkable cell (spiral rings), or null. */
  nearestCell(x, y, maxRing = 6) {
    const [c0, r0] = this.toCell(x, y);
    if (this.isWalk(c0, r0)) return [c0, r0];
    for (let ring = 1; ring <= maxRing; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          if (this.isWalk(c0 + dc, r0 + dr)) return [c0 + dc, r0 + dr];
        }
      }
    }
    return null;
  }

  /** Line-of-sight on the grid (for path smoothing). */
  los(x0, y0, x1, y1) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (this.cell * 0.5)));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!this.isWalkWorld(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return false;
    }
    return true;
  }

  /** Greedy smoothing: skip to the furthest visible waypoint. */
  smooth(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.los(pts[i].x, pts[i].y, pts[j].x, pts[j].y)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }

  /**
   * A* from world point to world point. Returns smoothed [{x,y},...]
   * (start excluded, goal included) or null when unreachable.
   */
  findPath(sx, sy, tx, ty, maxExpand = 8000) {
    const s = this.nearestCell(sx, sy);
    const g = this.nearestCell(tx, ty);
    if (!s || !g) return null;
    const [sc, sr] = s;
    const [gc, gr] = g;
    if (sc === gc && sr === gr) return [{ x: tx, y: ty }];
    const W = this.cols;
    const idx = (c, r) => r * W + c;
    const gScore = new Map();
    const came = new Map();
    const closed = new Set();
    const h = (c, r) => {
      const dx = Math.abs(c - gc);
      const dy = Math.abs(r - gr);
      return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
    };
    const heap = new MinHeap();
    gScore.set(idx(sc, sr), 0);
    heap.push(h(sc, sr), [sc, sr]);
    let expand = 0;
    let found = false;
    while (heap.size && expand < maxExpand) {
      const [c, r] = heap.pop();
      const ci = idx(c, r);
      if (closed.has(ci)) continue;
      closed.add(ci);
      expand++;
      if (c === gc && r === gr) {
        found = true;
        break;
      }
      const gc0 = gScore.get(ci);
      for (const [dc, dr, cost] of DIRS) {
        const nc = c + dc;
        const nr = r + dr;
        if (!this.isWalk(nc, nr)) continue;
        if (dc !== 0 && dr !== 0 && (!this.isWalk(c + dc, r) || !this.isWalk(c, r + dr))) continue; // no corner cutting
        const ni = idx(nc, nr);
        if (closed.has(ni)) continue;
        const ng = gc0 + cost;
        if (ng < (gScore.get(ni) ?? Infinity)) {
          gScore.set(ni, ng);
          came.set(ni, ci);
          heap.push(ng + h(nc, nr), [nc, nr]);
        }
      }
    }
    if (!found) return null;
    const cells = [];
    let cur = idx(gc, gr);
    const start = idx(sc, sr);
    while (cur !== start) {
      cells.push(cur);
      cur = came.get(cur);
      if (cur === undefined) return null;
    }
    cells.reverse();
    const pts = cells.map((i) => {
      const [x, y] = this.toWorld(i % W, Math.floor(i / W));
      return { x, y };
    });
    pts.push({ x: tx, y: ty }); // exact goal
    return this.smooth([{ x: sx, y: sy }, ...pts]).slice(1);
  }
}
