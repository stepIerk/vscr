/**
 * Minimap: top-right world overview (plain DOM canvas, no Phaser).
 * Base layer (rooms/tunnels) renders once per map; visited rooms are
 * highlighted, cleared rooms get a lighter rim, the player is a dot.
 * Updates are throttled — cheap by design.
 */

const SIZE = 220;

export class Minimap {
  constructor() {
    this.canvas = document.getElementById('minimap');
    this.last = 0;
    this.base = null;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.lastKey = '';
  }

  renderBase(layout) {
    const b = layout.bounds;
    this.scale = Math.min(SIZE / b.w, SIZE / b.h);
    this.ox = (SIZE - b.w * this.scale) / 2;
    this.oy = (SIZE - b.h * this.scale) / 2;
    const base = document.createElement('canvas');
    base.width = SIZE;
    base.height = SIZE;
    const g = base.getContext('2d');
    g.fillStyle = '#070405';
    g.fillRect(0, 0, SIZE, SIZE);
    const r = (f) => [
      this.ox + f.x * this.scale, this.oy + f.y * this.scale,
      Math.max(1, f.w * this.scale), Math.max(1, f.h * this.scale)
    ];
    // Tunnels first (dimmer), then rooms.
    g.fillStyle = '#241014';
    for (const c of layout.corridors) {
      for (const t of c.rects) {
        const [x, y, w, h] = r(t);
        g.fillRect(x, y, w, h);
      }
    }
    g.fillStyle = '#332027';
    for (const rm of layout.rooms) {
      const [x, y, w, h] = r(rm);
      g.fillRect(x, y, w, h);
    }
    // Start room outline.
    const s0 = layout.rooms[0];
    if (s0) {
      const [x, y, w, h] = r(s0);
      g.strokeStyle = '#40e0d0';
      g.lineWidth = 1.5;
      g.strokeRect(x, y, w, h);
    }
    this.base = base;
    this.lastKey = '';
    this.last = 0;
  }

  /** Redraw dynamic layer when state changed (visited/cleared/player room). */
  update(px, py, rooms, currentId) {
    if (!this.canvas || !this.base) return;
    const now = performance.now();
    const key = rooms.map((r) => (r.cleared ? 2 : r.visited ? 1 : 0)).join('') + '|' + currentId;
    if (now - this.last < 300 && key === this.lastKey) return;
    this.last = now;
    this.lastKey = key;
    const g = this.canvas.getContext('2d');
    g.clearRect(0, 0, SIZE, SIZE);
    g.drawImage(this.base, 0, 0);
    const r = (f) => [
      this.ox + f.x * this.scale, this.oy + f.y * this.scale,
      Math.max(1.5, f.w * this.scale), Math.max(1.5, f.h * this.scale)
    ];
    for (const rm of rooms) {
      if (!rm.visited && !rm.cleared) continue;
      const [x, y, w, h] = r(rm);
      g.fillStyle = rm.cleared ? '#5a4a52' : '#7a3542';
      g.fillRect(x, y, w, h);
      if (rm.cleared) {
        g.strokeStyle = '#9dffb0';
        g.lineWidth = 1;
        g.strokeRect(x, y, w, h);
      }
    }
    if (currentId != null) {
      const cur = rooms[currentId];
      if (cur) {
        const [x, y, w, h] = r(cur);
        g.strokeStyle = '#ffd94d';
        g.lineWidth = 1.5;
        g.strokeRect(x, y, w, h);
      }
    }
    // Player dot on top.
    const dx = this.ox + px * this.scale;
    const dy = this.oy + py * this.scale;
    g.fillStyle = '#ffd94d';
    g.beginPath();
    g.arc(Math.max(3, Math.min(SIZE - 3, dx)), Math.max(3, Math.min(SIZE - 3, dy)), 3, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1;
    g.stroke();
  }
}
