import { generateLayout, pointInRect } from './src/world/generator.js';
import { DUNGEON, SHOP, PORTAL } from './src/config.js';

// Тест генерирует мир теми же параметрами, что и сцена.
const OPTS = {
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
};

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) fails++;
  console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
};

/** Общие проверки: комнаты, типы, лавки, спавны (не зависят от режима карты). */
function checkCommon(L, seed) {
  ok(`seed ${seed}: no layout issues`, L.issues.length === 0, JSON.stringify(L.issues));
  ok(`seed ${seed}: 12-18 rooms`, L.rooms.length >= 12 && L.rooms.length <= 18, `${L.rooms.length}`);
  // Стартовая комната может быть немного меньше обычной (startRoomMin).
  const nonStartR = L.rooms.filter((r) => !r.isStart);
  ok(`seed ${seed}: room sizes ${DUNGEON.roomMin}-${DUNGEON.roomMax}`,
    nonStartR.every((r) => r.w >= DUNGEON.roomMin && r.w <= DUNGEON.roomMax && r.h >= DUNGEON.roomMin && r.h <= DUNGEON.roomMax),
    `[${L.rooms.map((r) => Math.round(r.w)).join(',')}]`);
  ok(`seed ${seed}: start room typed combat`, L.rooms[0].type === 'combat' && L.rooms[0].spawns.length === 0);
  const fighting = nonStartR.filter((r) => r.type !== 'shop'); // лавки без спавнов
  ok(`seed ${seed}: 3-9 spawns in fighting rooms`, fighting.every((r) => r.spawns.length >= 3 && r.spawns.length <= 9),
    `[${fighting.map((r) => r.spawns.length)}]`);
  // Гарантия лавки: каждая N-я нестартовая комната — лавка, пока не упираемся
  // в потолок доли (maxShare). Проверяем по фактической раскладке генератора.
  const maxShops = Math.max(1, Math.floor(nonStartR.length * SHOP.maxShare));
  const wantShops = Math.min(maxShops,
    nonStartR.filter((r, i) => i > 0 && i % SHOP.guaranteedEvery === 0).length);
  const gotShops = nonStartR.filter((r) => r.type === 'shop').length;
  ok(`seed ${seed}: shops >= guaranteed (every ${SHOP.guaranteedEvery}, cap ${maxShops})`,
    gotShops >= Math.max(1, wantShops - (SHOP.guaranteedEvery - 1)) && gotShops <= maxShops,
    `want~${wantShops} got ${gotShops}`);
}

