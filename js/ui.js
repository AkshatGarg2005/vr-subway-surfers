// DOM menus and the normal-screen HUD. (The VR HUD lives in js/hud3d.js.)
import { POWERUPS, VR_SPEEDS, PLATFORM, saveSettings } from './config.js';

const $ = (id) => document.getElementById(id);

const CHIP_TEXT = {
  sound: (s) => ['Sound', s.sound ? 'On' : 'Off', !s.sound],
  hints: (s) => ['Hints', s.hints ? 'On' : 'Off', !s.hints],
  camera: (s) => ['Camera', s.camera === 'fp' ? 'First person' : 'Chase', false],
  sensitivity: (s) => ['Body sensing', { low: 'Low', normal: 'Normal', high: 'High' }[s.sensitivity], false],
  vrSpeed: (s) => ['VR speed', { gentle: 'Gentle', normal: 'Normal', brisk: 'Brisk', fast: 'Fast' }[s.vrSpeed], false],
  vignette: (s) => ['Comfort vignette', s.vignette ? 'On' : 'Off', !s.vignette],
};
const CYCLE = {
  sound: [true, false],
  hints: [true, false],
  camera: ['chase', 'fp'],
  sensitivity: ['low', 'normal', 'high'],
  vrSpeed: Object.keys(VR_SPEEDS),
  vignette: [true, false],
};

export class UI {
  constructor(game, settings, handlers) {
    this.game = game;
    this.settings = settings;
    this.h = handlers;
    this.el = {
      loading: $('loading'), loadbar: $('loadbar'), loadmsg: $('loadmsg'),
      title: $('title'), hud: $('hud'), pause: $('pause'), over: $('over'), rotate: $('rotate'),
      sensorHelp: $('sensorHelp'), vrbar: $('vrbar'), hint: $('hint'), countdown: $('countdown'),
      score: $('hudScore'), mult: $('hudMult'), dist: $('hudDist'), coins: $('hudCoins'), powers: $('powers'),
      stumble: $('stumbleWarn'), flash: $('flash'), debug: $('debug'), best: $('bestScore'),
    };
    this.hintSpan = this.el.hint.querySelector('span');
    this.last = { score: -1, mult: -1, dist: -1, coins: -1, hint: '', phase: '', powers: '' };
    this.powerEls = {};

    const click = (id, fn) => $(id).addEventListener('click', (e) => { e.preventDefault(); fn(e); });
    click('btnPlay', () => this.h.play());
    click('btnCardboard', () => this.h.cardboard());
    click('btnXR', () => this.h.xr());
    click('btnPause', () => game.pause());
    click('btnVRPause', () => game.pause());
    click('btnResume', () => game.resume());
    click('btnQuit', () => this.h.quit());
    click('btnRecenter', () => { this.h.recenter(); game.resume(); });
    click('btnRecal', () => { this.hide('pause'); this.h.recalibrate(); });
    click('btnAgain', () => this.h.again());
    click('btnMenu', () => this.h.quit());
    click('btnExitVR', () => this.h.quit());
    click('btnNoSensing', () => this.h.noSensing());
    click('btnSensorRetry', () => this.h.sensorRetry());
    // Taps on the game-over panel background also restart.
    this.el.over.addEventListener('pointerdown', (e) => { if (e.target === this.el.over) this.h.again(); });

    for (const chip of document.querySelectorAll('.chip')) {
      chip.addEventListener('click', () => {
        const k = chip.dataset.set;
        const opts = CYCLE[k];
        const i = opts.indexOf(this.settings[k]);
        this.settings[k] = opts[(i + 1) % opts.length];
        saveSettings(this.settings);
        this.renderChips();
        this.h.settingsChanged && this.h.settingsChanged(k);
      });
    }
    this.renderChips();
    this.el.best.textContent = (game.best | 0).toLocaleString();
    if (PLATFORM.mobile && !PLATFORM.secure) $('httpWarn').classList.remove('hidden');

    game.on('start', () => this.onStart());
    game.on('pause', () => this.show('pause'));
    game.on('resume', () => this.hide('pause'));
    game.on('menu', () => this.onMenu());
    game.on('over', (r) => this.onOver(r));
    game.on('stumble', () => this._stumbleBanner());
    game.on('go', () => this.el.countdown.classList.add('hidden'));
    game.on('countdown', (n) => {
      if (this.game.mode !== 'screen') return; // VR shows it in the 3D HUD
      const c = this.el.countdown;
      c.classList.remove('hidden');
      if (c.textContent !== String(n)) c.textContent = n > 0 ? n : 'GO';
    });
  }

  renderChips() {
    for (const chip of document.querySelectorAll('.chip')) {
      const [label, val, off] = CHIP_TEXT[chip.dataset.set](this.settings);
      chip.innerHTML = `${label}: <b>${val}</b>`;
      chip.classList.toggle('off', off);
    }
  }

