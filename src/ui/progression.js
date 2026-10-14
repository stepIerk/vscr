/**
 * Progression panels: level-up draft, mutation target picker, colony window.
 * Pure DOM (works on desktop + touch); game state stays in RunState —
 * this module only renders snapshots and forwards clicks to scene callbacks.
 * Весь интерфейс на русском, тёмная консоль с бирюзовым акцентом.
 */

import { ALLY_TYPES } from '../config.js';
import { icon, cardIcon } from './icons.js';

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

/** Иконка из Tabler SVG (наследует цвет через currentColor). */
function iconEl(name, cls) {
  const span = el('span', 'ico-wrap');
  span.innerHTML = icon(name, cls || 'ico');
  return span.firstChild;
}

/** Характеристика: иконка + значение. */
function statEl(iconName, value) {
  const s = el('span', 'stat');
  s.appendChild(iconEl(iconName, 'ico ico-stat'));
  s.appendChild(el('span', '', value));
  return s;
}

function statsRow(pairs) {
  const row = el('div', 'stat-row');
  for (const { icon: ic, value } of pairs) row.appendChild(statEl(ic, value));
  return row;
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
    // Картинка сверху: клетка — спрайт из игры, мутация/улучшение — своя иконка.
    const imgBox = el('div', 'card-img');
    if (card.img) imgBox.appendChild(imgEl(card.img, 'card-art'));
    else {
      imgBox.classList.add('card-img-ico');
      imgBox.appendChild(iconEl(cardIcon(card), 'ico ico-card'));
    }
    b.appendChild(imgBox);
    const tag = el('span', 'card-tag');
    tag.appendChild(iconEl(cardIcon(card), 'ico ico-tag'));
    tag.appendChild(el('span', '', card.tag));
    b.appendChild(tag);
    b.appendChild(el('div', 'card-title', card.title));
    b.appendChild(el('div', 'card-desc', card.desc));
    for (const row of card.stats || []) b.appendChild(statsRow(row));
    for (const line of card.lines || []) b.appendChild(el('div', 'card-line', line));
    // if (card.levelLine) b.appendChild(el('div', 'card-level', card.levelLine));
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

export function showColony(snap, { onMerge, onSplit, onClose }) {
  const o = overlay('colony-overlay');
  o.classList.remove('hidden');
  mergeSel = mergeSel.filter((id) => snap.run.getCell(id)); // drop dead cells
  // Скролл переживает перерисовку (слияние/расщепление): панель не прыгает.
  const panelPrev = o.querySelector('.panel');
  const savedScroll = panelPrev ? panelPrev.scrollTop : 0;
  o.replaceChildren();
  const box = el('div', 'panel colony-panel');
  const head = el('div', 'colony-head');
  const titleWrap = el('div');
  titleWrap.appendChild(el('h2', 'panel-title', 'Колония'));
  titleWrap.appendChild(
    el('div', 'panel-sub',
      'Выбери одну клетку — расщепить, две совместимые — слить. Кнопка действия закреплена внизу.')
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
  const bioLine = el('div', 'colony-bio');
  bioLine.appendChild(el('span', '', 'Биоматериал: '));
  bioLine.appendChild(statEl('bio', snap.run.biomass));
  box.appendChild(bioLine);

  // --- cells ---
  box.appendChild(el('h3', 'section-title', `Клетки (${snap.run.cells.length}/${snap.run.maxCells})`));
  const grid = el('div', 'colony-grid');
  box.appendChild(grid);
  // --- merge bar (липкая: кнопка всегда под пальцем) ---
  const bar = el('div', 'merge-bar');
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
  const hl = el('div', 'hero-line');
  hl.appendChild(el('span', '', `Герой ${snap.run.level} · `));
  hl.appendChild(statEl('hp', `${Math.ceil(snap.heroHp)}/${h.maxHealth}`));
  hl.appendChild(statEl('atk', round1(h.attack)));
  hl.appendChild(statEl('atkSpeed', `${round1(h.attackSpeed)}/с`));
  hl.appendChild(statEl('spd', Math.round(h.moveSpeed)));
  if (h.regen > 0) hl.appendChild(statEl('regen', `+${round1(h.regen)}/с`));
  box.appendChild(hl);
  o.appendChild(box);
  box.scrollTop = savedScroll;

  // --- сетка строится один раз; выбор красится на месте, без перестройки ---
  const cardRefs = new Map(); // id -> { btn, hintBox, badge, cell }
  buildGrid();
  paintSelection();

  function buildGrid() {
    grid.replaceChildren();
    cardRefs.clear();
    if (!snap.cells.length) {
      grid.appendChild(el('div', 'empty-note', 'Пока пусто — новые клетки дают уровни героя.'));
      return;
    }
    for (const { cell, stats, img } of snap.cells) {
      const b = el('button', 'colony-card');
      b.type = 'button';
      b.setAttribute('aria-label', `${cellName(cell)} — выбрать`);
      b.appendChild(imgEl(img, 'cell-img'));
      const badge = el('span', 'pick-badge hidden', '');
      b.appendChild(badge);
      const info = el('div', 'cell-info');
      info.appendChild(el('div', 'card-title',
        `${cellName(cell)}${cell.merge > 1 ? ` · слияние ${cell.merge}` : ''}`));
      // Полоска здоровья клетки.
      const hpTrack = el('div', 'side-hp-track');
      const hpFill = el('div', 'side-hp-fill');
      hpFill.style.width = `${Math.round((100 * Math.max(0, cell.hp)) / Math.max(1, stats.maxHealth))}%`;
      hpTrack.appendChild(hpFill);
      info.appendChild(hpTrack);
      info.appendChild(statsRow([
        { icon: 'hp', value: `${Math.ceil(cell.hp)}/${stats.maxHealth}` },
        { icon: 'atk', value: round1(stats.attack) },
        { icon: 'atkSpeed', value: `${round1(stats.attackSpeed)}/с` },
        { icon: 'spd', value: Math.round(stats.moveSpeed) }
      ]));
      const muts = Object.entries(cell.mutations);
      info.appendChild(el('div', 'card-line dim', muts.length ? `Мутации: ${muts.map(([k, v]) => `${k} ${v}`).join(', ')}` : 'Без мутаций'));
      const hintBox = el('div', 'merge-hint-box');
      info.appendChild(hintBox);
      b.appendChild(info);
      b.addEventListener('click', () => {
        if (mergeSel.includes(cell.id)) mergeSel = mergeSel.filter((x) => x !== cell.id);
        else if (mergeSel.length < 2) mergeSel.push(cell.id);
        else mergeSel = [mergeSel[1], cell.id];
        paintSelection(); // только подсветка — скролл и сетка на месте
      });
      grid.appendChild(b);
      cardRefs.set(cell.id, { btn: b, hintBox, badge, cell });
    }
  }

  function hint(kind, text) {
    return el('div', kind, text);
  }

  function paintSelection() {
    const selCell = mergeSel.length === 1 ? snap.run.getCell(mergeSel[0]) : null;
    for (const [id, ref] of cardRefs) {
      const selected = mergeSel.includes(id);
      ref.btn.classList.toggle('selected', selected);
      ref.btn.classList.remove('merge-ok', 'merge-no');
      ref.hintBox.replaceChildren();
      if (selCell && id !== selCell.id) {
        const compat = snap.run.mergeCheck(selCell, ref.cell);
        ref.btn.classList.toggle('merge-ok', compat.ok);
        ref.btn.classList.toggle('merge-no', !compat.ok);
        ref.hintBox.appendChild(compat.ok
          ? hint('merge-hint-ok', '✓ сольётся с выбранной')
          : hint('merge-hint-no', `✕ ${compat.reason}`));
      } else if (!selected && mergeSel.length === 0) {
        ref.hintBox.appendChild(hasPartner(snap, ref.cell)
          ? hint('merge-hint-ok', '✓ есть пара для слияния')
          : hint('merge-hint-dim', 'пары пока нет'));
      }
      const order = mergeSel.indexOf(id);
      ref.badge.classList.toggle('hidden', order === -1);
      if (order !== -1) ref.badge.textContent = String(order + 1);
    }
    renderBar();
  }

  function renderBar() {
    bar.replaceChildren();
    if (mergeSel.length === 2) {
      const [a, b] = mergeSel.map((id) => snap.run.getCell(id));
      const chk = snap.run.mergeCheck(a, b);
      const cost = snap.run.mergeCost(a.merge);
      const poor = snap.run.biomass < cost;
      if (chk.ok) {
        const after = previewMerge(snap, a);
        const prev = el('div', 'merge-preview');
        prev.appendChild(el('span', '', `Слияние → ${cellName(a)} ${a.merge + 1} · `));
        prev.appendChild(statEl('hp', after.maxHealth));
        prev.appendChild(statEl('atk', round1(after.attack)));
        prev.appendChild(el('span', '', ` · клеток ${snap.run.cells.length} → ${snap.run.cells.length - 1}`));
        bar.appendChild(prev);
        const costLine = el('div', poor ? 'cost-line bad' : 'cost-line');
        costLine.appendChild(el('span', '', 'Стоимость: '));
        costLine.appendChild(statEl('bio', `${cost} биоматериала`));
        costLine.appendChild(el('span', '', ` · у тебя ${snap.run.biomass}${poor ? ' — не хватает' : ''}`));
        bar.appendChild(costLine);
        const go = el('button', 'primary-btn', 'Слить клетки');
        go.type = 'button';
        go.disabled = poor;
        go.addEventListener('click', () => {
          mergeSel = [];
          onMerge(a.id, b.id);
        });
        bar.appendChild(go);
      } else {
        bar.appendChild(el('div', 'merge-reason', `Нельзя слить: ${chk.reason}`));
      }
    } else if (mergeSel.length === 1) {
      const cell = snap.run.getCell(mergeSel[0]);
      if (cell) {
        const refund = snap.run.splitRefund(cell.merge);
        bar.appendChild(el('div', 'merge-preview', `${cellName(cell)} · расщепление на биоматериал`));
        const refundLine = el('div', 'cost-line');
        refundLine.appendChild(el('span', '', 'Возврат: +'));
        refundLine.appendChild(statEl('bio', `${refund} биоматериала`));
        refundLine.appendChild(el('span', '', ` · у тебя ${snap.run.biomass}`));
        bar.appendChild(refundLine);
        const split = el('button', 'primary-btn split-btn', 'Расщепить');
        split.type = 'button';
        split.addEventListener('click', () => {
          mergeSel = [];
          onSplit(cell.id);
        });
        bar.appendChild(split);
      }
    } else {
      bar.appendChild(el('div', 'merge-reason', 'Выбери клетку, чтобы расщепить её, или две совместимые — чтобы слить.'));
    }
  }
}

function cellName(cell) {
  const names = { hunter: 'Охотник', defender: 'Защитник', parasite: 'Паразит', medic: 'Медик' };
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
      const lvl = el('div', 'card-line');
      lvl.appendChild(statEl('lvl', `${it.level}/${it.maxLevel}`));
      info.appendChild(lvl);
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
      const lvl = el('div', 'card-line');
      lvl.appendChild(statEl('lvl', `${it.level}/${it.maxLevel}`));
      info.appendChild(lvl);
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
