/**
 * Touch controls: floating, near-transparent joystick + contextual key hints.
 *
 * The stick has no fixed home: a press anywhere on #joy-zone drops a faint
 * ring at that exact point and the knob follows the drag, so the player
 * starts moving from wherever the thumb already is. Pure DOM; the scene
 * consumes a normalized joyVec {x,y}. Pointer Events cover touch and mouse
 * alike (handy for desktop testing).
 */

export function isTouchDevice() {
  try {
    return 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
  } catch {
    return false;
  }
}

const R = 52; // max knob travel, px
const DEAD = 0.14; // stick ignored below this normalized length

let bound = false;

export function initTouch({ onMove }) {
  const wrap = document.getElementById('touch-ui');
  const zone = document.getElementById('joy-zone');
  const joy = document.getElementById('joy');
  const knob = document.getElementById('joy-knob');
  if (!wrap || !zone || !joy || !knob) return false;
  wrap.classList.remove('hidden');
  document.body.classList.add('touch');

  if (bound) return true; // listeners live once, even across scene restarts
  bound = true;

  let pid = null;
  let ox = 0;
  let oy = 0;

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

  zone.addEventListener('pointerdown', (e) => {
    if (pid !== null) return; // один палец — один стик
    e.preventDefault();
    pid = e.pointerId;
    try { zone.setPointerCapture(e.pointerId); } catch { /* noop */ }
    ox = e.clientX;
    oy = e.clientY;
    joy.style.left = `${ox}px`;
    joy.style.top = `${oy}px`;
    joy.classList.add('active');
    document.body.classList.add('joy-active');
    setKnob(0, 0);
    onMove(0, 0);
  });

  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    e.preventDefault();
    push(e.clientX - ox, e.clientY - oy);
  });

  const release = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    setKnob(0, 0);
    joy.classList.remove('active');
    document.body.classList.remove('joy-active');
    onMove(0, 0);
  };

  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);
  zone.addEventListener('lostpointercapture', release);
  return true;
}
