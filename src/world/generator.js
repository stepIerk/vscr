/**
 * Procedural dungeon layout generator: rooms + L-shaped tunnels.
 *
 * Pipeline (standard for roguelike dungeons, see genre literature):
 *   1. Scatter non-overlapping room rects (seeded rejection sampling).
 *   2. Build connection graph: Kruskal MST over room centers (= guaranteed
 *      connectivity) + a few short extra edges for loops/shortcuts.
 *   3. Route L-shaped corridors (center-to-center, random elbow order).
 *   4. Cut door gaps in room/corridor walls wherever floors intersect them.
 *   5. Place interior wall-block obstacles (same walls as room perimeter,
 *      per the stage constraints — no separate "organ" obstacles yet).
 *   6. Precompute enemy spawn points near room perimeters.
 *
 * Pure data in / pure data out — no Phaser dependency, fully deterministic
 * for a given seed. Rendering / physics bodies are built by WorldBuilder.
 */

import { mulberry32, range, int, shuffle, clamp } from './rng.js';

export const GEN_DEFAULTS = {
  roomCountMin: 12,
  roomCountMax: 18,
  roomMin: 560,
  roomMax: 1080,
  startRoomMin: 700,
  field: 7200, // scatter area (game coords, not pixels-on-screen)
  roomPad: 260, // min gap between rooms (fits tunnel + walls)
  tunnelWidth: 120, // free passage; comfortably fits player + enemies
  wall: 24, // wall thickness
  gapMargin: 12, // door opening slightly wider than the tunnel
  obstacleWallClear: 110, // obstacles keep this away from room walls/doors
  obstacleGap: 90, // min clearance between obstacles
  centerClear: 150, // keep room center (player entry) free
  spawnInset: 72, // spawn band distance from inner walls
  spawnMinSep: 100, // spawns don't stack on each other
  spawnAreaPer: 70000, // room area funding one spawn point
  spawnMin: 3,
  spawnMax: 9,
  extraEdgeProb: 0.22, // chance to re-add a short non-MST edge (loops)
  extraEdgeMaxDist: 1500
};

// ------------------------------------------------------------------ rect ops

/** Axis-aligned rect {x, y, w, h}. Edges touching counts as NOT overlapping. */
export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function overlapRange(a0, a1, b0, b1) {
  return [Math.max(a0, b0), Math.min(a1, b1)];
}

export function pointInRect(x, y, r, pad = 0) {
  return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
}

function normalizeRect(x0, y0, x1, y1) {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** Subtract 1D intervals `cuts` from [lo, hi]; returns remaining runs. */
function subtractIntervals(lo, hi, cuts) {
  const sorted = cuts
    .map(([a, b]) => [Math.min(a, b), Math.max(a, b)])
    .filter(([a, b]) => b > lo && a < hi)
    .sort((p, q) => p[0] - q[0]);
  const runs = [];
  let cur = lo;
  for (const [a, b] of sorted) {
    if (a > cur) runs.push([cur, Math.min(a, hi)]);
    cur = Math.max(cur, b);
    if (cur >= hi) break;
  }
  if (cur < hi) runs.push([cur, hi]);
  return runs.filter(([a, b]) => b - a >= 4); // drop slivers
}

// ------------------------------------------------------------ union-find

class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
  }
  find(i) {
    while (this.p[i] !== i) {
      this.p[i] = this.p[this.p[i]];
      i = this.p[i];
    }
    return i;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    this.p[ra] = rb;
    return true;
  }
}

// -------------------------------------------------------------- generation

