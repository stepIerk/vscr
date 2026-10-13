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
import { SHOP, PORTAL } from '../config.js';

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
  wingRooms: 15, // rooms per expansion wing
  extraEdgeProb: 0.22, // chance to re-add a short non-MST edge (loops)
  extraEdgeMaxDist: 1500,
  withTunnels: true, // false — вместо тоннелей врата-порталы между комнатами
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

/**
 * Scatter non-overlapping rects. `sample()` yields {x,y,w,h} candidates;
 * `avoid` lists rects to keep clear of (roomPad around candidates).
 * Pure + deterministic for a given rng stream.
 */
function scatterRooms(rng, count, o, sample, avoid, idStart = 0, guardMax = 4000) {
  const rooms = [];
  let guard = 0;
  while (rooms.length < count && guard < guardMax) {
    guard++;
    const cand = sample();
    const padded = {
      x: cand.x - o.roomPad, y: cand.y - o.roomPad,
      w: cand.w + o.roomPad * 2, h: cand.h + o.roomPad * 2
    };
    const ok =
      avoid.every((r) => !rectsOverlap(padded, r)) &&
      rooms.every((r) => !rectsOverlap(padded, r));
    if (ok) rooms.push({ id: idStart + rooms.length, ...cand, isStart: false });
  }
  for (const r of rooms) {
    r.cx = r.x + r.w / 2;
    r.cy = r.y + r.h / 2;
  }
  return rooms;
}

