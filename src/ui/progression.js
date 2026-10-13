/**
 * Progression panels: level-up draft, mutation target picker, colony window.
 * Pure DOM (works on desktop + touch); game state stays in RunState —
 * this module only renders snapshots and forwards clicks to scene callbacks.
 * Весь интерфейс на русском, тёмная консоль с бирюзовым акцентом.
 */

import { ALLY_TYPES } from '../config.js';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

/** Картинка из dataURL (Phaser-текстура) или заглушка-пятно. */
function imgEl(url, cls) {
  if (url) {
    const im = document.createElement('img');
    im.className = cls;
    im.src = url;
    im.alt = '';
    return im;
  }
  return el('div', `${cls} img-missing`);
}

function overlay(id, sheet = false) {
  let o = document.getElementById(id);
  if (!o) {
    o = el('div', 'overlay hidden');
    o.id = id;
    document.getElementById('app').appendChild(o);
  }
  // Нижний лист: панель прижата к низу экрана — карточки под большим пальцем.
  o.classList.toggle('sheet', sheet);
  return o;
}

// ------------------------------------------------------------------- draft

export function showDraft({ level, cards, onPick }) {
  const o = overlay('draft-overlay', true);
  o.classList.remove('hidden');
  o.replaceChildren();
  const box = el('div', 'panel draft-panel');
  box.appendChild(el('h2', 'panel-title', `Уровень ${level} — выбери одно`));
  const row = el('div', 'draft-row');
  for (const card of cards) {
    const b = el('button', `draft-card kind-${card.kind}`);
    b.type = 'button';
    b.appendChild(el('span', 'card-tag', card.tag));
    b.appendChild(el('div', 'card-title', card.title));
    b.appendChild(el('div', 'card-desc', card.desc));
    for (const line of card.lines || []) b.appendChild(el('div', 'card-line', line));
    if (card.levelLine) b.appendChild(el('div', 'card-level', card.levelLine));
    b.addEventListener('click', () => onPick(card));
    row.appendChild(b);
  }
  box.appendChild(row);
  o.appendChild(box);
}

export function hideDraft() {
  const o = document.getElementById('draft-overlay');
  if (o) {
    o.classList.add('hidden');
    o.replaceChildren();
  }
  hideTargets();
}

// ----------------------------------------------------------------- targets

export function showTargets({ title, options, onSelect }) {
  const o = overlay('target-overlay', true);
  o.classList.remove('hidden');
  o.replaceChildren();
  const box = el('div', 'panel target-panel');
  box.appendChild(el('h2', 'panel-title', title));
  box.appendChild(el('div', 'panel-sub', 'Кому дать:'));
  const list = el('div', 'target-list');
  for (const opt of options) {
    const b = el('button', 'target-row');
    b.type = 'button';
    b.appendChild(el('span', 'target-label', opt.label));
    if (opt.sub) b.appendChild(el('span', 'target-sub', opt.sub));
    b.addEventListener('click', () => {
      hideTargets();
      if (opt.id === 'hero') onSelect({ scope: 'hero' });
      else onSelect({ scope: 'cell', id: Number(opt.id.split(':')[1]) });
    });
    list.appendChild(b);
  }
  const cancel = el('button', 'ghost-btn', 'Назад');
  cancel.type = 'button';
  cancel.addEventListener('click', hideTargets);
  box.appendChild(list);
  box.appendChild(cancel);
  o.appendChild(box);
}

export function hideTargets() {
  const o = document.getElementById('target-overlay');
  if (o) {
    o.classList.add('hidden');
    o.replaceChildren();
  }
}

// ------------------------------------------------------------------ colony

let mergeSel = [];

export function isColonyOpen() {
  const o = document.getElementById('colony-overlay');
  return !!o && !o.classList.contains('hidden');
}