  setLoading(frac, msg) {
    this.el.loadbar.style.width = Math.round(frac * 100) + '%';
    if (msg) this.el.loadmsg.textContent = msg;
  }

  show(name) { this.el[name].classList.add('show'); }
  hide(name) { this.el[name].classList.remove('show'); }

  showTitle() {
    this.hide('loading');
    this.show('title');
    this.el.best.textContent = (this.game.best | 0).toLocaleString();
  }

  showXRButton(on) { $('btnXR').classList.toggle('hidden', !on); }

  onStart() {
    for (const s of ['title', 'over', 'pause']) this.hide(s);
    const vr = this.game.mode !== 'screen';
    this.el.hud.classList.toggle('hidden', vr);
    this.el.vrbar.classList.toggle('hidden', this.game.mode !== 'cardboard');
    document.body.classList.toggle('vrmode', vr);
    document.body.classList.toggle('cardboard', this.game.mode === 'cardboard');
    this.last.score = this.last.coins = this.last.dist = this.last.mult = -1;
    this.last.powers = '';
    this.el.stumble.classList.add('hidden');
  }

  onMenu() {
    for (const s of ['over', 'pause', 'rotate', 'sensorHelp']) this.hide(s);
    this.el.hud.classList.add('hidden');
    this.el.vrbar.classList.add('hidden');
    this.el.countdown.classList.add('hidden');
    this._hint(null, null);
    document.body.classList.remove('vrmode');
    this.showTitle();
  }

  onOver(r) {
    $('overReason').textContent = r.reason || 'Busted!';
    $('overScore').textContent = (r.score | 0).toLocaleString();
    $('overDist').textContent = Math.floor(r.s).toLocaleString() + ' m';
    $('overCoins').textContent = r.coins.toLocaleString();
    $('overBest').classList.toggle('hidden', !r.newBest);
    this._hint(null, null);
    if (this.game.mode === 'screen') this.show('over');
  }

  _stumbleBanner() {
    const el = this.el.stumble;
    el.classList.remove('hidden');
    clearTimeout(this._stT);
    this._stT = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  _hint(kind, phase) {
    const key = kind ? kind + phase : '';
    if (key === this.last.hint) return;
    this.last.hint = key;
    const el = this.el.hint;
    el.classList.remove('ready', 'now');
    if (!kind || phase === 'done') return;
    const text = { jump: 'Jump ▲', roll: 'Roll ▼', left: '◀ Step left', right: 'Step right ▶' }[kind];
    if (this.hintSpan.textContent !== text) this.hintSpan.textContent = text;
    el.classList.add(phase);
  }

  // Per frame: only touch the DOM when a value changes.
  update() {
    const g = this.game, r = g.run, L = this.last;
    if (!r || g.mode !== 'screen') { if (g.mode !== 'screen') this._hint(null, null); return; }
    const score = Math.floor(r.score);
    if (score !== L.score) { L.score = score; this.el.score.textContent = score.toLocaleString(); }
    if (r.mult !== L.mult) { L.mult = r.mult; this.el.mult.textContent = '×' + (r.mult * (r.power.double > 0 ? 2 : 1)); }
    const dist = Math.floor(r.s);
    if (dist !== L.dist) { L.dist = dist; this.el.dist.textContent = dist.toLocaleString(); }
    if (r.coins !== L.coins) { L.coins = r.coins; this.el.coins.textContent = r.coins.toLocaleString(); }
    // power-up bars
    const P = r.power;
    const keys = this._keys || (this._keys = []);
    keys.length = 0;
    for (const k of ['magnet', 'double', 'sneakers']) if (P[k] > 0) keys.push(k);
    if (P.shield) keys.push('shield');
    const sig = keys.join(',');
    if (sig !== L.powers) {
      L.powers = sig;
      this.el.powers.innerHTML = '';
      this.powerEls = {};
      for (const k of keys) {
        const d = document.createElement('div');
        d.className = 'pw';
        const col = '#' + POWERUPS[k].color.toString(16).padStart(6, '0');
        d.style.color = col;
        d.innerHTML = `<i style="background:${col}"></i><span>${POWERUPS[k].label}</span>` + (k === 'shield' ? '' : '<div class="t"><b></b></div>');
        this.el.powers.appendChild(d);
        this.powerEls[k] = d.querySelector('.t b');
      }
    }
    for (const k of keys) {
      const bar = this.powerEls[k];
      if (bar) bar.style.width = ((P[k] / POWERUPS[k].time) * 100).toFixed(1) + '%';
    }
    const h = g.hint;
    this._hint(g.state === 'running' && g.settings.hints ? h.kind : null, h.phase);
    if (g.state === 'running' && L.mult === 1 && this.el.mult.style.opacity !== '0.6') this.el.mult.style.opacity = '0.6';
    else if (L.mult > 1 && this.el.mult.style.opacity !== '1') this.el.mult.style.opacity = '1';
  }
}