/** Проверки портального режима: пары врат, позиции, свободные подступы. */
function checkPortals(L, seed) {
  const byId = new Map(L.rooms.map((r) => [r.id, r]));
  const perLink = new Map();
  for (const p of L.portals) perLink.set(p.linkIdx, (perLink.get(p.linkIdx) || 0) + 1);
  // Каждый линк графа — ровно пара врат.
  ok(`seed ${seed}: every link has 2 portals`,
    L.links.every((l, i) => perLink.get(i) === 2),
    `[${L.links.map((l, i) => `${l.a}-${l.b}:${perLink.get(i) || 0}`).join(' ')}]`);
  // Врата внутри своей комнаты, с отступом от стен, не в препятствии и не в центре.
  const bad = [];
  for (const p of L.portals) {
    const host = byId.get(p.roomId);
    if (!host) { bad.push(`p${p.id} no room`); continue; }
    if (p.x < host.x + PORTAL.inset - 40 || p.x > host.x + host.w - PORTAL.inset + 40 ||
        p.y < host.y + PORTAL.inset - 40 || p.y > host.y + host.h - PORTAL.inset + 40) bad.push(`p${p.id} at wall`);
    if (host.obstacles.some((b) => pointInRect(p.x, p.y, b, 10))) bad.push(`p${p.id} in obstacle`);
    if (Math.hypot(p.x - host.cx, p.y - host.cy) < 100) bad.push(`p${p.id} at center`);
  }
  ok(`seed ${seed}: portals placed clean`, bad.length === 0, bad.join(' '));
  // Пары врат одного линка лежат в двух концах этого линка.
  const pairBad = [];
  L.links.forEach((l, i) => {
    const pair = L.portals.filter((p) => p.linkIdx === i);
    const rooms = pair.map((p) => p.roomId).sort((a, b) => a - b).join('-');
    if (rooms !== [l.a, l.b].sort((a, b) => a - b).join('-')) pairBad.push(`link ${l.a}-${l.b} -> ${rooms}`);
  });
  ok(`seed ${seed}: portal pairs span their link`, pairBad.length === 0, pairBad.join(' '));
  // Врата разнесены внутри комнаты.
  const sepBad = [];
  const byRoom = new Map();
  for (const p of L.portals) {
    const got = byRoom.get(p.roomId) || [];
    byRoom.set(p.roomId, got);
    for (const q of got) {
      if (Math.hypot(p.x - q.x, p.y - q.y) < PORTAL.minSeparation * 0.6) sepBad.push(`room ${p.roomId}`);
    }
    got.push(p);
  }
  ok(`seed ${seed}: portals separated in room`, sepBad.length === 0, sepBad.join(' '));
  // Подступы к вратам свободны: нет блоков и точек появления врагов рядом.
  const approachBad = [];
  for (const p of L.portals) {
    const host = byId.get(p.roomId);
    for (const b of host.obstacles) {
      const cx = Math.max(b.x, Math.min(p.x, b.x + b.w));
      const cy = Math.max(b.y, Math.min(p.y, b.y + b.h));
      if (Math.hypot(p.x - cx, p.y - cy) < PORTAL.clearance * 0.6) approachBad.push(`p${p.id}`);
    }
    for (const s of host.spawns) {
      if (Math.hypot(p.x - s.x, p.y - s.y) < PORTAL.clearance) approachBad.push(`spawn@${p.id}`);
    }
  }
  ok(`seed ${seed}: portal approaches clear`, approachBad.length === 0, approachBad.join(' '));
  // Тоннелей и дверей в этом режиме нет вообще.
  ok(`seed ${seed}: no tunnels/doors in portal mode`,
    L.corridors.length === 0 && L.rooms.every((r) => r.doors.length === 0 &&
      r.gaps.N.length + r.gaps.S.length + r.gaps.W.length + r.gaps.E.length === 0));
}

