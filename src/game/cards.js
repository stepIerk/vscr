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
  const power = type === 'medic'
    ? { icon: 'regen', value: `+${t.attack}` } // медик: сила лечения, не урон
    : { icon: 'atk', value: String(t.attack) };
  return {
    id: `cell-${type}`,
    kind: 'cell',
    cellType: type,
    title: `Клетка: ${t.name}`,
    tag: 'Новая клетка',
    desc: t.role,
    // Характеристики: иконка + значение (иконки — Tabler, см. ui/icons.js).
    stats: [
      [
        power,
        { icon: 'atkSpeed', value: `${Math.round(1000 / t.attackIntervalMs * 10) / 10}/с` }
      ],
      [
        { icon: 'hp', value: String(t.maxHealth) },
        { icon: 'spd', value: String(t.moveSpeed) }
      ]
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
    tag: 'Мутация',
    desc: `${m.desc}. Действует на героя и/или одну клетку. Повторный выбор растит уровень.`
  };
}

function upgradeCard(key) {
  const u = UPGRADES[key];
  return {
    id: `up-${key}`,
    kind: 'upgrade',
    upgrade: key,
    title: u.name,
    tag: u.target === 'hero' ? 'Улучшение героя' : u.target === 'colony' ? 'Улучшение колонии' : 'Улучшение',
    desc: u.desc
  };
}

/**
 * All cards, in stable order. Mutations and upgrades are generated from the
 * config tables, so adding a config entry automatically creates its card.
 */
export const CARDS = [
  cellCard('hunter'),
  cellCard('defender'),
  cellCard('parasite'),
  cellCard('medic'),
  ...Object.keys(MUTATIONS).map(mutationCard),
  ...Object.keys(UPGRADES).map(upgradeCard)
];

export const CARD_BY_ID = Object.fromEntries(CARDS.map((c) => [c.id, c]));

/**
 * Human-readable effect preview for a draft card given current run state.
 * Pure strings — the DOM layer only renders them.
 */
export function describeCard(card, run) {
  if (card.kind === 'cell') {
    const left = run.freeCellSlots();
    return { ...card, levelLine: `Клеток: ${run.cells.length}/${run.maxCells} · свободно: ${left}` };
  }
  if (card.kind === 'mutation') {
    const heroLvl = run.mutationLevel('hero', card.mutation);
    const maxed = run.mutationMaxedEverywhere(card.mutation);
    return {
      ...card,
      levelLine: `Герой: ${heroLvl > 0 ? `ур. ${heroLvl}` : '—'}${maxed ? ' · везде максимум' : ''}`
    };
  }
  const lvl = run.upgradeLevel(card.upgrade);
  const max = UPGRADES[card.upgrade].maxLevel;
  return {
    ...card,
    levelLine: lvl > 0 ? `Ур. ${lvl} → ур. ${Math.min(lvl + 1, max)}` : `Новое · макс. ур. ${max}`
  };
}
