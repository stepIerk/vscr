/**
 * Card catalog: every draftable card in one place (data only, no DOM).
 * Add new cards here — draft generation, application and rendering
 * all read from this catalog, so no other logic needs to change.
 *
 * Card: { id, kind: 'cell'|'mutation'|'upgrade', ... }
 */

import { ALLY_TYPES, MUTATIONS, UPGRADES } from '../config.js';

function cellCard(type) {
  const t = ALLY_TYPES[type];
  return {
    id: `cell-${type}`,
    kind: 'cell',
    cellType: type,
    title: `${t.name} cell`,
    tag: 'New cell',
    desc: t.role,
    lines: [
      `ATK ${t.attack} · ${Math.round(1000 / t.attackIntervalMs * 10) / 10}/s`,
      `HP ${t.maxHealth} · SPD ${t.moveSpeed}`
    ]
  };
}

function mutationCard(key) {
  const m = MUTATIONS[key];
  return {
    id: `mut-${key}`,
    kind: 'mutation',
    mutation: key,
    title: m.name,
    tag: 'Mutation',
    desc: `${m.desc}. Applies to hero and/or one cell. Re-pick raises its level.`
  };
}

function upgradeCard(key) {
  const u = UPGRADES[key];
  return {
    id: `up-${key}`,
    kind: 'upgrade',
    upgrade: key,
    title: u.name,
    tag: u.target === 'hero' ? 'Hero upgrade' : 'Colony upgrade',
    desc: u.desc
  };
}

/** All cards, in stable order. */
export const CARDS = [
  cellCard('hunter'),
  cellCard('defender'),
  cellCard('parasite'),
  mutationCard('metabolism'),
  mutationCard('membrane'),
  mutationCard('acid'),
  upgradeCard('pulse'),
  upgradeCard('regen'),
  upgradeCard('adaptation'),
  upgradeCard('sync'),
  upgradeCard('swift')
];

export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

/**
 * Human-readable effect preview for a draft card given current run state.
 * Pure strings — the DOM layer only renders them.
 */
export function describeCard(card, run) {
  if (card.kind === 'cell') {
    const left = run.freeCellSlots();
    return { ...card, levelLine: `Active cells: ${run.cells.length}/${run.maxCells} · free: ${left}` };
  }
  if (card.kind === 'mutation') {
    const heroLvl = run.mutationLevel('hero', card.mutation);
    const maxed = run.mutationMaxedEverywhere(card.mutation);
    return {
      ...card,
      levelLine: `Hero: ${heroLvl > 0 ? `Lv ${heroLvl}` : '—'}${maxed ? ' · all targets maxed' : ''}`
    };
  }
  const lvl = run.upgradeLevel(card.upgrade);
  const max = UPGRADES[card.upgrade].maxLevel;
  return {
    ...card,
    levelLine: lvl > 0 ? `Lv ${lvl} → Lv ${Math.min(lvl + 1, max)}` : `New · max Lv ${max}`
  };
}
