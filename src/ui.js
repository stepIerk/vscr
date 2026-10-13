/**
 * DOM interface layer: HUD (HP + kills) and Game Over overlay.
 * Kept outside Phaser so gameplay scenes stay testable and
 * future mobile controls / menus can reuse this module.
 *
 * All DOM listeners are bound exactly once via `bind()`.
 */

export class UI {
  constructor() {
    this.hpFill = document.getElementById('hp-fill');
    this.hpText = document.getElementById('hp-text');
    this.killsText = document.getElementById('kills-text');
    this.motesText = document.getElementById('motes-text');
    this.plasmaText = document.getElementById('plasma-text');
    this.seedText = document.getElementById('seed-text');
    this.levelText = document.getElementById('level-text');
    this.xpFill = document.getElementById('xp-fill');
    this.xpText = document.getElementById('xp-text');
    this.colonyBtn = document.getElementById('colony-btn');
    this.artifactsBtn = document.getElementById('artifacts-btn');
    this.toastEl = document.getElementById('toast');
    this.bossBar = document.getElementById('boss-bar');
    this.bossName = document.getElementById('boss-name');
    this.bossFill = document.getElementById('boss-fill');
    this._toastTimer = null;
    this.gameoverEl = document.getElementById('gameover');
    this.finalKillsEl = document.getElementById('final-kills');
    this.finalMotesEl = document.getElementById('final-motes');
    this.restartBtn = document.getElementById('restart-btn');
    this._onRestart = null;
    this._bound = false;
    this._onColony = null;
    this._colonyBound = false;
    this._onArtifacts = null;
    this._artifactsBound = false;
  }

  /** Bind restart handler once. Safe to call multiple times. */
  bind(onRestart) {
    this._onRestart = onRestart;
    if (this._bound) return;
    this._bound = true;
    this.restartBtn.addEventListener('click', () => {
      if (this._onRestart) this._onRestart();
    });
  }

  /** Bind colony button once. Safe to call multiple times. */
  bindColony(onColony) {
    this._onColony = onColony;
    if (this._colonyBound) return;
    this._colonyBound = true;
    if (this.colonyBtn) {
      this.colonyBtn.addEventListener('click', () => {
        if (this._onColony) this._onColony();
      });
    }
  }

  /** Bind the artifact inventory button once. Safe to call multiple times. */
  bindArtifacts(onArtifacts) {
    this._onArtifacts = onArtifacts;
    if (this._artifactsBound) return;
    this._artifactsBound = true;
    if (this.artifactsBtn) {
      this.artifactsBtn.addEventListener('click', () => {
        if (this._onArtifacts) this._onArtifacts();
      });
    }
  }

  reset() {
    this.hideGameOver();
    this.hideBoss();
    this.update(100, 100, 0, 0, 0);
    this.setLevel(1, 0, 6);
    this.setColonyCount(0, 5);
    this.setArtifacts(0, 5);
  }

  setSeed(seed) {
    if (this.seedText) this.seedText.textContent = `сид ${seed}`;
  }

  update(hp, maxHp, kills, motes = 0, plasma = 0) {
    const pct = Math.max(0, Math.min(1, hp / maxHp));
    if (this.hpFill) {
      this.hpFill.style.width = `${Math.round(pct * 100)}%`;
      this.hpFill.classList.toggle('low', pct <= 0.3);
    }
    if (this.hpText) this.hpText.textContent = String(Math.max(0, Math.ceil(hp)));
    if (this.killsText) this.killsText.textContent = String(kills);
    if (this.motesText) this.motesText.textContent = String(motes);
    if (this.plasmaText) this.plasmaText.textContent = String(plasma);
  }

  setLevel(level, xp, required) {
    if (this.levelText) this.levelText.textContent = String(level);
    if (this.xpFill) this.xpFill.style.width = `${Math.round((100 * xp) / Math.max(1, required))}%`;
    if (this.xpText) this.xpText.textContent = `${xp}/${required}`;
  }

