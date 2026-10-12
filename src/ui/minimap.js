/**
 * Minimap: top-right world overview (plain DOM canvas, no Phaser).
 * Follow mode: a fixed-scale viewport centered on the player (clamped to the
 * world bounds), so the map stays readable no matter how many wings grow.
 * Fog of war: only explored rooms (visited/cleared) and their direct
 * neighbours are drawn — the rest stays black.
 */

const SIZE = 220;
const VIEW = 7600; // world px across the map (constant zoom; ~a dozen chambers)

export const MINIMAP_VIEW = VIEW;

/** IDs visible under fog: explored rooms + their link neighbours. Pure. */
export function computeVisibleRooms(rooms, links) {
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const explored = new Set(rooms.filter((r) => r.visited || r.cleared).map((r) => r.id));
  const vis = new Set(explored);
  for (const l of links) {
    if (!byId.has(l.a) || !byId.has(l.b)) continue;
    if (explored.has(l.a)) vis.add(l.b);
    if (explored.has(l.b)) vis.add(l.a);
  }
  return vis;
}

export class Minimap {
  constructor() {
    this.canvas = document.getElementById('minimap');
    this.last = 0;
    this.layout = null;
    this.scale = SIZE / VIEW;
    this.lastKey = '';
  }

  renderBase(layout) {
    this.layout = layout;
    this.lastKey = '';
    this.last = 0;
  }

  /** Viewport rect (world coords), centered on the player, clamped to bounds. */
  viewRect(px, py) {
    const b = this.layout.bounds;
    const w = Math.min(VIEW, b.w);
    const h = Math.min(VIEW, b.h);
    const cx = b.w <= VIEW ? b.x + b.w / 2 : Math.max(b.x + w / 2, Math.min(b.x + b.w - w / 2, px));
    const cy = b.h <= VIEW ? b.y + b.h / 2 : Math.max(b.y + h / 2, Math.min(b.y + b.h - h / 2, py));
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  rect(f, v) {
    return [
      (f.x - v.x) * this.scale, (f.y - v.y) * this.scale,
      Math.max(1.5, f.w * this.scale), Math.max(1.5, f.h * this.scale)
    ];
  }

  /** Redraw when exploration state changed or the player moved enough. */
  update(px, py, layout, currentId) {
    if (!this.canvas || !layout) return;
    if (layout !== this.layout) this.renderBase(layout);
    const now = performance.now();
    const key =
      layout.rooms.map((r) => (r.cleared ? 2 : r.visited ? 1 : 0)).join('') +
      '|' + currentId + '|' + layout.rooms.length +
      '|' + layout.rooms.map((r) => (r.type === 'shop' ? 1 : 0)).join('') +
      '|' + Math.round(px / 40) + ',' + Math.round(py / 40);
    if (now - this.last < 300 && key === this.lastKey) return;
    this.last = now;
    this.lastKey = key;
    const v = this.viewRect(px, py);
    const g = this.canvas.getContext('2d');
    g.fillStyle = '#070405';
    g.fillRect(0, 0, SIZE, SIZE);
    const vis = computeVisibleRooms(layout.rooms, layout.links);
    const byId = new Map(layout.rooms.map((r) => [r.id, r]));
    // Visible tunnels first (a link shows when either end is visible).
    g.fillStyle = '#241014';
    for (let i = 0; i < layout.corridors.length; i++) {
      const link = layout.links[i];
      const show = !link || vis.has(link.a) || vis.has(link.b);
      if (!show) continue;
      for (const t of layout.corridors[i].rects) {
        const [x, y, w, h] = this.rect(t, v);
        g.fillRect(x, y, w, h);
      }
    }
    for (const rm of layout.rooms) {
      if (!vis.has(rm.id)) continue; // fog: unexplored far rooms stay black
      const [x, y, w, h] = this.rect(rm, v);
      const explored = rm.visited || rm.cleared;
      // Тип лавки раскрываем только после исследования — сосед в тумане
      // рисуется как обычная комната, иначе метка палит неисследованное.
      const shopKnown = rm.type === 'shop' && explored;
      g.fillStyle = !explored ? '#332027' : shopKnown ? '#6b5320' : rm.cleared ? '#5a4a52' : '#7a3542';
      g.fillRect(x, y, w, h);
      if (rm.cleared) {
        g.strokeStyle = '#9dffb0';
        g.lineWidth = 1;
        g.strokeRect(x, y, w, h);
      }
      if (shopKnown) {
        // Золотая метка лавки — видна только после визита.
        g.fillStyle = '#ffd94d';
        const cx = x + w / 2;
        const cy = y + h / 2;
        g.beginPath();
        g.arc(cx, cy, 3, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = '#ffd94d';
        g.lineWidth = 1.5;
        g.strokeRect(x, y, w, h);
      }
      if (rm.isStart) {
        g.strokeStyle = '#40e0d0';
        g.lineWidth = 1.5;
        g.strokeRect(x, y, w, h);
      }
    }
    if (currentId != null) {
      const cur = byId.get(currentId);
      if (cur && vis.has(currentId)) {
        const [x, y, w, h] = this.rect(cur, v);
        g.strokeStyle = '#ffd94d';
        g.lineWidth = 1.5;
        g.strokeRect(x, y, w, h);
      }
    }
    // Player dot on top.
    const dx = (px - v.x) * this.scale;
    const dy = (py - v.y) * this.scale;
    g.fillStyle = '#ffd94d';
    g.beginPath();
    g.arc(Math.max(3, Math.min(SIZE - 3, dx)), Math.max(3, Math.min(SIZE - 3, dy)), 3, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1;
    g.stroke();
  }
}
