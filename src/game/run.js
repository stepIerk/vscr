/**
 * RunState: everything progression owns for one run — level/XP, colony,
 * mutations and upgrades. Framework-free (no Phaser), fully testable.
 *
 * Stat semantics (project-wide): attackSpeed = attacks per second,
 * intervalMs = 1000 / attackSpeed. Computed stats are derived on demand
 * from base + merge + mutations + upgrades — bases are never mutated,
 * bonuses are never applied twice.
 */

import {
  HERO_BASE, ALLY_TYPES, MUTATIONS, UPGRADES, ALLIES,
  PROGRESSION, requiredBiomass, PLASMA, ARTIFACTS, RESOURCE, WEAPON
} from '../config.js';
import { CARDS } from './cards.js';
import { artifactSum, artifactPct, artifactLevel } from './artifacts.js';

const RESOURCE_PICKUP = RESOURCE.pickupRadius;
const WEAPON_RANGE = WEAPON.range;

let uid = 1;

export class RunState {
  constructor() {
    this.reset();
  }

  reset() {
    this.level = 1;
    this.xp = 0; // biomass progress toward the NEXT level (surplus kept)
    this.plasma = PLASMA.startAmount; // вторая валюта (лавки)
    this.artifacts = {}; // artifactId -> level (0 = not owned)
    this.activeArtifacts = []; // up to ARTIFACTS.slots ids
    this.cells = []; // live instances: {id,type,merge,...}
    this.nextCellId = 1;
    this.heroMutations = {}; // key -> level
    this.upgrades = {}; // key -> level
    this.maxCells = ALLIES.max;
    this.shopVisits = 0; // сколько раз игрок заходил в любую лавку (наценка)
  }

  // ------------------------------------------------------------ XP / level

  requiredXp() {
    return requiredBiomass(this.level);
  }

  /** Add biomass; returns how many levels were gained (surplus xp kept). */
  addXp(n) {
    this.xp += n;
    let gained = 0;
    while (this.xp >= this.requiredXp() && gained < PROGRESSION.maxQueuedLevels) {
      this.xp -= this.requiredXp();
      this.level += 1;
      gained += 1;
    }
    return gained;
  }

  // -------------------------------------------------------------- cells

  freeCellSlots() {
    return Math.max(0, this.maxCells - this.cells.length);
  }

  addCell(type) {
    if (this.freeCellSlots() <= 0) return null;
    const cell = { id: this.nextCellId++, type, merge: 1, mutations: {}, hp: null, cd: 0, target: null, path: null };
    const st = this.computeCell(cell);
    cell.hp = st.maxHealth;
    this.cells.push(cell);
    return cell;
  }

  getCell(id) {
    return this.cells.find((c) => c.id === id) || null;
  }

  removeCell(id) {
    const i = this.cells.findIndex((c) => c.id === id);
    if (i >= 0) this.cells.splice(i, 1);
  }