export function generateLayout(seed, opts = {}) {
  const o = { ...GEN_DEFAULTS, ...opts };
  const rng = mulberry32(seed);
  const T = o.wall;

  // --- 1. rooms ---
  const targetCount = int(rng, o.roomCountMin, o.roomCountMax);
  const rooms = [];
  const startW = range(rng, o.startRoomMin, o.roomMax);
  const startH = range(rng, o.startRoomMin, o.roomMax);
  rooms.push({
    id: 0,
    x: o.field / 2 - startW / 2,
    y: o.field / 2 - startH / 2,
    w: startW,
    h: startH,
    isStart: true
  });

  let guard = 0;
  while (rooms.length < targetCount && guard < 4000) {
    guard++;
    const w = range(rng, o.roomMin, o.roomMax);
    const h = range(rng, o.roomMin, o.roomMax);
    const x = range(rng, 0, o.field - w);
    const y = range(rng, 0, o.field - h);
    const cand = { x, y, w, h };
    const ok = rooms.every(
      (r) =>
        !rectsOverlap(
          { x: cand.x - o.roomPad, y: cand.y - o.roomPad, w: cand.w + o.roomPad * 2, h: cand.h + o.roomPad * 2 },
          r
        )
    );
    if (ok) rooms.push({ id: rooms.length, x, y, w, h, isStart: false });
  }
  for (const r of rooms) {
    r.cx = r.x + r.w / 2;
    r.cy = r.y + r.h / 2;
  }

  // --- 2. connection graph: Kruskal MST + short loop edges ---
  const edges = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const dx = rooms[i].cx - rooms[j].cx;
      const dy = rooms[i].cy - rooms[j].cy;
      edges.push({ a: i, b: j, d: Math.hypot(dx, dy) });
    }
  }
  edges.sort((p, q) => p.d - q.d);
  const uf = new UnionFind(rooms.length);
  const links = [];
  const used = new Set();
  for (const e of edges) {
    if (uf.union(e.a, e.b)) {
      links.push(e);
      used.add(e.a + ':' + e.b);
    }
  }
  // Extra edges for loops: short, non-MST, seeded chance.
  const extra = shuffle(
    rng,
    edges.filter((e) => !used.has(e.a + ':' + e.b) && e.d <= o.extraEdgeMaxDist)
  );
  for (const e of extra) {
    if (links.length >= rooms.length - 1 + Math.ceil(rooms.length / 3)) break;
    if (rng() < o.extraEdgeProb) links.push(e);
  }

  // --- 3. L-shaped corridors (center to center, random elbow) ---
  const HW = o.tunnelWidth / 2;
  const MIN_SEG = 8; // elbow nearly on a room center: drop the stub, go straight
  const corridors = links.map(({ a, b }) => {
    const A = rooms[a];
    const B = rooms[b];
    const elbow = rng() < 0.5 ? { x: B.cx, y: A.cy } : { x: A.cx, y: B.cy };
    const rects = [];
    const s1 = normalizeRect(A.cx, A.cy, elbow.x, elbow.y);
    const s2 = normalizeRect(elbow.x, elbow.y, B.cx, B.cy);
    const segs = [
      [s1, Math.hypot(elbow.x - A.cx, elbow.y - A.cy)],
      [s2, Math.hypot(B.cx - elbow.x, B.cy - elbow.y)]
    ];
    for (const [s, len] of segs) {
      if (len < MIN_SEG) continue;
      // Inflate the travel axis to tunnel width.
      const r =
        s.w >= s.h
          ? { x: s.x, y: s.y - HW, w: Math.max(s.w, 1), h: Math.max(s.h, HW * 2) }
          : { x: s.x - HW, y: s.y, w: Math.max(s.w, HW * 2), h: Math.max(s.h, 1) };
      rects.push(r);
    }
    if (!rects.length) {
      // Paranoid fallback: direct bar between centers along the dominant axis.
      const dx = B.cx - A.cx;
      const dy = B.cy - A.cy;
      rects.push(
        Math.abs(dx) >= Math.abs(dy)
          ? { x: Math.min(A.cx, B.cx), y: A.cy - HW, w: Math.abs(dx), h: HW * 2 }
          : { x: A.cx - HW, y: Math.min(A.cy, B.cy), w: HW * 2, h: Math.abs(dy) }
      );
    }
    // Elbow filler: without it the outer corner of the turn misses both floor
    // and wall (a hole into the void you can walk through). A 2HW square
    // centered on the joint closes the turn; wall bands wrap its outer sides.
    const straight = rects.length < 2;
    const joint = straight ? null : { ...elbow };
    if (joint) rects.push({ x: joint.x - HW, y: joint.y - HW, w: HW * 2, h: HW * 2, filler: true });
    return { a, b, joint, rects };
  });
  const corridorRects = corridors.flatMap((c) => c.rects);

  // --- 4. room walls with door gaps ---
  for (const r of rooms) {
    // gaps per side as intervals along the wall axis
    const gaps = { N: [], S: [], W: [], E: [] };
    for (const c of corridorRects) {
      if (!rectsOverlap(c, r)) continue;
      const [ox0, ox1] = overlapRange(c.x, c.x + c.w, r.x, r.x + r.w);
      const [oy0, oy1] = overlapRange(c.y, c.y + c.h, r.y, r.y + r.h);
      if (ox1 - ox0 <= 0 || oy1 - oy0 <= 0) continue;
      const m = o.gapMargin;
      if (c.y < r.y) gaps.N.push([ox0 - m, ox1 + m]); // corridor comes from north
      if (c.y + c.h > r.y + r.h) gaps.S.push([ox0 - m, ox1 + m]);
      if (c.x < r.x) gaps.W.push([oy0 - m, oy1 + m]);
      if (c.x + c.w > r.x + r.w) gaps.E.push([oy0 - m, oy1 + m]);
    }
    r.gaps = gaps;
    r.doors = [];
    const runs = [];
    // North / South walls span the full outer width (corners included).
    for (const [lo, hi] of subtractIntervals(r.x - T, r.x + r.w + T, gaps.N))
      runs.push({ x: lo, y: r.y - T, w: hi - lo, h: T });
    for (const [lo, hi] of subtractIntervals(r.x - T, r.x + r.w + T, gaps.S))
      runs.push({ x: lo, y: r.y + r.h, w: hi - lo, h: T });
    // West / East walls span interior height only (corners owned by N/S).
    for (const [lo, hi] of subtractIntervals(r.y, r.y + r.h, gaps.W))
      runs.push({ x: r.x - T, y: lo, w: T, h: hi - lo });
    for (const [lo, hi] of subtractIntervals(r.y, r.y + r.h, gaps.E))
      runs.push({ x: r.x + r.w, y: lo, w: T, h: hi - lo });
    r.wallRuns = runs;
    // Record door centers (for validation + tests).
    const pushDoors = (list, side, fixed) =>
      list.forEach(([a, b]) => {
        const mid = (clamp(a, -1e9, 1e9) + clamp(b, -1e9, 1e9)) / 2;
        r.doors.push({ side, at: mid, fixed });
      });
    pushDoors(gaps.N, 'N', r.y);
    pushDoors(gaps.S, 'S', r.y + r.h);
    pushDoors(gaps.W, 'W', r.x);
    pushDoors(gaps.E, 'E', r.x + r.w);
  }

  // --- corridor side walls (gaps where rooms / other corridors cross) ---
  const gapM = o.gapMargin;
  // Bands overshoot each segment end by HW + T so L-elbows get a fully
  // closed outer corner (the diagonal notch included). Overshoot inside rooms
  // is swallowed by the room-overlap cuts below — never a floating stub.
  const EXT = HW + T;
  const corridorWalls = [];
  corridorRects.forEach((c, ci) => {
    const horizontal = c.w >= c.h;
    const bands = horizontal
      ? [
          { side: 'N', x: c.x - EXT, y: c.y - T, w: c.w + EXT * 2, h: T, axis: 'x' },
          { side: 'S', x: c.x - EXT, y: c.y + c.h, w: c.w + EXT * 2, h: T, axis: 'x' }
        ]
      : [
          { side: 'W', x: c.x - T, y: c.y - EXT, w: T, h: c.h + EXT * 2, axis: 'y' },
          { side: 'E', x: c.x + c.w, y: c.y - EXT, w: T, h: c.h + EXT * 2, axis: 'y' }
        ];
    for (const band of bands) {
      const cuts = [];
      for (const r of rooms) {
        if (!rectsOverlap(band, r)) continue; // room floor swallows this wall stretch
        cuts.push({
          range: band.axis === 'x' ? [Math.max(band.x, r.x), Math.min(band.x + band.w, r.x + r.w)] : [Math.max(band.y, r.y), Math.min(band.y + band.h, r.y + r.h)],
          margin: gapM // door mouths stay comfortably wider than the tunnel
        });
      }
      corridorRects.forEach((other, oi) => {
        if (oi === ci || !rectsOverlap(band, other)) return; // crossing tunnel
        cuts.push({
          range: band.axis === 'x' ? [other.x, other.x + other.w] : [other.y, other.y + other.h],
          margin: 2 // junctions cut flush: no visible notch, passage stays ~120px
        });
      });
      const lo = band.axis === 'x' ? band.x : band.y;
      const hi = band.axis === 'x' ? band.x + band.w : band.y + band.h;
      for (const [a, b] of subtractIntervals(lo, hi, cuts.map(({ range: [p, q], margin }) => [p - margin, q + margin]))) {
        corridorWalls.push(
          band.axis === 'x' ? { x: a, y: band.y, w: b - a, h: T } : { x: band.x, y: a, w: T, h: b - a }
        );
      }
    }
  });

  // --- 5. interior wall-block obstacles (same walls as the perimeter) ---
  for (const r of rooms) {
    r.obstacles = placeObstacles(rng, r, o);
  }

  // --- 6. enemy spawn points near the inner perimeter ---
  for (const r of rooms) {
    r.spawns = r.isStart ? [] : placeSpawns(rng, r, o);
  }

  const floors = [
    ...rooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, roomId: r.id })),
    ...corridorRects.map((c) => ({ ...c, roomId: -1 }))
  ];
  const solids = [...rooms.flatMap((r) => r.wallRuns), ...corridorWalls, ...rooms.flatMap((r) => r.obstacles)];

  // --- bounds ---
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const f of [...floors, ...solids]) {
    x0 = Math.min(x0, f.x);
    y0 = Math.min(y0, f.y);
    x1 = Math.max(x1, f.x + f.w);
    y1 = Math.max(y1, f.y + f.h);
  }
  const M = 220;
  const bounds = { x: x0 - M, y: y0 - M, w: x1 - x0 + M * 2, h: y1 - y0 + M * 2 };

  const layout = { seed, rooms, links, corridors, floors, solids, bounds, wall: T };
  layout.issues = validateLayout(layout);
  return layout;
}