for (const seed of [1, 7, 42, 4242, 1337, 2026, 99999]) {
  const L = generateLayout(seed, OPTS);
  const HW = 60, T = 24;

  checkCommon(L, seed);

  const inSolid = (x, y) => L.solids.some((s) => pointInRect(x, y, s, 0));
  const inFloor = (x, y) => L.floors.some((f) => pointInRect(x, y, f, 0));
  const walkable = (x, y) => inFloor(x, y) && !inSolid(x, y);
  const inRoom = (x, y) => L.rooms.find((r) => pointInRect(x, y, r, 0));

  // 1. Elbow outer corners must be solid — unless the joint sits inside a
  // room (then the turn area is open room floor by design). Either way the
  // corner must be wall or backed by floor — never a hole into the void.
  // (Legit cases: tunnel-into-tunnel junctions, room-adjacent turns.)
  let elbows = 0, elbowBad = [];
  for (const c of L.corridors) {
    if (!c.joint || inRoom(c.joint.x, c.joint.y)) continue;
    elbows++;
    const A = L.rooms[c.a], B = L.rooms[c.b];
    const d1 = norm(c.joint.x - A.cx, c.joint.y - A.cy);
    const d2 = norm(B.cx - c.joint.x, B.cy - c.joint.y);
    const o1 = outwardPerp(d1, d2); // away from where seg2 heads
    const o2 = outwardPerp(d2, { x: -d1.x, y: -d1.y }); // away from where seg1 came
    const px = c.joint.x + (o1.x + o2.x) * (HW + T / 2 - 2);
    const py = c.joint.y + (o1.y + o2.y) * (HW + T / 2 - 2);
    if (!inSolid(px, py) && !inFloor(px, py)) elbowBad.push(`${c.a}-${c.b}@(${Math.round(px)},${Math.round(py)})`);
    // Inner corner of the turn must stay open floor (no wall stubs jutting in).
    const ix = c.joint.x - (o1.x + o2.x) * (HW - 30);
    const iy = c.joint.y - (o1.y + o2.y) * (HW - 30);
    if (!walkable(ix, iy)) elbowBad.push(`${c.a}-${c.b} inner blocked@(${Math.round(ix)},${Math.round(iy)})`);
  }
  ok(`seed ${seed}: ${elbows} elbow corners solid`, elbowBad.length === 0, elbowBad.join(' '));

  // 2. Tunnel side midpoints: wall or legitimate opening — never void.
  let probes = 0, voidLeaks = [];
  for (const c of L.corridors) {
    for (const r of c.rects) {
      if (r.filler) continue;
      const horiz = r.w >= r.h;
      const mx = r.x + r.w / 2, my = r.y + r.h / 2;
      const off = HW + T / 2;
      const pts = horiz ? [[mx, my - off], [mx, my + off]] : [[mx - off, my], [mx + off, my]];
      for (const [x, y] of pts) {
        // skip probes near room interiors (door zones are openings by design)
        if (L.rooms.some((rm) => pointInRect(x, y, rm, 40))) continue;
        probes++;
        if (!inSolid(x, y) && !inFloor(x, y)) voidLeaks.push(`(${Math.round(x)},${Math.round(y)})`);
      }
    }
  }
  ok(`seed ${seed}: ${probes} tunnel-side probes walled/open`, voidLeaks.length === 0, voidLeaks.slice(0, 6).join(' '));

  // 3. Every door gap must open onto walkable floor (no lip blockers,
  // no holes): sample the gap mouth 40px inside the room.
  let doorsBad = [];
  for (const r of L.rooms) {
    const mouth = (side, at) => {
      if (side === 'N') return [at, r.y + 40];
      if (side === 'S') return [at, r.y + r.h - 40];
      if (side === 'W') return [r.x + 40, at];
      return [r.x + r.w - 40, at];
    };
    for (const side of ['N', 'S', 'W', 'E']) {
      for (const [a, b] of r.gaps[side]) {
        const mid = (a + b) / 2;
        const [mx, my] = mouth(side, Math.max(side === 'N' || side === 'S' ? r.x + 30 : r.y + 30,
          Math.min(side === 'N' || side === 'S' ? r.x + r.w - 30 : r.y + r.h - 30, mid)));
        if (!walkable(mx, my)) doorsBad.push(`${r.id}${side}@${Math.round(mid)}`);
      }
    }
  }
  ok(`seed ${seed}: door mouths walkable`, doorsBad.length === 0, doorsBad.join(' '));
  ok(`seed ${seed}/tunnels: no portals`, (L.portals || []).length === 0);

  // Режим 2: врата-порталы вместо тоннелей.
  const P = generateLayout(seed, { ...OPTS, withTunnels: false });
  checkCommon(P, `${seed}/portals`);
  checkPortals(P, `${seed}/portals`);
}

const A = JSON.stringify(generateLayout(4242).rooms);
ok('deterministic seed', A === JSON.stringify(generateLayout(4242).rooms));

function norm(x, y) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}
function outwardPerp(d, awayFrom) {
  const n1 = { x: -d.y, y: d.x };
  const dot = n1.x * awayFrom.x + n1.y * awayFrom.y;
  return dot <= 0 ? n1 : { x: -n1.x, y: -n1.y };
}

process.exit(fails ? 1 : 0);
