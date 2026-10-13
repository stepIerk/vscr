/**
 * Touch controls: subtle left-bottom joystick + action button.
 * Pure DOM; the scene consumes a normalized joyVec {x,y} and an action tap.
 * Pointer Events cover touch mice alike (handy for desktop testing).
 */

export function isTouchDevice() {
  try {
    return 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
  } catch {
    return false;
  }
}

export function initTouch({ onMove, onAction }) {
  const wrap = document.getElementById('touch-ui');
  const base = document.getElementById('joy');
  const knob = document.getElementById('joy-knob');
  const act = document.getElementById('act-btn');
  const hint = document.getElementById('hud-hint');
  if (!wrap || !base || !knob) return false;
  wrap.classList.remove('hidden');
  document.body.classList.add('touch');
  if (hint) hint.textContent = 'Джойстик — движение · атака сама · E — купить у стенда';
  const R = 44; // max knob travel, px
  const DEAD = 0.15;
  let pid = null;
  const setKnob = (dx, dy) => {
    knob.style.transform = `translate(${dx}px,${dy}px)`;
  };
  const push = (dx, dy) => {
    const len = Math.hypot(dx, dy) || 1;
    const cl = Math.min(len, R);
    const nx = (dx / len) * (cl / R);
    const ny = (dy / len) * (cl / R);
    setKnob((dx / len) * cl, (dy / len) * cl);
    if (Math.hypot(nx, ny) < DEAD) onMove(0, 0);
    else onMove(nx, ny);
  };
  const center = () => {
    const r = base.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  base.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { base.setPointerCapture(e.pointerId); } catch { /* noop */ }
    pid = e.pointerId;
    const c = center();
    push(e.clientX - c.x, e.clientY - c.y);
  });
  base.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    e.preventDefault();
    const c = center();
    push(e.clientX - c.x, e.clientY - c.y);
  });
  const release = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    setKnob(0, 0);
    onMove(0, 0);
  };
  base.addEventListener('pointerup', release);
  base.addEventListener('pointercancel', release);
  if (act) {
    act.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onAction();
    });
  }
  return true;
}
