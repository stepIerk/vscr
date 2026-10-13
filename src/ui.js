/**
 * DOM interface layer: terminal-style HUD, bottom command panel (colony hex
 * strip + menu buttons), contextual action key and Game Over overlay.
 * Kept outside Phaser so gameplay scenes stay testable and future mobile
 * controls / menus can reuse this module.
 *
 * All DOM listeners are bound exactly once via `bind*()`.
 */

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

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
    this.colonyCount = document.getElementById('colony-count');
    this.colonyNote = document.getElementById('colony-note');
    this.colonyStrip = document.getElementById('colony-strip');
    this.invCount = document.getElementById('inv-count');
    this.actionBtn = document.getElementById('action-btn');
    this.actKey = document.getElementById('act-key');
    this.actLabel = document.getElementById('act-label');
    this.actSub = document.getElementById('act-sub');
    this.bottomBar = document.getElementById('bottom-bar');
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
    this._onAction = null;
    this._actionBound = false;
    this._actionSig = null;
    this._stripSig = null;
    this._syncBar();
    window.addEventListener('resize', () => this._syncBar());
    window.addEventListener('orientationchange', () => this._syncBar());
    window.addEventListener('load', () => this._syncBar());
    // CSS приезжает позже модулей — следим за размером панели напрямую.
    if (typeof ResizeObserver !== 'undefined' && this.bottomBar) {
      new ResizeObserver(() => this._syncBar()).observe(this.bottomBar);
    }
  }

  /**
   * Высота нижней панели живёт в CSS-переменной: от неё зависят позиции
   * джойстика, тоста и контекстной кнопки.
   */
  _syncBar() {
    const h = this.bottomBar ? Math.round(this.bottomBar.offsetHeight) : 0;
    if (h > 0) document.documentElement.style.setProperty('--bar-h', `${h}px`);
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

  /** Bind the contextual action button (E) once. */
  bindAction(onAction) {
    this._onAction = onAction;
    if (this._actionBound) return;
    this._actionBound = true;
    if (this.actionBtn) {
      const fire = (e) => {
        e.preventDefault();
        if (this._onAction) this._onAction();
      };
      this.actionBtn.addEventListener('click', fire);
    }
  }

  /**
   * Контекстная кнопка: живёт только пока действие возможно
   * (например, рядом со стендом лавки). Повторные вызовы — no-op.
   */
  showAction({ key = 'E', label = '', sub = '', ok = true } = {}) {
    if (!this.actionBtn) return;
    const sig = `${key}|${label}|${sub}|${ok}`;
    if (sig === this._actionSig && !this.actionBtn.classList.contains('hidden')) return;
    this._actionSig = sig;
    if (this.actKey) this.actKey.textContent = key;
    if (this.actLabel) this.actLabel.textContent = label;
    if (this.actSub) this.actSub.textContent = sub;
    this.actionBtn.classList.toggle('no-plasma', !ok);
    this.actionBtn.classList.remove('hidden');
  }

  hideAction() {
    if (!this.actionBtn || this._actionSig === null) return;
    this._actionSig = null;
    this.actionBtn.classList.add('hidden');
  }

  reset() {
    this.hideGameOver();
    this.hideBoss();
    this.hideAction();
    this.update(100, 100, 0, 0, 0);
    this.setLevel(1, 0, 6);
    this.setColonyCount(0, 5);
    this.setArtifacts(0, 5);
    this._stripSig = null;
    if (this.colonyStrip) this.colonyStrip.replaceChildren();
    if (this.colonyNote) this.colonyNote.classList.add('hidden');
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
    if (this.colonyCount) this.colonyCount.textContent = `${n}/${max}`;
  }

  setArtifacts(n, max) {
    if (this.invCount) this.invCount.textContent = `${n}/${max}`;
    if (this.artifactsBtn) this.artifactsBtn.classList.toggle('has-items', n > 0);
  }

  /**
   * Гекс-лента колонии под джойстиком: картинка клетки, бейдж уровня
   * слияния и полоска здоровья. Пустые слоты видны как пунктирные гексы.
   * Клик по занятому — открыть окно колонии (скрещивание, мутации).
   */
  renderColonyStrip(view, onOpen) {
    const box = this.colonyStrip;
    if (!box) return;
    const cells = view.cells || [];
    const max = Math.max(view.maxCells || 5, cells.length);
    const sig =
      `${max}|${view.stashed || 0}|` +
      cells.map((c) => `${c.id}:${Math.ceil(c.hp)}:${c.maxHp}:${c.merge}`).join(',');
    if (sig === this._stripSig) return;
    this._stripSig = sig;

    if (this.colonyNote) {
      if (view.stashed > 0) {
        this.colonyNote.textContent = `свёрнуто ${view.stashed}`;
        this.colonyNote.classList.remove('hidden');
      } else {
        this.colonyNote.classList.add('hidden');
      }
    }

    box.replaceChildren();
    const byIndex = cells.slice(0, max);
    for (let i = 0; i < max; i++) {
      const c = byIndex[i];
      if (!c) {
        const empty = document.createElement('span');
        empty.className = 'hex empty';
        empty.setAttribute('aria-hidden', 'true');
        const frame = document.createElement('span');
        frame.className = 'hex-frame';
        const inner = document.createElement('span');
        inner.className = 'hex-in';
        const plus = document.createElement('span');
        plus.className = 'hex-plus';
        plus.textContent = '+';
        inner.appendChild(plus);
        frame.appendChild(inner);
        empty.appendChild(frame);
        box.appendChild(empty);
        continue;
      }
      box.appendChild(this._hexCell(c, onOpen));
    }
  }

  _hexCell(c, onOpen) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hex';
    const pct = Math.max(0, Math.min(1, (c.hp || 0) / Math.max(1, c.maxHp)));
    const low = pct <= 0.3;
    b.setAttribute('aria-label',
      `${c.name || 'клетка'} · уровень ${c.merge} · здоровье ${Math.ceil(c.hp)} из ${c.maxHp}`);

    const frame = document.createElement('span');
    frame.className = 'hex-frame';
    const inner = document.createElement('span');
    inner.className = 'hex-in';

    if (c.img) {
      const im = document.createElement('img');
      im.className = 'hex-img';
      im.src = c.img;
      im.alt = '';
      inner.appendChild(im);
    }

    const badge = document.createElement('span');
    badge.className = 'hex-badge';
    badge.textContent = ROMAN[Math.min(Math.max(1, c.merge || 1), ROMAN.length) - 1];
    inner.appendChild(badge);

    const hp = document.createElement('span');
    hp.className = 'hex-hp';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(pct * 100)}%`;
    if (low) fill.className = 'low';
    hp.appendChild(fill);
    inner.appendChild(hp);

    frame.appendChild(inner);
    b.appendChild(frame);
    b.addEventListener('click', onOpen);
    return b;
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

  /** Brief notice above the command bar. Fire-and-forget. */
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
    if (this.gameoverEl) this.gameoverEl.classList.remove('hidden');
  }

  hideGameOver() {
    if (this.gameoverEl) this.gameoverEl.classList.add('hidden');
  }
}

export const ui = new UI();