// ------------------------------------------------------- interior obstacles

function placeObstacles(rng, r, o) {
  const roll = rng();
  // Density class: ~30% almost empty, ~45% a few small blocks, ~25% larger cluster.
  const budget = roll < 0.3 ? 0 : roll < 0.75 ? int(rng, 1, 2) : int(rng, 2, 4);
  if (budget === 0) return [];
  const blocks = [];
  for (let attempt = 0; attempt < 40 && blocks.length < budget; attempt++) {
    const maxW = Math.min(240, r.w * 0.38);
    const maxH = Math.min(240, r.h * 0.38);
    const w = range(rng, 70, Math.max(80, maxW));
    const h = range(rng, 70, Math.max(80, maxH));
    const inset = o.obstacleWallClear;
    if (r.w < inset * 2 + w || r.h < inset * 2 + h) continue;
    const x = range(rng, r.x + inset, r.x + r.w - inset - w);
    const y = range(rng, r.y + inset, r.y + r.h - inset - h);
    const cand = { x, y, w, h };
    // Keep the room center free (player entry / maneuvering space).
    if (Math.hypot(x + w / 2 - r.cx, y + h / 2 - r.cy) < o.centerClear) continue;
    if (blocks.some((b) => rectsOverlap(expand(cand, o.obstacleGap), b))) continue;
    blocks.push(cand);
    // Validate: center must still reach every door; otherwise drop the block.
    if (!roomPathsOpen(r, blocks)) blocks.pop();
  }
  return blocks;
}