/** Kruskal MST over room centers + short loop edges. Uses room ids. */
function linkRooms(rng, rooms, o) {
  const edges = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const dx = rooms[i].cx - rooms[j].cx;
      const dy = rooms[i].cy - rooms[j].cy;
      edges.push({ a: rooms[i].id, b: rooms[j].id, d: Math.hypot(dx, dy) });
    }
  }
  edges.sort((p, q) => p.d - q.d);
  const uf = new UnionFind(rooms.length);
  const indexOf = new Map(rooms.map((r, i) => [r.id, i]));
  const links = [];
  const used = new Set();
  for (const e of edges) {
    if (uf.union(indexOf.get(e.a), indexOf.get(e.b))) {
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
  return links;
}

/** L-shaped center-to-center corridors (random elbow order) + joint filler. */
function routeCorridors(rng, roomsById, links, o) {
  const HW = o.tunnelWidth / 2;
  const MIN_SEG = 8; // elbow nearly on a room center: drop the stub, go straight
  return links.map(({ a, b }) => {
    const A = roomsById.get(a);
    const B = roomsById.get(b);
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
}

/** (Re)build one room's perimeter walls with door gaps. Idempotent. */
function buildRoomWalls(room, corridorRects, o) {
  const T = o.wall;
  const r = room;
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

/** Side walls for corridor rects, with gaps at rooms / crossings. */
function buildCorridorWalls(corridorRects, rooms, o) {
  const T = o.wall;
  const HW = o.tunnelWidth / 2;
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
  return corridorWalls;
}

/** Rebuild the flat solids list from current rooms/walls/obstacles. */
export function rebuildSolids(layout) {
  layout.solids = [
    ...layout.rooms.flatMap((r) => r.wallRuns),
    ...(layout.corridorWalls || []),
    ...layout.rooms.flatMap((r) => r.obstacles)
  ];
}

export function computeBounds(floors, solids) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const f of [...floors, ...solids]) {
    x0 = Math.min(x0, f.x);
    y0 = Math.min(y0, f.y);
    x1 = Math.max(x1, f.x + f.w);
    y1 = Math.max(y1, f.y + f.h);
  }
  const M = 220;
  return { x: x0 - M, y: y0 - M, w: x1 - x0 + M * 2, h: y1 - y0 + M * 2 };
}

/** Degree (link count) per room id — gateways, dead-ends, fog adjacency. */
export function roomDegrees(layout) {
  const deg = new Map(layout.rooms.map((r) => [r.id, 0]));
  for (const l of layout.links) {
    deg.set(l.a, (deg.get(l.a) || 0) + 1);
    deg.set(l.b, (deg.get(l.b) || 0) + 1);
  }
  return deg;
}

export function generateLayout(seed, opts = {}) {
  const o = { ...GEN_DEFAULTS, ...opts };
  const rng = mulberry32(seed);

  // --- 1. rooms (start room first, then scattered rest) ---
  const targetCount = int(rng, o.roomCountMin, o.roomCountMax);
  const startW = range(rng, o.startRoomMin, o.roomMax);
  const startH = range(rng, o.startRoomMin, o.roomMax);
  const start = {
    id: 0,
    x: o.field / 2 - startW / 2,
    y: o.field / 2 - startH / 2,
    w: startW,
    h: startH,
    isStart: true
  };
  start.cx = start.x + start.w / 2;
  start.cy = start.y + start.h / 2;
  start.type = 'combat'; // стартовая комната всегда боевая (без спавнов)
  const rooms = [
    start,
    ...scatterRooms(
      rng,
      targetCount - 1,
      o,
      () => {
        const w = range(rng, o.roomMin, o.roomMax);
        const h = range(rng, o.roomMin, o.roomMax);
        return { x: range(rng, 0, o.field - w), y: range(rng, 0, o.field - h), w, h };
      },
      [start],
      1
    )
  ];

  // --- 2. connection graph: Kruskal MST + short loop edges ---
  const links = linkRooms(rng, rooms, o);

  // --- 3. corridors OR portals (режим карты) ---
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const withTunnels = o.withTunnels !== false;
  const corridors = withTunnels ? routeCorridors(rng, byId, links, o) : [];
  const corridorRects = corridors.flatMap((c) => c.rects);

  // --- 4. room walls: with door gaps (tunnels) or sealed (portals) ---
  for (const r of rooms) buildRoomWalls(r, corridorRects, o);

  // --- corridor side walls (gaps where rooms / other corridors cross) ---
  const corridorWalls = withTunnels ? buildCorridorWalls(corridorRects, rooms, o) : [];

  // Врата считаем до препятствий и спавнов: тогда и то и другое обходит их.
  // Отдельный RNG-поток — режим тоннелей остаётся байт-в-байт прежним.
  const portals = withTunnels
    ? []
    : placePortals(mulberry32((seed ^ 0x70da1) >>> 0), rooms, links);
  const portalsByRoom = new Map(rooms.map((r) => [r.id, []]));
  for (const p of portals) portalsByRoom.get(p.roomId).push(p);

  // --- 5. interior wall-block obstacles (same walls as the perimeter) ---
  for (const r of rooms) {
    r.obstacles = placeObstacles(rng, r, o, portalsByRoom.get(r.id) || []);
  }

  // --- 6. enemy spawn points near the inner perimeter (not on the gates) ---
  for (const r of rooms) {
    r.spawns = r.isStart ? [] : placeSpawns(rng, r, o, portalsByRoom.get(r.id) || []);
  }

  // --- 7. room kinds: combat (monsters) vs shop (trader) ---
  assignShopTypes(rng, rooms);

  const floors = [
    ...rooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, roomId: r.id })),
    ...corridorRects.map((c) => ({ ...c, roomId: -1 }))
  ];

  const layout = {
    seed, rooms, links, corridors, floors, solids: [], corridorWalls,
    bounds: null, wall: o.wall, withTunnels, portals
  };
  rebuildSolids(layout);
  layout.bounds = computeBounds(floors, layout.solids);

  layout.issues = validateLayout(layout);
  return layout;
}

/**
 * Расстановка врат-порталов (режим без тоннелей): каждый линк графа
 * даёт ровно пару врат — по одним в каждой из двух комнат.
 * Позиции детерминированы отдельным RNG-потоком (сид карты + соль),
 * чтобы включение порталов не сдвигало остальной RNG.
 * Врата стоят внутри комнаты, подальше от стен, препятствий и друг от друга.
 * `existing` — уже размещённые врата (например, при достройке крыла),
 * чтобы новые не встали впритык к старым.
 */