  static sameMutations(a, b) {
    const ka = Object.keys(a.mutations).sort();
    const kb = Object.keys(b.mutations).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k) => a.mutations[k] === b.mutations[k]);
  }

  /** Compatibility check with a human reason (shown in the colony UI). */
  mergeCheck(a, b) {
    if (!a || !b) return { ok: false, reason: 'Выбери две клетки.' };
    if (a.id === b.id) return { ok: false, reason: 'Нужны две разные клетки.' };
    if (a.type !== b.type) return { ok: false, reason: 'Только клетки одного вида.' };
    if (a.merge !== b.merge) return { ok: false, reason: 'Только клетки одного уровня слияния.' };
    if (a.merge >= ALLIES.maxMerge) return { ok: false, reason: `Уровень ${ALLIES.maxMerge} — максимальный.` };
    if (!RunState.sameMutations(a, b)) return { ok: false, reason: 'Разные наборы мутаций — слияние потеряет свойства.' };
    return { ok: true, reason: '' };
  }

  /** Merge b into a: a grows a merge level, b is consumed, one slot frees up. */
  mergeCells(aId, bId) {
    const a = this.getCell(aId);
    const b = this.getCell(bId);
    const chk = this.mergeCheck(a, b);
    if (!chk.ok) return null;
    this.removeCell(bId);
    a.merge += 1;
    a.hp = this.computeCell(a).maxHealth; // reinforced body, full health
    return a;
  }

  // --------------------------------------------------- mutations/upgrades

  mutationLevel(scope, key, cellId = null) {
    if (scope === 'hero') return this.heroMutations[key] || 0;
    const cell = this.getCell(cellId);
    return cell ? cell.mutations[key] || 0 : 0;
  }

  /** True when every legal target already has this mutation maxed. */
  mutationMaxedEverywhere(key) {
    const max = MUTATIONS[key].maxLevel;
    if ((this.heroMutations[key] || 0) < max) return false;
    return this.cells.every((c) => (c.mutations[key] || 0) >= max);
  }

  applyMutation(key, target) {
    const max = MUTATIONS[key].maxLevel;
    if (target.scope === 'hero') {
      this.heroMutations[key] = Math.min(max, (this.heroMutations[key] || 0) + 1);
      return { scope: 'hero', level: this.heroMutations[key] };
    }
    const cell = this.getCell(target.id);
    if (!cell) return null;
    cell.mutations[key] = Math.min(max, (cell.mutations[key] || 0) + 1);
    if (key === 'membrane') cell.hp += MUTATIONS.membrane.healthBonus; // grow into new tissue
    return { scope: 'cell', id: cell.id, level: cell.mutations[key] };
  }

  upgradeLevel(key) {
    return this.upgrades[key] || 0;
  }

  applyUpgrade(key) {
    const max = UPGRADES[key].maxLevel;
    this.upgrades[key] = Math.min(max, (this.upgrades[key] || 0) + 1);
    // «Рой» расширяет лимит клеток сразу (draft/colony/HUD читают maxCells).
    if (key === 'swarm') this.maxCells = ALLIES.max + this.upgrades.swarm;
    return this.upgrades[key];
  }

  /** Apply a draft card. For mutations without a fixed target, pass target too. */
  applyCard(card, target = null) {
    if (card.kind === 'cell') return this.addCell(card.cellType);
    if (card.kind === 'upgrade') return this.applyUpgrade(card.upgrade);
    if (card.kind === 'mutation') {
      if (!target) return null; // UI must ask for hero/cell first
      return this.applyMutation(card.mutation, target);
    }
    return null;
  }

  // ---------------------------------------------------------------- plasma

  addPlasma(n) {
    this.plasma += n;
    return this.plasma;
  }

  spendPlasma(n) {
    if (this.plasma < n) return false;
    this.plasma -= n;
    return true;
  }

  // -------------------------------------------------------------- artifacts

  /** Buy/level an artifact: acquires it and activates it if a slot is free. */
  buyArtifact(id, def) {
    const max = def ? def.maxLevel : ARTIFACTS.maxLevel;
    this.artifacts[id] = Math.min(max, (this.artifacts[id] || 0) + 1);
    if (!this.activeArtifacts.includes(id) && this.activeArtifacts.length < ARTIFACTS.slots) {
      this.activeArtifacts.push(id);
      return { leveled: true, activated: true };
    }
    return { leveled: true, activated: this.activeArtifacts.includes(id) };
  }

  /** Toggle artifact into an active slot. Never exceeds the slot limit. */
  setArtifactActive(id, on) {
    const has = this.activeArtifacts.includes(id);
    if (on) {
      if (has) return { ok: true };
      if (this.activeArtifacts.length >= ARTIFACTS.slots) {
        return { ok: false, reason: `Активных артефактов не больше ${ARTIFACTS.slots}` };
      }
      this.activeArtifacts.push(id);
      return { ok: true };
    }
    this.activeArtifacts = this.activeArtifacts.filter((x) => x !== id);
    return { ok: true };
  }

  // ----------------------------------------------------------------- stats

  computeHero() {
    const mut = (k) => this.heroMutations[k] || 0;
    const up = (k) => this.upgrades[k] || 0;
    // База + улучшения (процентные), затем мутации (плоские), затем артефакты.
    let attack =
      (HERO_BASE.attack * (1 + UPGRADES.pulse.perLevel * up('pulse')) +
        MUTATIONS.acid.damageBonus * mut('acid') +
        artifactSum(this, 'attack'));
    const apsBase = (1000 / HERO_BASE.attackIntervalMs) * (1 + MUTATIONS.metabolism.speedBonus * mut('metabolism'));
    const aps = apsBase * (1 + artifactPct(this, 'attackSpeedPct'));
    const maxHealth =
      HERO_BASE.maxHealth +
      MUTATIONS.membrane.healthBonus * mut('membrane') +
      artifactSum(this, 'health');
    return {
      attack,
      intervalMs: 1000 / aps,
      attackSpeed: aps,
      moveSpeed: HERO_BASE.moveSpeed * (1 + UPGRADES.swift.perLevel * up('swift')) * (1 + artifactPct(this, 'moveSpeedPct')),
      maxHealth,
      regen: UPGRADES.regen.perLevel * up('regen') + artifactSum(this, 'regen'),
      pickupRadius: Math.round(RESOURCE_PICKUP * (1 + artifactPct(this, 'pickupPct'))),
      attackRange: Math.round(WEAPON_RANGE * (1 + artifactPct(this, 'rangePct'))),
      thorns: artifactSum(this, 'thorns'),
      leech: artifactSum(this, 'leech')
    };
  }

  computeCell(cell) {
    const base = ALLY_TYPES[cell.type];
    const mm = Math.pow(1 + ALLIES.mergeBonus, cell.merge - 1);
    const sm = 1 + ALLIES.mergeSpeedBonus * (cell.merge - 1);
    const mut = (k) => cell.mutations[k] || 0;
    const up = (k) => this.upgrades[k] || 0;
    const baseAps = 1000 / base.attackIntervalMs;
    const aps =
      baseAps * sm *
      (1 + MUTATIONS.metabolism.speedBonus * mut('metabolism')) *
      (1 + UPGRADES.sync.perLevel * up('sync'));
    return {
      attack: base.attack * mm + MUTATIONS.acid.damageBonus * mut('acid'),
      intervalMs: 1000 / aps,
      attackSpeed: aps,
      moveSpeed: base.moveSpeed * sm,
      maxHealth: Math.round(base.maxHealth * mm * (1 + UPGRADES.adaptation.perLevel * up('adaptation')) + MUTATIONS.membrane.healthBonus * mut('membrane')),
      range: base.range,
      bodyR: base.bodyR
    };
  }

  // ----------------------------------------------------------------- draft

  /** Mutation card offered only while some legal target isn't maxed. */
  mutationAvailable(key) {
    return !this.mutationMaxedEverywhere(key);
  }

  upgradeAvailable(key) {
    return (this.upgrades[key] || 0) < UPGRADES[key].maxLevel;
  }

  /** Shop visit counter grows with every shop entry (affects prices). */
  noteShopVisit() {
    this.shopVisits += 1;
    return this.shopVisits;
  }

  /** Three distinct, currently meaningful options. Never an invalid card. */
  draftOptions(random = Math.random) {
    const pool = [];
    if (this.freeCellSlots() > 0) {
      const w = this.cells.length === 0 ? 5 : 1.5; // push first cells hard
      for (const t of Object.keys(ALLY_TYPES)) pool.push({ card: `cell-${t}`, w });
    }
    for (const k of Object.keys(MUTATIONS)) {
      if (this.mutationAvailable(k)) pool.push({ card: `mut-${k}`, w: 1 });
    }
    for (const k of Object.keys(UPGRADES)) {
      if (this.upgradeAvailable(k)) pool.push({ card: `up-${k}`, w: 1 });
    }
    const picked = [];
    const rest = [...pool];
    while (picked.length < 3 && rest.length) {
      const total = rest.reduce((s, e) => s + e.w, 0);
      let roll = random() * total;
      let idx = 0;
      for (; idx < rest.length; idx++) {
        roll -= rest[idx].w;
        if (roll <= 0) break;
      }
      idx = Math.min(idx, rest.length - 1);
      picked.push(rest[idx].card);
      rest.splice(idx, 1);
    }
    const byId = Object.fromEntries(CARDS.map((c) => [c.id, c]));
    return picked.map((id) => byId[id]);
  }
}