export function showColony(snap, { onMerge, onClose }) {
  const o = overlay('colony-overlay');
  o.classList.remove('hidden');
  o.replaceChildren();
  mergeSel = mergeSel.filter((id) => snap.run.getCell(id)); // drop dead cells
  const box = el('div', 'panel colony-panel');
  const head = el('div', 'colony-head');
  const titleWrap = el('div');
  titleWrap.appendChild(el('h2', 'panel-title', 'Колония'));
  titleWrap.appendChild(
    el('div', 'panel-sub', 'Нажми две совместимые клетки — они сольются в более сильную')
  );
  head.appendChild(titleWrap);
  const close = el('button', 'ghost-btn', 'Закрыть');
  close.type = 'button';
  close.addEventListener('click', () => {
    mergeSel = [];
    onClose();
  });
  head.appendChild(close);
  box.appendChild(head);

  // --- cells ---
  box.appendChild(el('h3', 'section-title', `Клетки (${snap.run.cells.length}/${snap.run.maxCells})`));
  const grid = el('div', 'colony-grid');
  if (!snap.cells.length) grid.appendChild(el('div', 'empty-note', 'Пока пусто — новые клетки дают уровни героя.'));
  const selCell = mergeSel.length === 1 ? snap.run.getCell(mergeSel[0]) : null;
  for (const { cell, stats, img } of snap.cells) {
    const selected = mergeSel.includes(cell.id);
    let cls = 'colony-card' + (selected ? ' selected' : '');
    let compat = null;
    if (selCell && !selected) {
      compat = snap.run.mergeCheck(selCell, cell);
      cls += compat.ok ? ' merge-ok' : ' merge-no';
    }
    const b = el('button', cls);
    b.type = 'button';
    b.appendChild(imgEl(img, 'cell-img'));
    const info = el('div', 'cell-info');
    info.appendChild(el('div', 'card-title',
      `${cellName(cell)}${cell.merge > 1 ? ` · слияние ${cell.merge}` : ''}`));
    // Полоска здоровья клетки.
    const hpTrack = el('div', 'side-hp-track');
    const hpFill = el('div', 'side-hp-fill');
    hpFill.style.width = `${Math.round((100 * Math.max(0, cell.hp)) / Math.max(1, stats.maxHealth))}%`;
    hpTrack.appendChild(hpFill);
    info.appendChild(hpTrack);
    info.appendChild(el('div', 'card-line', `ЗДР ${Math.ceil(cell.hp)}/${stats.maxHealth}`));
    info.appendChild(
      el('div', 'card-line', `АТК ${round1(stats.attack)} · ${round1(stats.attackSpeed)}/с · СКР ${Math.round(stats.moveSpeed)}`)
    );
    const muts = Object.entries(cell.mutations);
    info.appendChild(el('div', 'card-line dim', muts.length ? `Мутации: ${muts.map(([k, v]) => `${k} ${v}`).join(', ')}` : 'Без мутаций'));
    if (compat) {
      info.appendChild(el('div', compat.ok ? 'merge-hint-ok' : 'merge-hint-no',
        compat.ok ? '✓ сольётся с выбранной' : `✕ ${compat.reason}`));
    } else if (!selected && mergeSel.length === 0) {
      info.appendChild(el('div', hasPartner(snap, cell) ? 'merge-hint-ok' : 'merge-hint-dim',
        hasPartner(snap, cell) ? '✓ есть пара для слияния' : 'пары пока нет'));
    }
    b.appendChild(info);
    b.addEventListener('click', () => {
      if (mergeSel.includes(cell.id)) mergeSel = mergeSel.filter((x) => x !== cell.id);
      else if (mergeSel.length < 2) mergeSel.push(cell.id);
      else mergeSel = [mergeSel[1], cell.id];
      showColony(snap, { onMerge, onClose }); // re-render selection
    });
    grid.appendChild(b);
  }
  box.appendChild(grid);

  // --- merge bar ---
  const bar = el('div', 'merge-bar');
  if (mergeSel.length === 2) {
    const [a, b] = mergeSel.map((id) => snap.run.getCell(id));
    const chk = snap.run.mergeCheck(a, b);
    if (chk.ok) {
      const after = previewMerge(snap, a);
      bar.appendChild(
        el('div', 'merge-preview',
          `Слияние → ${cellName(a)} ${a.merge + 1} · ЗДР ${after.maxHealth} · АТК ${round1(after.attack)} · клеток ${snap.run.cells.length} → ${snap.run.cells.length - 1}`)
      );
      const go = el('button', 'primary-btn', 'Слить клетки');
      go.type = 'button';
      go.addEventListener('click', () => {
        mergeSel = [];
        onMerge(a.id, b.id);
      });
      bar.appendChild(go);
    } else {
      bar.appendChild(el('div', 'merge-reason', `Нельзя слить: ${chk.reason}`));
    }
  } else {
    bar.appendChild(el('div', 'merge-reason', 'Выбери две клетки: сольются только одинаковые по виду, уровню и мутациям.'));
  }
  box.appendChild(bar);

  // --- mutations ---
  box.appendChild(el('h3', 'section-title', 'Мутации'));
  const ml = el('div', 'flat-list');
  const heroMuts = Object.entries(snap.run.heroMutations);
  ml.appendChild(el('div', 'flat-row', heroMuts.length ? `Герой: ${heroMuts.map(([k, v]) => `${k} ${v}`).join(', ')}` : 'Герой: нет'));
  for (const { cell } of snap.cells) {
    const ms = Object.entries(cell.mutations);
    ml.appendChild(el('div', 'flat-row', `#${cell.id} ${cellName(cell)}: ${ms.length ? ms.map(([k, v]) => `${k} ${v}`).join(', ') : 'нет'}`));
  }
  box.appendChild(ml);

  // --- upgrades ---
  box.appendChild(el('h3', 'section-title', 'Улучшения'));
  const ul = el('div', 'flat-list');
  const ups = Object.entries(snap.run.upgrades);
  if (!ups.length) ul.appendChild(el('div', 'flat-row', 'Пока нет.'));
  for (const [k, v] of ups) ul.appendChild(el('div', 'flat-row', `${k}: ур. ${v}`));
  box.appendChild(ul);

  // --- hero line ---
  const h = snap.hero;
  box.appendChild(
    el('div', 'hero-line',
      `Герой ${snap.run.level} · ЗДР ${Math.ceil(snap.heroHp)}/${h.maxHealth} · АТК ${round1(h.attack)} · ${round1(h.attackSpeed)}/с · СКР ${Math.round(h.moveSpeed)}${h.regen > 0 ? ` · +${round1(h.regen)}/с` : ''}`)
  );
  o.appendChild(box);
}