  setColonyCount(n, max) {
    if (this.colonyBtn) this.colonyBtn.textContent = `Колония (${n}/${max})`;
  }

  setArtifacts(n, max) {
    if (this.artifactsBtn) this.artifactsBtn.textContent = `Артефакты (${n}/${max})`;
  }

  /**
   * Сайд-панель колонии (всегда на виду): герой + активные клетки
   * с картинками, уровнями слияния, HP и мутациями. Клик — открыть колонию.
   */
  renderColonySide(view, onOpen) {
    const box = document.getElementById('colony-side');
    if (!box) return;
    box.classList.remove('hidden');
    box.replaceChildren();
    const mk = (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const hero = mk('div', 'side-hero');
    hero.appendChild(mk('span', 'side-hero-name', `Герой · ур. ${view.hero.level}`));
    hero.appendChild(mk('span', 'side-hero-xp', `опыт ${view.hero.xp}/${view.hero.req}`));
    box.appendChild(hero);
    if (view.stashed > 0) {
      box.appendChild(mk('div', 'side-note', `Колония прячется (${view.stashed}) — идёт бой с боссом`));
    }
    if (!view.cells.length && !view.stashed) {
      box.appendChild(mk('div', 'side-note', 'Колония пуста — клетки дают уровни'));
    }
    for (const c of view.cells) {
      const row = mk('button', 'side-cell');
      row.type = 'button';
      if (c.img) {
        const im = document.createElement('img');
        im.className = 'side-cell-img';
        im.src = c.img;
        im.alt = '';
        row.appendChild(im);
      }
      const info = mk('div', 'side-cell-info');
      info.appendChild(mk('div', 'side-cell-name', `${c.name || ('#' + c.id)}${c.merge > 1 ? ` · слияние ${c.merge}` : ''}`));
      const bar = mk('div', 'side-hp-track');
      const fill = mk('div', 'side-hp-fill');
      fill.style.width = `${Math.round((100 * c.hp) / Math.max(1, c.maxHp))}%`;
      bar.appendChild(fill);
      info.appendChild(bar);
      info.appendChild(mk('div', 'side-cell-sub', `ЗДР ${c.hp}/${c.maxHp} · АТК ${c.attack}`));
      info.appendChild(mk('div', 'side-cell-sub dim',
        c.muts.length ? c.muts.map((m) => `${m.name} ${m.v}`).join(' · ') : 'без мутаций'));
      row.appendChild(info);
      row.addEventListener('click', onOpen);
      box.appendChild(row);
    }
    this._colonySideOpen = onOpen;
  }

  /** Полоска босса сверху экрана: показать, обновить, спрятать. */
  showBoss(name) {
    if (this.bossName) this.bossName.textContent = String(name).toUpperCase();
    if (this.bossFill) this.bossFill.style.width = '100%';
    if (this.bossBar) this.bossBar.classList.remove('hidden');
  }

  setBossHp(hp, maxHp) {
    if (!this.bossFill) return;
    const pct = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));
    this.bossFill.style.width = `${Math.round(pct * 100)}%`;
  }

  hideBoss() {
    if (this.bossBar) this.bossBar.classList.add('hidden');
  }

  /** Brief bottom-center notice (expansion grown, etc.). Fire-and-forget. */
  toast(text, ms = 3200) {
    if (!this.toastEl) return;
    this.toastEl.textContent = text;
    this.toastEl.classList.remove('hidden');
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toastEl.classList.add('hidden'), ms);
  }

  showGameOver(kills, motes = 0) {
    if (this.finalKillsEl) this.finalKillsEl.textContent = String(kills);
    if (this.finalMotesEl) this.finalMotesEl.textContent = String(motes);
    if (this.finalKillsEl) this.finalKillsEl.textContent = String(kills);
    if (this.gameoverEl) this.gameoverEl.classList.remove('hidden');
  }

  hideGameOver() {
    if (this.gameoverEl) this.gameoverEl.classList.add('hidden');
  }
}

export const ui = new UI();