export function placePortals(rng, rooms, links, existing = []) {
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const portals = [];
  const taken = new Map(); // roomId -> [{x, y}]
  for (const p of existing || []) {
    const got = taken.get(p.roomId) || [];
    got.push({ x: p.x, y: p.y });
    taken.set(p.roomId, got);
  }
  const INSET = PORTAL.inset;
  const MIN_SEP = PORTAL.minSeparation;
  links.forEach((l, linkIdx) => {
    for (const side of [l.a, l.b]) {
      const r = byId.get(side);
      if (!r) continue;
      const other = byId.get(side === l.a ? l.b : l.a);
      const toRoomId = other ? other.id : side;
      const got = taken.get(side) || [];
      let spot = null;
      for (let i = 0; i < 40 && !spot; i++) {
        // Первые попытки — в сторону соседней комнаты (интуитивно),
        // затем — где свободно.
        const bias = i < 12 && other ? 0.65 : 0;
        const tx = other ? other.cx : r.cx;
        const ty = other ? other.cy : r.cy;
        const px = i < 12
          ? r.cx + (tx - r.cx) * bias * rng() + (rng() - 0.5) * r.w * 0.3
          : r.x + INSET + rng() * (r.w - INSET * 2);
        const py = i < 12
          ? r.cy + (ty - r.cy) * bias * rng() + (rng() - 0.5) * r.h * 0.3
          : r.y + INSET + rng() * (r.h - INSET * 2);
        const x = Math.max(r.x + INSET, Math.min(r.x + r.w - INSET, px));
        const y = Math.max(r.y + INSET, Math.min(r.y + r.h - INSET, py));
        if (Math.hypot(x - r.cx, y - r.cy) < 120) continue; // центр свободен
        if ((r.obstacles || []).some((b) => pointInRect(x, y, b, 60))) continue;
        if (got.some((p) => Math.hypot(p.x - x, p.y - y) < MIN_SEP)) continue;
        spot = { x, y };
      }
      if (!spot) spot = { x: r.cx, y: r.cy };
      got.push(spot);
      taken.set(side, got);
      portals.push({
        id: portals.length, roomId: side, toRoomId, linkIdx,
        x: Math.round(spot.x), y: Math.round(spot.y),
      });
    }
  });
  return portals;
}

// ---------------------------------------------------------- expansion wing

/**
 * Grow a continuation wing off an existing layout: `wingRooms` new rooms
 * scattered outward from a gateway (dead-end) room, linked to it and meshed
 * among themselves, then merged into the layout (rooms/links/corridors/
 * floors/solids/bounds/issues all updated in place).
 *
 * Deterministic wing CONTENT for (baseSeed, wingIndex); the attach point
 * (gatewayId) is gameplay-dependent by design.
 * Returns { roomIds, gatewayId } or null when no free space was found.
 */