function expand(r, m) {
  return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
}

/** Coarse-grid BFS inside one room: center reaches all door mouths. */
function roomPathsOpen(room, blocks) {
  const CELL = 44;
  const cols = Math.max(2, Math.floor(room.w / CELL));
  const rows = Math.max(2, Math.floor(room.h / CELL));
  const blocked = (col, row) => {
    const cx = room.x + ((col + 0.5) / cols) * room.w;
    const cy = room.y + ((row + 0.5) / rows) * room.h;
    return blocks.some((b) => pointInRect(cx, cy, expand(b, 26)));
  };
  const targets = room.doors.map((d) => {
    let px, py;
    if (d.side === 'N') [px, py] = [clamp(d.at, room.x + 20, room.x + room.w - 20), room.y + 30];
    else if (d.side === 'S') [px, py] = [clamp(d.at, room.x + 20, room.x + room.w - 20), room.y + room.h - 30];
    else if (d.side === 'W') [px, py] = [room.x + 30, clamp(d.at, room.y + 20, room.y + room.h - 20)];
    else [px, py] = [room.x + room.w - 30, clamp(d.at, room.y + 20, room.y + room.h - 20)];
    return [
      clamp(Math.floor(((px - room.x) / room.w) * cols), 0, cols - 1),
      clamp(Math.floor(((py - room.y) / room.h) * rows), 0, rows - 1)
    ];
  });
  const start = [Math.floor(cols / 2), Math.floor(rows / 2)];
  const seen = new Set([start.join(',')]);
  const queue = [start];
  while (queue.length) {
    const [cx, cy] = queue.pop();
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]) {
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const k = nx + ',' + ny;
      if (seen.has(k) || blocked(nx, ny)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return targets.every(([tx, ty]) => seen.has(tx + ',' + ty));
}

// ------------------------------------------------------------ spawn points

function placeSpawns(rng, r, o) {
  const count = clamp(Math.round((r.w * r.h) / o.spawnAreaPer), o.spawnMin, o.spawnMax);
  const pts = [];
  const sides = shuffle(rng, ['N', 'S', 'W', 'E']);
  for (let i = 0; i < count * 12 && pts.length < count; i++) {
    const side = sides[i % sides.length]; // spread across different walls
    const t = range(rng, 0.12, 0.88);
    const off = o.spawnInset + range(rng, -14, 26);
    let x, y;
    if (side === 'N') [x, y] = [r.x + r.w * t, r.y + off];
    else if (side === 'S') [x, y] = [r.x + r.w * t, r.y + r.h - off];
    else if (side === 'W') [x, y] = [r.x + off, r.y + r.h * t];
    else [x, y] = [r.x + r.w - off, r.y + r.h * t];
    if (r.obstacles.some((b) => pointInRect(x, y, expand(b, 30)))) continue;
    if (pts.some((p) => Math.hypot(p.x - x, p.y - y) < o.spawnMinSep)) continue;
    pts.push({ x, y });
  }
  return pts;
}

// --------------------------------------------------------------- validation

/** Graph + geometry sanity checks. Returns a list of issue strings (empty = ok). */
export function validateLayout(layout) {
  const issues = [];
  // Graph connectivity (BFS from room 0 over links).
  const adj = new Map(layout.rooms.map((r) => [r.id, []]));
  for (const l of layout.links) {
    adj.get(l.a).push(l.b);
    adj.get(l.b).push(l.a);
  }
  const seen = new Set([0]);
  const q = [0];
  while (q.length) {
    const cur = q.pop();
    for (const n of adj.get(cur)) {
      if (!seen.has(n)) {
        seen.add(n);
        q.push(n);
      }
    }
  }
  if (seen.size !== layout.rooms.length) issues.push(`disconnected graph: ${seen.size}/${layout.rooms.length} reachable`);
  // Every room needs at least one door; every corridor must touch a room.
  for (const r of layout.rooms) {
    if (r.doors.length === 0) issues.push(`room ${r.id} has no doors`);
  }
  for (const c of layout.corridors) {
    const touches = c.rects.some((cr) => layout.rooms.some((r) => rectsOverlap(cr, r)));
    if (!touches) issues.push(`corridor ${c.a}-${c.b} touches no room`);
  }
  return issues;
}
