/**
 * Progression panels: level-up draft, mutation target picker, colony window.
 * Pure DOM (works on desktop + touch); game state stays in RunState —
 * this module only renders snapshots and forwards clicks to scene callbacks.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function overlay(id) {
  let o = document.getElementById(id);
  if (!o) {
    o = el('div', 'overlay hidden');
    o.id = id;
    document.getElementById('app').appendChild(o);
  }
  return o;
}

// ------------------------------------------------------------------- draft

export function showDraft({ level, cards, onPick }) {
  const o = overlay('draft-overlay');
  o.classList.remove('hidden');
  o.replaceChildren();
  const box = el('div', 'panel draft-panel');
  box.appendChild(el('h2', 'panel-title', `LEVEL ${level} — choose one`));
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
  const o = overlay('target-overlay');
  o.classList.remove('hidden');
  o.replaceChildren();
  const box = el('div', 'panel target-panel');
  box.appendChild(el('h2', 'panel-title', title));
  box.appendChild(el('div', 'panel-sub', 'Apply to:'));
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
  const cancel = el('button', 'ghost-btn', 'Back');
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
  head.appendChild(el('h2', 'panel-title', 'Colony'));
  const close = el('button', 'ghost-btn', 'Close');
  close.type = 'button';
  close.addEventListener('click', () => {
    mergeSel = [];
    onClose();
  });
  head.appendChild(close);
  box.appendChild(head);

  // --- cells ---
  box.appendChild(el('h3', 'section-title', `Cells (${snap.run.cells.length}/${snap.run.maxCells})`));
  const grid = el('div', 'colony-grid');
  if (!snap.cells.length) grid.appendChild(el('div', 'empty-note', 'No cells yet — draft new ones on level-up.'));
  for (const { cell, stats } of snap.cells) {
    const b = el('button', 'colony-card' + (mergeSel.includes(cell.id) ? ' selected' : ''));
    b.type = 'button';
    const nm = cellName(snap, cell);
    b.appendChild(el('div', 'card-title', `${nm}${cell.merge > 1 ? ` · merge ${cell.merge}` : ''}`));
    b.appendChild(el('div', 'card-line', `HP ${Math.ceil(cell.hp)}/${stats.maxHealth}`));
    b.appendChild(
      el('div', 'card-line', `ATK ${round1(stats.attack)} · ${round1(stats.attackSpeed)}/s · SPD ${Math.round(stats.moveSpeed)}`)
    );
    const muts = Object.entries(cell.mutations);
    b.appendChild(el('div', 'card-line dim', muts.length ? `Mutations: ${muts.map(([k, v]) => `${k} ${v}`).join(', ')}` : 'No mutations'));
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
          `Merge → ${cellName(snap, a)} merge ${a.merge + 1} · HP ${after.maxHealth} · ATK ${round1(after.attack)} · cells ${snap.run.cells.length} → ${snap.run.cells.length - 1}`)
      );
      const go = el('button', 'primary-btn', 'Merge cells');
      go.type = 'button';
      go.addEventListener('click', () => {
        mergeSel = [];
        onMerge(a.id, b.id);
      });
      bar.appendChild(go);
    } else {
      bar.appendChild(el('div', 'merge-reason', `Cannot merge: ${chk.reason}`));
    }
  } else {
    bar.appendChild(el('div', 'merge-reason', 'Select two cells to merge (same type, merge level and mutations).'));
  }
  box.appendChild(bar);

  // --- mutations ---
  box.appendChild(el('h3', 'section-title', 'Mutations'));
  const ml = el('div', 'flat-list');
  const heroMuts = Object.entries(snap.run.heroMutations);
  ml.appendChild(el('div', 'flat-row', heroMuts.length ? `Hero: ${heroMuts.map(([k, v]) => `${k} ${v}`).join(', ')}` : 'Hero: none'));
  for (const { cell } of snap.cells) {
    const ms = Object.entries(cell.mutations);
    ml.appendChild(el('div', 'flat-row', `#${cell.id} ${cellName(snap, cell)}: ${ms.length ? ms.map(([k, v]) => `${k} ${v}`).join(', ') : 'none'}`));
  }
  box.appendChild(ml);

  // --- upgrades ---
  box.appendChild(el('h3', 'section-title', 'Upgrades'));
  const ul = el('div', 'flat-list');
  const ups = Object.entries(snap.run.upgrades);
  if (!ups.length) ul.appendChild(el('div', 'flat-row', 'None yet.'));
  for (const [k, v] of ups) ul.appendChild(el('div', 'flat-row', `${k}: Lv ${v}`));
  box.appendChild(ul);

  // --- hero line ---
  const h = snap.hero;
  box.appendChild(
    el('div', 'hero-line',
      `Hero ${snap.run.level} · HP ${Math.ceil(snap.heroHp)}/${h.maxHealth} · ATK ${round1(h.attack)} · ${round1(h.attackSpeed)}/s · SPD ${Math.round(h.moveSpeed)}${h.regen > 0 ? ` · +${round1(h.regen)}/s` : ''}`)
  );
  o.appendChild(box);
}

function cellName(snap, cell) {
  void snap;
  const names = { hunter: 'Hunter', defender: 'Defender', parasite: 'Parasite' };
  return `${names[cell.type] || cell.type} #${cell.id}`;
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

/** Инвентарь артефактов: список активных слотов и включение/выключение. */
export function showArtifacts(view, { onToggle, onClose }) {
  const o = overlay('artifacts-overlay');
  o.classList.remove('hidden');
  o.replaceChildren();
  const box = el('div', 'panel colony-panel');
  const head = el('div', 'colony-head');
  const t = el('div');
  t.appendChild(el('h2', 'panel-title', 'Артефакты'));
  t.appendChild(el('div', 'panel-sub', `Активные слоты: ${view.used}/${view.slots} · плазма: ${view.plasma}`));
  head.appendChild(t);
  const close = el('button', 'ghost-btn', 'Закрыть');
  close.type = 'button';
  close.addEventListener('click', onClose);
  head.appendChild(close);
  box.appendChild(head);
  const grid = el('div', 'colony-grid');
  if (!view.items.length) {
    grid.appendChild(el('div', 'empty-note', 'Нет артефактов.'));
  }
  for (const it of view.items) {
    const b = el('button', `colony-card artifact${it.active ? ' selected' : ''}`);
    b.type = 'button';
    b.appendChild(
      el('div', 'card-title',
        `${it.name}${it.level > 0 ? ` · ур. ${it.level}/${it.maxLevel}` : ' · не получен'}`)
    );
    b.appendChild(el('div', 'card-line dim', it.desc));
    b.appendChild(el('div', 'card-line', it.level > 0 ? (it.active ? 'Активен' : 'Выключен') : 'Можно купить в лавке'));
    b.disabled = it.level === 0;
    if (it.level > 0) {
      b.addEventListener('click', () => onToggle(it.id, !it.active));
    }
    grid.appendChild(b);
  }
  box.appendChild(grid);
  box.appendChild(
    el('div', 'merge-reason',
      view.used >= view.slots
        ? 'Все слоты заняты — выключите артефакт, чтобы включить другой.'
        : 'Нажмите на артефакт, чтобы включить или выключить его.'
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
