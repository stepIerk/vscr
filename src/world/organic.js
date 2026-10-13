/**
 * Organic room shapes — single source of truth for Taylor tissue rooms.
 * Pure + deterministic: no Phaser dependency.
 *
 * - genRoomShape(room, seed) builds { floor, outer, morph } from (seed, id):
 *   floor lives fully INSIDE the layout rect (gameplay points placed against
 *   it stay valid), outer spills into the void with big fleshy lobes.
 * - The renderer draws these exact polygons, collision/NavGrid query them,
 *   and the generator places portals/obstacles/spawns inside them — so the
 *   visible boundary and the playable boundary are the same by construction.
 * - slideVelocity() is the standard wall-slide fix (velocity fights wall →
 *   jitter): probe the step, keep it if free, else drop the blocked axis.
 */

import { mulberry32, range, clamp } from './rng.js';

export function shapeSeed(seed, roomId) {
  return (((seed >>> 0) ^ Math.imul(roomId + 1, 0x9e3779b9) ^ 0x51f3) >>> 0) || 1;
}

function gauss(t, c, w) {
  const d = (t - c) / w;
  return Math.exp(-0.5 * d * d);
}

function makeLobes(rng, sideLen, ampMin, ampMax) {
  const n = clamp(Math.round(sideLen / 280), 2, 4);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ c: 0.15 + 0.7 * rng(), w: 0.12 + 0.18 * rng(), amp: ampMin + rng() * (ampMax - ampMin) });
  }
  return out;
}

function lobeAt(lobes, t) {
  let s = 0;
  for (const l of lobes) s += l.amp * gauss(t, l.c, l.w);
  return s;
}

/** Сглаживание Чайкина для замкнутого контура (округляет углы и доли). */
export function chaikinClosed(pts, iters = 1) {
  let cur = pts;
  for (let k = 0; k < iters; k++) {
    const next = [];
    for (let i = 0; i < cur.length; i++) {
      const p = cur[i];
      const q = cur[(i + 1) % cur.length];
      next.push(
        { x: p.x * 0.75 + q.x * 0.25, y: p.y * 0.75 + q.y * 0.25 },
        { x: p.x * 0.25 + q.x * 0.75, y: p.y * 0.25 + q.y * 0.75 }
      );
    }
    cur = next;
  }
  return cur;
}

export function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qy = ay + dy * t - py;
  return Math.hypot(qx, qy);
}

/** Внутри ли точка и зазор до края. */
export function polyMetrics(poly, x, y) {
  const inside = pointInPoly(x, y, poly);
  let minDist = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distPointSeg(x, y, poly[j].x, poly[j].y, poly[i].x, poly[i].y);
    if (d < minDist) minDist = d;
  }
  return { inside, minDist };
}

export function minDistToPoly(poly, x, y) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const d = distPointSeg(x, y, poly[j].x, poly[j].y, poly[i].x, poly[i].y);
    if (d < best) best = d;
  }
  return best;
}

/** Внутри полигона с зазором не меньше clear. */
export function polyClear(poly, x, y, clear) {
  if (!pointInPoly(x, y, poly)) return false;
  return minDistToPoly(poly, x, y) >= clear;
}

/**
 * Вдавить точку внутрь полигона с зазором radius: марш к центру
 * (комнаты звёздчатые — луч внутрь попадает всегда), центр — фолбэк.
 */
export function constrainPoint(poly, cx, cy, x, y, radius) {
  const m = polyMetrics(poly, x, y);
  if (m.inside && m.minDist >= radius) return { x, y };
  const dx0 = cx - x;
  const dy0 = cy - y;
  const len = Math.hypot(dx0, dy0);
  if (len < 1e-6) return { x: cx, y: cy };
  const dx = dx0 / len;
  const dy = dy0 / len;
  for (let d = 8; d <= len + radius + 40; d += 8) {
    const nx = x + dx * d;
    const ny = y + dy * d;
    const m2 = polyMetrics(poly, nx, ny);
    if (m2.inside && m2.minDist >= radius) return { x: nx, y: ny };
  }
  return { x: cx, y: cy };
}

