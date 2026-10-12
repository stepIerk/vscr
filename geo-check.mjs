import { generateLayout, pointInRect } from './src/world/generator.js';
import { DUNGEON } from './src/config.js';

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

for (const seed of [1, 7, 42, 4242, 1337, 2026, 99999]) {
  const L = generateLayout(seed, OPTS);
  const HW = 60, T = 24;

  ok(`seed ${seed}: no layout issues`, L.issues.length === 0, JSON.stringify(L.issues));
  ok(`seed ${seed}: 12-18 rooms`, L.rooms.length >= 12 && L.rooms.length <= 18, `${L.rooms.length}`);
  // Стартовая комната может быть немного меньше обычной (startRoomMin).
  const nonStartR = L.rooms.filter((r) => !r.isStart);
  ok(`seed ${seed}: room sizes ${DUNGEON.roomMin}-${DUNGEON.roomMax}`,
    nonStartR.every((r) => r.w >= DUNGEON.roomMin && r.w <= DUNGEON.roomMax && r.h >= DUNGEON.roomMin && r.h <= DUNGEON.roomMax),
    `[${L.rooms.map((r) => Math.round(r.w)).join(',')}]`);
  const nonStart = nonStartR;
  ok(`seed ${seed}: start room typed combat`, L.rooms[0].type === 'combat' && L.rooms[0].spawns.length === 0);
  const fighting = nonStart.filter((r) => r.type !== 'shop'); // лавки без спавнов
  ok(`seed ${seed}: 3-9 spawns in fighting rooms`, fighting.every((r) => r.spawns.length >= 3 && r.spawns.length <= 9),
    `[${fighting.map((r) => r.spawns.length)}]`);
  // Гарантия лавки: каждая 10-я нестартовая комната — лавка.
  const forcedOk = nonStart.every((r, i) => !(i > 0 && i % 10 === 0) || r.type === 'shop');
  ok(`seed ${seed}: shop guaranteed every 10 rooms`, forcedOk,
    `shops=${nonStart.filter((r) => r.type === 'shop').length}`);

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