function cellName(cell) {
  const names = { hunter: 'Охотник', defender: 'Защитник', parasite: 'Паразит' };
  try {
    const cfg = ALLY_TYPES[cell.type];
    if (cfg && cfg.name) return `${cfg.name} #${cell.id}`;
  } catch { /* ignore */ }
  return `${names[cell.type] || cell.type} #${cell.id}`;
}

/** Есть ли у клетки хоть один совместимый партнёр прямо сейчас. */
function hasPartner(snap, cell) {
  return snap.run.cells.some((other) => {
    if (other.id === cell.id) return false;
    return snap.run.mergeCheck(cell, other).ok;
  });
}

function previewMerge(snap, a) {
  const fake = { ...a, mutations: { ...a.mutations }, merge: a.merge + 1 };
  return snap.run.computeCell(fake);
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

export function hideColony() {
  const o = document.getElementById('colony-overlay');
  if (o) {
    o.classList.add('hidden');
    o.replaceChildren();
  }
  mergeSel = [];
}

export function hideAll() {
  hideDraft();
  hideTargets();
  hideColony();
  hideShop();
  hideArtifacts();
}

// --------------------------------------------------------------- shop

/** Окно лавки: товар за плазму (улучшения и артефакты). */
export function showShop(view) {
  const o = overlay('shop-overlay');
  o.classList.remove('hidden');
  o.replaceChildren();
  const box = el('div', 'panel shop-panel');
  const head = el('div', 'colony-head');
  const titleWrap = el('div');
  titleWrap.appendChild(el('h2', 'panel-title', view.title));
  titleWrap.appendChild(
    el('div', 'panel-sub',
      `Плазма: ${view.plasma ?? ''}${view.visits > 1 ? ` · посещение ${view.visits} (цены выросли)` : ''}`)
  );
  head.appendChild(titleWrap);
  const close = el('button', 'ghost-btn', 'Закрыть');
  close.type = 'button';
  close.addEventListener('click', view.onClose);
  head.appendChild(close);
  box.appendChild(head);

  const list = el('div', 'shop-list');
  for (const off of view.offers) {
    const row = el('div', 'shop-row');
    const info = el('div', 'shop-info');
    info.appendChild(el('div', 'shop-name', off.name));
    info.appendChild(el('div', 'shop-detail', off.detail));
    const tag = el('span', 'shop-tag', off.kind === 'artifact' ? 'Артефакт' : 'Улучшение');
    info.appendChild(tag);
    row.appendChild(info);
    const btn = el('button', 'primary-btn shop-buy', off.bought ? 'Куплено' : `Купить · ${off.price}`);
    btn.type = 'button';
    btn.disabled = !!off.disabled;
    if (off.bought) btn.classList.add('is-bought');
    btn.addEventListener('click', () => view.onBuy(off));
    row.appendChild(btn);
    list.appendChild(row);
  }
  if (!view.offers.length) list.appendChild(el('div', 'empty-note', 'Товары закончились.'));
  box.appendChild(list);
  box.appendChild(
    el('div', 'merge-reason',
      'Улучшения применяются сразу. Артефакты занимают активные слоты (не больше 5) и настраиваются в инвентаре.')
  );
  o.appendChild(box);
}

export function hideShop() {
  const o = document.getElementById('shop-overlay');
  if (o) {
    o.classList.add('hidden');
    o.replaceChildren();
  }
}

// ----------------------------------------------------- artifact inventory

/** Инвентарь: сетка активных слотов + запас. Неполученного не показываем. */
export function showArtifacts(view, { onToggle, onClose }) {
  const o = overlay('artifacts-overlay');
  o.classList.remove('hidden');
  o.replaceChildren();
  const box = el('div', 'panel colony-panel');
  const head = el('div', 'colony-head');
  const t = el('div');
  t.appendChild(el('h2', 'panel-title', 'Артефакты'));
  t.appendChild(el('div', 'panel-sub', `Активно: ${view.used}/${view.slots} · плазма: ${view.plasma}`));
  head.appendChild(t);
  const close = el('button', 'ghost-btn', 'Закрыть');
  close.type = 'button';
  close.addEventListener('click', onClose);
  head.appendChild(close);
  box.appendChild(head);

  // Сетка слотов: занятые — артефакт, пустые — свободная ячейка.
  box.appendChild(el('h3', 'section-title', 'Слоты'));
  const grid = el('div', 'slot-grid');
  const byId = Object.fromEntries((view.items || []).map((it) => [it.id, it]));
  for (let i = 0; i < view.slots; i++) {
    const id = (view.activeIds || [])[i];
    const it = id ? byId[id] : null;
    if (it) {
      const b = el('button', 'slot-cell filled');
      b.type = 'button';
      b.appendChild(imgEl(view.icon, 'slot-icon'));
      const info = el('div', 'slot-info');
      info.appendChild(el('div', 'card-title', it.name));
      info.appendChild(el('div', 'card-line', `ур. ${it.level}/${it.maxLevel}`));
      info.appendChild(el('div', 'card-line dim', 'нажми — снять'));
      b.appendChild(info);
      b.addEventListener('click', () => onToggle(it.id, false));
      grid.appendChild(b);
    } else {
      grid.appendChild(el('div', 'slot-cell empty', 'Пусто'));
    }
  }
  box.appendChild(grid);

  // Запас: получено, но выключено — нажать, чтобы надеть.
  const reserve = (view.items || []).filter((it) => it.level > 0 && !it.active);
  if (reserve.length) {
    box.appendChild(el('h3', 'section-title', 'Запас — нажми, чтобы надеть'));
    const rg = el('div', 'slot-grid reserve');
    for (const it of reserve) {
      const b = el('button', 'slot-cell');
      b.type = 'button';
      b.appendChild(imgEl(view.icon, 'slot-icon'));
      const info = el('div', 'slot-info');
      info.appendChild(el('div', 'card-title', it.name));
      info.appendChild(el('div', 'card-line', `ур. ${it.level}/${it.maxLevel}`));
      b.appendChild(info);
      b.addEventListener('click', () => onToggle(it.id, true));
      rg.appendChild(b);
    }
    box.appendChild(rg);
  }
  box.appendChild(
    el('div', 'merge-reason',
      view.used >= view.slots
        ? 'Все слоты заняты — сними артефакт, чтобы надеть другой.'
        : 'Нажми на артефакт в запасе, чтобы надеть его в свободный слот.'
    )
  );
  o.appendChild(box);
}

export function hideArtifacts() {
  const o = document.getElementById('artifacts-overlay');
  if (o) {
    o.classList.add('hidden');
    o.replaceChildren();
  }
}