export function generateWing(baseSeed, wingIndex, layout, gatewayId, opts = {}) {
  const o = { ...GEN_DEFAULTS, ...opts };
  const rng = mulberry32((((baseSeed >>> 0) ^ Math.imul(wingIndex + 1, 0x9e3779b9)) >>> 0) || 1);
  const rooms = layout.rooms;
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const gateway = byId.get(gatewayId);
  if (!gateway) return null;

  // Outward direction: through the gateway, away from its first neighbor.
  const nb = layout.links.find((l) => l.a === gatewayId || l.b === gatewayId);
  let baseAng;
  if (nb) {
    const other = byId.get(nb.a === gatewayId ? nb.b : nb.a);
    baseAng = Math.atan2(gateway.cy - other.cy, gateway.cx - other.cx);
  } else {
    baseAng = rng() * Math.PI * 2;
  }

  const count = o.wingRooms;
  const baseId = Math.max(...rooms.map((r) => r.id)) + 1;
  const place = (radius, guardMax) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const a = baseAng + attempt * (Math.PI / 5);
      const dist = 3400 + attempt * 400;
      const ccx = gateway.cx + Math.cos(a) * dist;
      const ccy = gateway.cy + Math.sin(a) * dist;
      const cand = scatterRooms(
        rng,
        count,
        o,
        () => {
          const w = range(rng, o.roomMin, o.roomMax);
          const h = range(rng, o.roomMin, o.roomMax);
          const ang = rng() * Math.PI * 2;
          const rad = Math.sqrt(rng()) * radius;
          return { x: ccx + Math.cos(ang) * rad - w / 2, y: ccy + Math.sin(ang) * rad - h / 2, w, h };
        },
        rooms,
        baseId,
        guardMax
      );
      if (cand.length >= count) return cand;
    }
    return null;
  };
  let placed = place(2600, 12000);
  if (!placed) placed = place(3300, 20000); // fallback: wider net
  if (!placed) return null;
  const newRooms = placed;

  // Uplink: gateway to its nearest new room, then mesh the wing internally.
  let best = newRooms[0];
  let bd = Infinity;
  for (const r of newRooms) {
    const d = Math.hypot(r.cx - gateway.cx, r.cy - gateway.cy);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  const links = [{ a: gatewayId, b: best.id, d: bd }, ...linkRooms(rng, newRooms, o)];

  // Режим карты запоминаем с первой генерации; крыло его наследует.
  const withTunnels = layout.withTunnels !== false;
  const allById = new Map([...rooms, ...newRooms].map((r) => [r.id, r]));
  const corridors = withTunnels ? routeCorridors(rng, allById, links, o) : [];
  const newCorrRects = corridors.flatMap((c) => c.rects);
  const allCorrRects = withTunnels
    ? [...layout.corridors.flatMap((c) => c.rects), ...newCorrRects]
    : [];

  if (withTunnels) {
    // Gateway walls are rebuilt with the new door; new rooms get full treatment.
    buildRoomWalls(gateway, allCorrRects, o);
  }
  for (const r of newRooms) {
    buildRoomWalls(r, allCorrRects, o);
  }

  // Врата новых линков — ДО препятствий и спавнов (чтобы те их обходили).
  // linkIdx/id сдвигаем на уже имеющиеся, чтобы врата оставались уникальными.
  let newPortals = [];
  if (!withTunnels) {
    const baseLinkIdx = layout.links.length;
    const basePortalId = layout.portals.length;
    const portalRng = mulberry32(
      (((baseSeed >>> 0) ^ Math.imul(wingIndex + 1, 0x51ed270b) ^ 0x70da1) >>> 0) || 1);
    newPortals = placePortals(portalRng, [...rooms, ...newRooms], links, layout.portals);
    for (const p of newPortals) {
      p.linkIdx += baseLinkIdx;
      p.id += basePortalId;
    }
    layout.portals.push(...newPortals);
  }
  const portalsByRoom = new Map([...rooms, ...newRooms].map((r) => [r.id, []]));
  for (const p of layout.portals) portalsByRoom.get(p.roomId).push(p);

  for (const r of newRooms) {
    r.obstacles = placeObstacles(rng, r, o, portalsByRoom.get(r.id) || []);
  }
  for (const r of newRooms) r.spawns = placeSpawns(rng, r, o, portalsByRoom.get(r.id) || []);

  if (withTunnels) {
    layout.corridorWalls = buildCorridorWalls(allCorrRects, [...rooms, ...newRooms], o);
  }
  layout.rooms.push(...newRooms);
  // Типы комнат считаются по ОБЩЕЙ нумерации — гарантия «лавка раз в 10
  // комнат» продолжает работать при расширении карты.
  assignShopTypes(rng, layout.rooms);
  layout.links.push(...links);
  layout.corridors.push(...corridors);
  layout.floors.push(
    ...newRooms.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h, roomId: r.id })),
    ...newCorrRects.map((c) => ({ ...c, roomId: -1 }))
  );
  rebuildSolids(layout);
  layout.bounds = computeBounds(layout.floors, layout.solids);
  layout.issues = validateLayout(layout);
  return { roomIds: newRooms.map((r) => r.id), gatewayId, corridorCount: corridors.length };
}

// ------------------------------------------------------- interior obstacles

function placeObstacles(rng, r, o, portals = []) {
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
    // Не ставим блок на врата и в их подступы — телепорт должен читаться.
    if (portals.some((p) => pointInRect(p.x, p.y, expand(cand, PORTAL.clearance * 0.6)))) continue;
    blocks.push(cand);
    // Validate: center must still reach every door/gate; otherwise drop the block.
    if (!roomPathsOpen(r, blocks, portals)) blocks.pop();
  }
  return blocks;
}

function expand(r, m) {
  return { x: r.x - m, y: r.y - m, w: r.w + m * 2, h: r.h + m * 2 };
}