/**
 * Слайд скорости вдоль стены (лечит дрожание): шаг целиком — свободен,
 * иначе пробуем оси по отдельности, иначе стоим. isWalkable — та же
 * проверка, что держит тело (полигон плоти + наросты).
 */
export function slideVelocity(isWalkable, x, y, vx, vy, step, radius) {
  if (vx === 0 && vy === 0) return [vx, vy];
  if (isWalkable(x + vx * step, y + vy * step, radius)) return [vx, vy];
  if (vx !== 0 && isWalkable(x + vx * step, y, radius)) return [vx, 0];
  if (vy !== 0 && isWalkable(x, y + vy * step, radius)) return [0, vy];
  return [0, 0];
}

// ---------------------------------------------------------- room morphotypes

/**
 * Морфотипы пола (портал-режим, коллизия = рисунок):
 * - blob: неправильная округлая доля (база);
 * - peanut: перетяжка-талия посередине (две доли);
 * - arc: вытянутая изогнутая дуга/банан вдоль длинной оси;
 * - bite: глубокий «укус»-залив с одной стороны + мелкие бухты.
 * Стартовая комната всегда blob — тихое знакомство с ареной.
 */
function buildShape(room, seed, attempt) {
  const rng = mulberry32(((shapeSeed(seed, room.id) ^ Math.imul(attempt + 1, 0x85ebca6b)) >>> 0) || 1);
  const mild = attempt > 0 ? 0.55 : 1; // повторные попытки — спокойнее
  const clean = attempt >= 3; // последняя попытка — чистый blob без причуд
  let morph = 'blob';
  if (!clean) {
    if (!room.isStart) {
      const roll = rng();
      morph = roll < 0.35 ? 'blob' : roll < 0.6 ? 'peanut' : roll < 0.85 ? 'arc' : 'bite';
    }
  }
  const inset = 10;
  const x0 = room.x + inset, y0 = room.y + inset;
  const x1 = room.x + room.w - inset, y1 = room.y + room.h - inset;
  const cr = [range(rng, 45, 85), range(rng, 45, 85), range(rng, 45, 85), range(rng, 45, 85)];
  const step = 55;
  const wN = x1 - x0 - cr[0] - cr[1], wS = x1 - x0 - cr[3] - cr[2];
  const hE = y1 - y0 - cr[1] - cr[2], hW = y1 - y0 - cr[0] - cr[3];
  const fN = makeLobes(rng, Math.max(120, wN), 8, 24);
  const fS = makeLobes(rng, Math.max(120, wS), 8, 24);
  const fE = makeLobes(rng, Math.max(120, hE), 8, 24);
  const fW = makeLobes(rng, Math.max(120, hW), 8, 24);
  const phN = rng() * 6.28, phS = rng() * 6.28, phE = rng() * 6.28, phW = rng() * 6.28;
  const fqN = clamp(Math.round(wN / 220), 1, 4), fqS = clamp(Math.round(wS / 220), 1, 4);
  const fqE = clamp(Math.round(hE / 220), 1, 4), fqW = clamp(Math.round(hW / 220), 1, 4);
  // Бухты-заливы: глубокие вмятины внутрь (bays привязаны к сторонам).
  const bays = { N: [], S: [], E: [], W: [] };
  const addBay = (side, depthMin, depthMax) => {
    bays[side].push({
      c: 0.25 + rng() * 0.5,
      w: 0.1 + rng() * 0.07,
      depth: (depthMin + rng() * (depthMax - depthMin)) * mild
    });
  };
  if (!clean) {
    if (morph === 'bite') {
      addBay(['N', 'S', 'E', 'W'][Math.floor(rng() * 4)], 70, 110);
      if (rng() < 0.5) addBay(['N', 'S', 'E', 'W'][Math.floor(rng() * 4)], 30, 55);
    } else if (morph !== 'peanut') {
      const n = rng() < 0.45 ? 1 : 0;
      for (let i = 0; i < n; i++) {
        addBay(['N', 'S', 'E', 'W'][Math.floor(rng() * 4)], 35, 65);
      }
    }
  }
  const bayAt = (list, t) => {
    let s = 0;
    for (const b of list) s += b.depth * gauss(t, b.c, b.w);
    return s;
  };
  const pts = [];
  const pushSide = (n, fn) => {
    for (let i = 0; i <= n; i++) fn(i / Math.max(1, n));
  };
  // N: слева направо, вогнутость внутрь (y+).
  pushSide(Math.max(3, Math.round(wN / step)), (t) => {
    const wob = clamp(4 + lobeAt(fN, t) + 6 * Math.sin(t * 6.28 * fqN + phN) + bayAt(bays.N, t), 0, 115);
    pts.push({ x: x0 + cr[0] + t * wN, y: y0 + wob });
  });
  for (let i = 1; i <= 4; i++) {
    const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2);
    pts.push({ x: x1 - cr[1] + Math.cos(a) * cr[1], y: y0 + cr[1] + Math.sin(a) * cr[1] });
  }
  // E: сверху вниз (x-).
  pushSide(Math.max(3, Math.round(hE / step)), (t) => {
    const wob = clamp(4 + lobeAt(fE, t) + 6 * Math.sin(t * 6.28 * fqE + phE) + bayAt(bays.E, t), 0, 115);
    pts.push({ x: x1 - wob, y: y0 + cr[1] + t * hE });
  });
  for (let i = 1; i <= 4; i++) {
    const a = 0 + (i / 5) * (Math.PI / 2);
    pts.push({ x: x1 - cr[2] + Math.cos(a) * cr[2], y: y1 - cr[2] + Math.sin(a) * cr[2] });
  }
  // S: справа налево (y-).
  pushSide(Math.max(3, Math.round(wS / step)), (t) => {
    const wob = clamp(4 + lobeAt(fS, t) + 6 * Math.sin(t * 6.28 * fqS + phS) + bayAt(bays.S, t), 0, 115);
    pts.push({ x: x1 - cr[2] - t * wS, y: y1 - wob });
  });
  for (let i = 1; i <= 4; i++) {
    const a = Math.PI / 2 + (i / 5) * (Math.PI / 2);
    pts.push({ x: x0 + cr[3] + Math.cos(a) * cr[3], y: y1 - cr[3] + Math.sin(a) * cr[3] });
  }
  // W: снизу вверх (x+).
  pushSide(Math.max(3, Math.round(hW / step)), (t) => {
    const wob = clamp(4 + lobeAt(fW, t) + 6 * Math.sin(t * 6.28 * fqW + phW) + bayAt(bays.W, t), 0, 115);
    pts.push({ x: x0 + wob, y: y1 - cr[3] - t * hW });
  });
  for (let i = 1; i <= 4; i++) {
    const a = Math.PI + (i / 5) * (Math.PI / 2);
    pts.push({ x: x0 + cr[0] + Math.cos(a) * cr[0], y: y0 + cr[0] + Math.sin(a) * cr[0] });
  }
  // Глобальные деформации в нормализованных координатах.
  const cx = room.cx, cy = room.cy;
  if (!clean && morph === 'arc') {
    // Дуга: концы загибаются в одну сторону вдоль длинной оси.
    const wide = room.w >= room.h;
    const A = Math.min(140, (0.05 + rng() * 0.06) * Math.min(room.w, room.h)) * mild;
    const dir = rng() < 0.5 ? 1 : -1;
    for (const p of pts) {
      if (wide) {
        const u = (p.x - room.x) / room.w - 0.5;
        p.y += dir * A * Math.pow(2 * u, 2);
      } else {
        const v = (p.y - room.y) / room.h - 0.5;
        p.x += dir * A * Math.pow(2 * v, 2);
      }
    }
  }
  if (!clean && morph === 'peanut') {
    // Талия: перетяжка посередине короткой оси, просторные доли по бокам.
    const wide = room.w >= room.h;
    const shortSide = wide ? room.h : room.w;
    const minWaist = clamp(shortSide * 0.42, 300, 720);
    const pMax = 1 - minWaist / shortSide;
    if (pMax >= 0.2) {
      const P = Math.min(0.28 + rng() * 0.22, pMax) * mild;
      for (const p of pts) {
        if (wide) {
          const u = (p.x - room.x) / room.w - 0.5;
          p.y = cy + (p.y - cy) * (1 - P * gauss(u, 0, 0.2));
        } else {
          const v = (p.y - room.y) / room.h - 0.5;
          p.x = cx + (p.x - cx) * (1 - P * gauss(v, 0, 0.2));
        }
      }
    } else {
      morph = 'blob';
    }
  }
  // Всё — строго внутри rect (коллизия никогда не шире проходимости).
  const m = 6;
  for (const p of pts) {
    p.x = Math.max(room.x + m, Math.min(room.x + room.w - m, p.x));
    p.y = Math.max(room.y + m, Math.min(room.y + room.h - m, p.y));
  }
  const floor = chaikinClosed(pts, 1);
  // Наружная масса: rect + 34px + крупные доли наружу (в пустоту — безопасно).
  const E = 34;
  const ox0 = room.x - E, oy0 = room.y - E;
  const ox1 = room.x + room.w + E, oy1 = room.y + room.h + E;
  const ocr = cr.map((c) => c + E + range(rng, 8, 30));
  const oN = makeLobes(rng, room.w, 25, 70);
  const oS = makeLobes(rng, room.w, 25, 70);
  const oE = makeLobes(rng, room.h, 25, 70);
  const oW = makeLobes(rng, room.h, 25, 70);
  const owN = ox1 - ox0 - ocr[0] - ocr[1], owS = ox1 - ox0 - ocr[3] - ocr[2];
  const ohE = oy1 - oy0 - ocr[1] - ocr[2], ohW = oy1 - oy0 - ocr[0] - ocr[3];
  const op = [];
  pushSide(Math.max(4, Math.round(owN / 70)), (t) => {
    op.push({ x: ox0 + ocr[0] + t * owN, y: oy0 - lobeAt(oN, t) });
  });
  for (let i = 1; i <= 4; i++) {
    const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2);
    op.push({ x: ox1 - ocr[1] + Math.cos(a) * ocr[1], y: oy0 + ocr[1] + Math.sin(a) * ocr[1] });
  }
  pushSide(Math.max(4, Math.round(ohE / 70)), (t) => {
    op.push({ x: ox1 + lobeAt(oE, t), y: oy0 + ocr[1] + t * ohE });
  });
  for (let i = 1; i <= 4; i++) {
    const a = 0 + (i / 5) * (Math.PI / 2);
    op.push({ x: ox1 - ocr[2] + Math.cos(a) * ocr[2], y: oy1 - ocr[2] + Math.sin(a) * ocr[2] });
  }
  pushSide(Math.max(4, Math.round(owS / 70)), (t) => {
    op.push({ x: ox1 - ocr[2] - t * owS, y: oy1 + lobeAt(oS, t) });
  });
  for (let i = 1; i <= 4; i++) {
    const a = Math.PI / 2 + (i / 5) * (Math.PI / 2);
    op.push({ x: ox0 + ocr[3] + Math.cos(a) * ocr[3], y: oy1 - ocr[3] + Math.sin(a) * ocr[3] });
  }
  pushSide(Math.max(4, Math.round(ohW / 70)), (t) => {
    op.push({ x: ox0 - lobeAt(oW, t), y: oy1 - ocr[3] - t * ohW });
  });
  for (let i = 1; i <= 4; i++) {
    const a = Math.PI + (i / 5) * (Math.PI / 2);
    op.push({ x: ox0 + ocr[0] + Math.cos(a) * ocr[0], y: oy0 + ocr[0] + Math.sin(a) * ocr[0] });
  }
  const outer = chaikinClosed(op, 1);
  return { floor, outer, morph };
}

/** Вокруг центра — простор для боя: ≥185px свободно во все стороны. */
function shapeIsRoomy(floor, room) {
  const m = polyMetrics(floor, room.cx, room.cy);
  return m.inside && m.minDist >= 185;
}

/**
 * Органический контур комнаты { floor, outer, morph }. Детерминирован от
 * (seed, room.id). Первые попытки — с характером (дуги, талии, заливы),
 * не прошедшие проверку простора — спокойнее, последняя — чистый blob.
 */
export function genRoomShape(room, seed) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const s = buildShape(room, seed, attempt);
    if (attempt >= 3 || shapeIsRoomy(s.floor, room)) return s;
  }
  return buildShape(room, seed, 3);
}