/** Coarse-grid BFS inside one room: center reaches all door mouths / gates. */
function roomPathsOpen(room, blocks, portals = []) {
  const CELL = 44;
  const cols = Math.max(2, Math.floor(room.w / CELL));
  const rows = Math.max(2, Math.floor(room.h / CELL));
  const blocked = (col, row) => {
    const cx = room.x + ((col + 0.5) / cols) * room.w;
    const cy = room.y + ((row + 0.5) / rows) * room.h;
    return blocks.some((b) => pointInRect(cx, cy, expand(b, 26)));
  };
  // Портальный режим: целей-дверей нет, достижимость проверяем по вратам.
  const targets = portals.length
    ? portals.map((p) => [
        clamp(Math.floor(((p.x - room.x) / room.w) * cols), 0, cols - 1),
        clamp(Math.floor(((p.y - room.y) / room.h) * rows), 0, rows - 1)
      ])
    : room.doors.map((d) => {
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

function placeSpawns(rng, r, o, portals = []) {
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
    // Врата держим свободными: враг не должен появляться в зоне телепорта.
    if (portals.some((p) => Math.hypot(p.x - x, p.y - y) < PORTAL.clearance)) continue;
    if (pts.some((p) => Math.hypot(p.x - x, p.y - y) < o.spawnMinSep)) continue;
    pts.push({ x, y });
  }
  return pts;
}

// --------------------------------------------------------- room kinds (shop)

/**
 * Разметка комнат: 'combat' (с монстрами) или 'shop' (лавка).
 * - Стартовая комната всегда боевая и без спавнов (см. placeSpawns).
 * - Гарантия: каждая 10-я нестартовая комната становится лавкой.
 * - Случайный шанс для остальных + предел доли лавок (SHOP.maxShare).
 * Уже размеченные комнаты не трогаются, поэтому порядок генерации стабилен.
 */
export function assignShopTypes(rng, rooms) {
  const normal = rooms.filter((r) => !r.isStart);
  const total = normal.length || 1;
  const maxShops = Math.floor(total * SHOP.maxShare);
  let shops = normal.filter((r) => r.type === 'shop').length;
  const idxOf = new Map(normal.map((r, i) => [r.id, i]));
  for (const r of normal) {
    if (r.type) continue; // уже размечена ранее
    const idx = idxOf.get(r.id) ?? 0;
    const forced = idx > 0 && idx % SHOP.guaranteedEvery === 0; // каждая 10-я
    if (shops < maxShops && (forced || rng() < SHOP.chance)) {
      r.type = 'shop';
      r.spawns = []; // в лавке монстров нет
      shops += 1;
    } else {
      r.type = 'combat';
    }
  }
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
  if (layout.withTunnels === false) {
    // Портальный режим: у каждой комнаты — врата на каждый линк, тоннелей нет.
    const byRoom = new Map(layout.rooms.map((r) => [r.id, []]));
    for (const p of layout.portals || []) {
      if (!byRoom.has(p.roomId)) {
        issues.push(`portal ${p.id} in unknown room ${p.roomId}`);
        continue;
      }
      byRoom.get(p.roomId).push(p);
      const host = layout.rooms[p.roomId];
      if (!pointInRect(p.x, p.y, host, -24)) issues.push(`portal ${p.id} outside room ${p.roomId}`);
    }
    const deg = new Map(layout.rooms.map((r) => [r.id, 0]));
    for (const l of layout.links) {
      deg.set(l.a, (deg.get(l.a) || 0) + 1);
      deg.set(l.b, (deg.get(l.b) || 0) + 1);
    }
    for (const r of layout.rooms) {
      const want = deg.get(r.id) || 0;
      const got = (byRoom.get(r.id) || []).length;
      if (want > 0 && got !== want) issues.push(`room ${r.id} portals ${got} != links ${want}`);
    }
    // Каждый линк — ровно пара врат с одинаковым linkIdx.
    const perLink = new Map();
    for (const p of layout.portals || []) perLink.set(p.linkIdx, (perLink.get(p.linkIdx) || 0) + 1);
    layout.links.forEach((l, i) => {
      if ((perLink.get(i) || 0) !== 2) issues.push(`link ${l.a}-${l.b} has ${perLink.get(i) || 0} portals, want 2`);
    });
    return issues;
  }
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
