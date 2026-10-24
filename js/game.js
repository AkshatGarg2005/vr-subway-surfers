// Game rules: run state machine, speed, physics substeps, collisions, coins,
// power-ups, scoring, hints, chasers, cameras and the test autopilot.
import * as THREE from 'three';
import {
  BODY, RULES, POWERUPS, MAGNET_RANGE, ROOF_Y, OBST, modeConfig, speedAt, clamp, damp, lerp, store, QUERY, PLATFORM,
} from './config.js';
import { PlayerBody, EV, obstacleS0 } from './physics.js';

const SUBSTEP = 1 / 120;
const _v = new THREE.Vector3();

export class Game {
  constructor({ scene, view, world, input, audio, ui, chars, particles, settings }) {
    this.scene = scene;
    this.view = view;
    this.world = world;
    this.input = input;
    this.audio = audio;
    this.ui = ui;
    this.chars = chars;
    this.particles = particles;
    this.settings = settings;
    this.state = 'menu';
    this.mode = 'screen';                // 'screen' | 'cardboard' | 'xr'
    this.cfg = modeConfig('screen');
    this.body = new PlayerBody(this.cfg);
    this.best = store.get('best', 0) || 0;
    this.test = { invincible: !!QUERY.invincible, autopilot: !!QUERY.autopilot, seed: QUERY.seed ? Number(QUERY.seed) : null };
    this.run = null;
    this.hint = { kind: null, phase: null, ob: null, tta: 0, lane: 0, sounded: null };
    this.cam = { x: 0, y: 3.2, look: 0, shake: 0, fov: 68, yv: 0 };
    this.trail = new Float32Array(3 * 512); // breadcrumbs: s, x, y
    this.trailHead = 0;
    this.trailCount = 0;
    this.trailLastS = -1;
    this.listeners = {};
    this.stats = { frames: 0 };
    this.menuT = 0;
    this.vr = null;                       // set by app for VR modes (head tracking / XR helpers)
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, data) { const l = this.listeners[ev]; if (l) for (const fn of l) fn(data); }

  // ------------------------------------------------------------------ runs
  setMode(mode) {
    this.mode = mode;
    this.cfg = modeConfig(mode === 'screen' ? 'screen' : 'vr', this.settings.vrSpeed);
    this.body.cfg = this.cfg;
  }

  get isVR() { return this.mode !== 'screen'; }

  startRun() {
    const cfg = (this.cfg = modeConfig(this.isVR ? 'vr' : 'screen', this.settings.vrSpeed));
    this.body.cfg = cfg;
    this.body.reset(0, 1);
    const seed = this.test.seed != null ? this.test.seed : (Math.random() * 0x7fffffff) | 0;
    this.run = {
      seed, t: 0, s: 0, speed: cfg.v0, score: 0, coins: 0, mult: 1,
      lastStumble: -99, stumbleT: 99, chaseHold: 0, chaseGap: RULES.chaseFar + 8,
      power: { magnet: 0, double: 0, sneakers: 0, shield: false },
      invulnT: 0, deathT: 0, reason: '', overT: 0, streak: 0, streakT: 0,
      newBest: false, flash: 0, distanceShown: 0,
    };
    // The generator plans with the speed you'll have when you get there.
    const planSpeed = (s) => {
      const r = this.run;
      const ahead = Math.max(0, s - r.s) / Math.max(1, r.speed);
      return speedAt(cfg, r.t + ahead);
    };
    this.world.reset({ seed, cfg, planSpeed });
    this.world.update(0, 0);
    this.trailHead = 0; this.trailCount = 0; this.trailLastS = -1;
    this.hint.kind = null; this.hint.sounded = null;
    this.chars && this.chars.reset();
    this.particles && this.particles.clear();
    this.cam.x = 0; this.cam.y = 3.2; this.cam.shake = 0; this.cam.yv = 0;
    this.state = this.isVR ? 'countdown' : 'running';
    this.countdown = this.isVR ? 3 : 0;
    this.emit('start', this.run);
  }

  beginCountdown() {
    this.state = 'countdown';
    this.countdown = 3;
  }

  pause() {
    if (this.state !== 'running' && this.state !== 'countdown' && this.state !== 'calibrate') return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.audio && this.audio.setPaused(true);
    this.emit('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = this.pausedFrom || 'running';
    this.audio && this.audio.setPaused(false);
    this.emit('resume');
  }

  quit() {
    this.state = 'menu';
    this.run = null;
    this.audio && this.audio.setPaused(false);
    this.emit('menu');
  }

  // ------------------------------------------------------------------ frame
  update(dt) {
    this.stats.frames++;
    const actions = this.input.take();
    // Recenter works in every state (long-press is only active in VR).
    for (const a of actions) if ((a === 'longpress' || a === 'recenter') && this.isVR) this.emit('recenter');
    if (this.state === 'running') this._running(dt, actions);
    else if (this.state === 'countdown') this._countdown(dt, actions);
    else if (this.state === 'dying') this._dying(dt);
    else if (this.state === 'over') this._over(dt, actions);
    else if (this.state === 'paused') this._paused(actions);
    else if (this.state === 'menu') this._menu(dt, actions);
    else if (this.state === 'calibrate') { for (const a of actions) if (a === 'pause') this.pause(); this.world.update(dt, this.body.s); }
    this._camera(dt);
    if (this.chars) this.chars.update(dt, this);
    if (this.particles) this.particles.update(dt, this.world);
    this.world.flush();
  }

  _menu(dt, actions) {
    // Idle: slowly run the camera down an empty-ish track behind the title screen.
    this.menuT += dt;
    if (!this.run) {
      if (!this.menuWorld) {
        this.menuWorld = true;
        this.body.reset(0, 1);
        this.world.reset({ seed: 12345, cfg: this.cfg, planSpeed: () => this.cfg.v0 });
      }
      this.body.s += dt * 3.5;
      this.world.update(dt, this.body.s);
    }
    for (const a of actions) if (a === 'confirm') this.emit('menuConfirm');
  }

  _countdown(dt, actions) {
    this.countdown -= dt;
    for (const a of actions) if (a === 'pause') this.pause();
    this.emit('countdown', Math.ceil(this.countdown));
    this.world.update(dt, this.body.s);
    if (this.countdown <= 0) { this.state = 'running'; this.emit('go'); }
  }

  _paused(actions) {
    for (const a of actions) if (a === 'pause' || a === 'confirm' || (this.isVR && a === 'jump' && this.input.lastSource === 'gamepad')) this.resume();
  }

  _running(dt, actions) {
    const r = this.run, b = this.body, cfg = this.cfg;
    r.t += dt;
    r.stumbleT += dt;
    // Speed: smooth growth, with a brief dip after a stumble.
    const dip = r.stumbleT < RULES.stumbleRecover ? lerp(RULES.stumbleSlow, 1, r.stumbleT / RULES.stumbleRecover) : 1;
    r.speed = speedAt(cfg, r.t) * dip;

    for (const a of actions) this._action(a);
    if (this.test.autopilot) this._autopilot();

    // Physics in small fixed-ish steps so fast speeds never tunnel through anything.
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    b.sneakers = r.power.sneakers > 0;
    for (let k = 0; k < n && this.state === 'running'; k++) {
      const ne = b.step(h, r.speed, this.world.near);
      for (let e = 0; e < ne; e++) this._event(b.events[e]);
    }
    if (this.state !== 'running') return;

    const ds = b.s - r.s;
    r.s = b.s;
    r.mult = 1 + Math.floor(r.s / RULES.multEvery);
    r.score += ds * r.mult * (r.power.double > 0 ? 2 : 1);

    // power-up timers
    const P = r.power;
    if (P.magnet > 0) P.magnet = Math.max(0, P.magnet - dt);
    if (P.double > 0) P.double = Math.max(0, P.double - dt);
    if (P.sneakers > 0) P.sneakers = Math.max(0, P.sneakers - dt);
    if (r.invulnT > 0) r.invulnT -= dt;
    if (r.streakT > 0) { r.streakT -= dt; if (r.streakT <= 0) r.streak = 0; }

    this.world.update(dt, b.s);
    this._pickups(dt);
    this._breadcrumb();
    this._chase(dt);
    this._hints();
    this.audio && this.audio.setSpeed(r.speed, cfg);
  }

  _action(a) {
    const b = this.body;
    switch (a) {
      case 'left': b.requestLane(-1); break;
      case 'right': b.requestLane(1); break;
      case 'jump': b.requestJump(this.world.near); break;
      case 'roll': b.requestRoll(); break;
      case 'pause': this.pause(); break;
      case 'tap':
        // A tap is a backup jump in phone VR (Cardboard button) only.
        if (this.mode === 'cardboard') b.requestJump(this.world.near);
        break;
    }
  }

  _event(e) {
    const r = this.run;
    const b = this.body;
    switch (e.type) {
      case EV.JUMP: this.audio && this.audio.play('jump'); this.emit('move', 'jump'); break;
      case EV.ROLL: this.audio && this.audio.play('roll'); this.emit('move', 'roll'); break;
      case EV.LANE: this.audio && this.audio.play('swish', e.value); break;
      case EV.LAND:
        if (e.value > 0.25) {
          this.audio && this.audio.play('land', Math.min(1, e.value));
          this.particles && this.particles.dust(b.x, b.y, this.world.z(b.s), 6);
        }
        break;
      case EV.SIDE:
        this.particles && this.particles.sparks(b.x, b.y + 1, this.world.z(b.s), 10);
        this._stumble(e.ob, 'side');
        break;
      case EV.FRONT: this._front(e.ob); break;
    }
  }

  _front(ob) {
    const r = this.run;
    if (this.test.invincible || r.invulnT > 0) {
      ob.noCollide = true;
      if (ob.kind === 'hurdle') this.world.knock(ob);
      return;
    }
    if (ob.kind === 'hurdle') {
      this.world.knock(ob);
      this._stumble(ob, 'hurdle');
      return;
    }
    if (r.power.shield) {
      r.power.shield = false;
      r.invulnT = RULES.invulnAfterShield;
      ob.noCollide = true;
      this.audio && this.audio.play('shield');
      this.flash(0.6);
      this.particles && this.particles.sparks(this.body.x, 1.2, this.world.z(this.body.s), 24);
      if (ob.kind === 'train') {
        // Board pops you up onto the roof.
        const g = this.cfg.gravity;
        this.body.vy = Math.sqrt(2 * g * (ROOF_Y + 0.6 - this.body.y));
        this.body.grounded = false;
      } else {
        this.world.knock(ob);
      }
      this.emit('shieldUsed');
      return;
    }
    this._crash(ob);
  }

  _stumble(ob, why) {
    const r = this.run;
    if (this.test.invincible || r.invulnT > 0) return;
    if (r.power.shield) {
      r.power.shield = false;
      r.invulnT = RULES.invulnAfterShield;
      this.audio && this.audio.play('shield');
      this.emit('shieldUsed');
      return;
    }
    if (r.t - r.lastStumble < RULES.stumbleWindow) {
      r.reason = 'Caught by the warden';
      this._die('caught');
      return;
    }
    r.lastStumble = r.t;
    r.stumbleT = 0;
    r.chaseHold = RULES.chaseHold;
    this.audio && this.audio.play('stumble');
    this.cam.shake = Math.max(this.cam.shake, 0.35);
    this.flash(0.25);
    this.emit('stumble', why);
  }

  _crash(ob) {
    const r = this.run;
    r.reason = ob.kind === 'train' ? (ob.moving ? 'Hit by a train' : 'Ran into a train')
      : ob.kind === 'barrier' ? 'Hit a barrier — roll under those'
      : ob.kind === 'wall' ? 'Ran into a barrier' : 'Crashed';
    this.audio && this.audio.play('crash');
    this.particles && this.particles.sparks(this.body.x, 1.2, this.world.z(this.body.s), 30);
    this.cam.shake = 1;
    this.flash(1);
    this._die('crash');
  }

  _die(kind) {
    const r = this.run;
    r.deathKind = kind;
    r.deathT = 0;
    this.state = 'dying';
    this.emit('die', r);
  }

  _dying(dt) {
    const r = this.run;
    r.deathT += dt;
    // chasers close in
    r.chaseGap = damp(r.chaseGap, 1.2, 4, dt);
    this.world.update(dt, this.body.s);
    if (r.deathT >= RULES.deathAnim) this._gameOver();
  }

  _gameOver() {
    const r = this.run;
    r.score = Math.floor(r.score);
    r.newBest = r.score > this.best;
    if (r.newBest) { this.best = r.score; store.set('best', this.best); }
    r.overT = 0;
    this.state = 'over';
    this.audio && this.audio.play('over');
    this.emit('over', r);
  }

  _over(dt, actions) {
    const r = this.run;
    r.overT += dt;
    for (const a of actions) {
      if (a === 'confirm' || ((a === 'jump' || a === 'tap') && r.overT > 0.4) || (a === 'bodyjump' && r.overT > RULES.restartDelay)) {
        this.startRun();
        return;
      }
      if (a === 'pause') { this.quit(); return; }
    }
  }

  flash(k) {
    if (!this.run) return;
    const scale = this.isVR ? 0.3 : (PLATFORM.reducedMotion ? 0.4 : 1); // flashes are dimmed in VR
    this.run.flash = Math.max(this.run.flash, k * scale);
  }

  // ------------------------------------------------------------------ pickups
  _pickups(dt) {
    const b = this.body, r = this.run, w = this.world;
    const magnet = r.power.magnet > 0;
    const cy = b.y + b.height * 0.5;
    for (let i = 0; i < w.coins.length; i++) {
      const c = w.coins[i];
      if (c.taken) continue;
      const ds = c.s - b.s;
      // (not `break`: a row's coin line can start before the previous row's arc ends)
      if (ds > MAGNET_RANGE + 2) continue;
      if (magnet && !c.magnet && ds < MAGNET_RANGE && ds > -1) c.magnet = true;
      if (c.magnet) {
        // fly to the player
        const k = 1 - Math.exp(-dt * 14);
        c.s = lerp(c.s, b.s + 0.2, k) + r.speed * dt * 0.5;
        c.x = lerp(c.x, b.x, k);
        c.y = lerp(c.y, cy, k);
      }
      if (Math.abs(ds) < 0.8 && Math.abs(c.x - b.x) < 0.9 && c.y > b.y - 0.3 && c.y < b.y + b.height + 0.5) {
        c.taken = true;
        c.t = 0;
        r.coins++;
        r.score += RULES.coinScore * r.mult * (r.power.double > 0 ? 2 : 1);
        r.streak = Math.min(r.streak + 1, 24);
        r.streakT = 0.6;
        this.audio && this.audio.play('coin', r.streak);
        if (this.particles && (r.coins % 2 === 0)) this.particles.sparkle(c.x, c.y, w.z(c.s));
      }
    }
    for (let i = 0; i < w.powerups.length; i++) {
      const p = w.powerups[i];
      if (p.taken) continue;
      if (Math.abs(p.s - b.s) < 0.9 && Math.abs(p.x - b.x) < 1.0 && p.y > b.y - 0.4 && p.y < b.y + b.height + 0.6) {
        p.taken = true; p.t = 0;
        if (p.kind === 'shield') r.power.shield = true;
        else r.power[p.kind] = POWERUPS[p.kind].time;
        this.audio && this.audio.play('power');
        this.particles && this.particles.sparkle(p.x, p.y, w.z(p.s), 18);
        this.emit('power', p.kind);
      }
    }
  }

  // ------------------------------------------------------------------ chase
  _breadcrumb() {
    const b = this.body;
    if (b.s - this.trailLastS < 0.25) return;
    this.trailLastS = b.s;
    const i = this.trailHead * 3;
    this.trail[i] = b.s; this.trail[i + 1] = b.x; this.trail[i + 2] = b.y;
    this.trailHead = (this.trailHead + 1) % 512;
    this.trailCount = Math.min(512, this.trailCount + 1);
  }

  // Where the player was at track position s (x, y), from the breadcrumb trail.
  trailAt(s, out) {
    const n = this.trailCount;
    if (!n) { out.x = this.body.x; out.y = 0; return out; }
    // newest to oldest
    let prevI = -1;
    for (let k = 1; k <= n; k++) {
      const idx = ((this.trailHead - k + 512) % 512) * 3;
      if (this.trail[idx] <= s) {
        if (prevI < 0) { out.x = this.trail[idx + 1]; out.y = this.trail[idx + 2]; return out; }
        const s0 = this.trail[idx], s1 = this.trail[prevI];
        const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
        out.x = lerp(this.trail[idx + 1], this.trail[prevI + 1], t);
        out.y = lerp(this.trail[idx + 2], this.trail[prevI + 2], t);
        return out;
      }
      prevI = idx;
    }
    const idx = ((this.trailHead - n + 512) % 512) * 3;
    out.x = this.trail[idx + 1]; out.y = this.trail[idx + 2];
    return out;
  }

  _chase(dt) {
    const r = this.run;
    if (r.chaseHold > 0) {
      r.chaseHold -= dt;
      r.chaseGap = damp(r.chaseGap, RULES.chaseNear, 3, dt);
    } else {
      r.chaseGap = damp(r.chaseGap, RULES.chaseFar, 0.35, dt);
    }
  }

  // ------------------------------------------------------------------ hints
  // The next thing in your lane that needs a jump or a roll (and, in VR, a train
  // or tall barrier you need to step away from).
  _hints() {
    const h = this.hint, b = this.body, r = this.run, cfg = this.cfg;
    const prevKind = h.kind, prevOb = h.ob;
    h.kind = null; h.phase = null; h.ob = null;
    if (!this.settings.hints && !this.test.autopilot) return;
    const v = Math.max(0.5, r.speed);
    const ready = cfg.hintReady, now = cfg.hintNow;
    let best = null, bestT = 1e9, bestKind = null;
    const obs = this.world.obstacles;
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i];
      if (ob.lane !== b.lane || ob.knocked || ob.noCollide) continue;
      let kind = null;
      let s0 = ob.moving ? ob.moving.sMeet : ob.s0;
      if (ob.moving && obstacleS0(ob, b.s) < b.s) continue;
      if (ob.kind === 'hurdle') kind = 'jump';
      else if (ob.kind === 'barrier') kind = 'roll';
      else if (this.isVR && (ob.kind === 'wall' || (ob.kind === 'train' && !ob.ramp))) kind = 'step';
      if (!kind) continue;
      if (b.y > ob.y1 - 0.1) continue;         // you're above it (on a roof)
      const t = (s0 - (b.s + BODY.halfD)) / v;
      if (t < -0.05 || t > ready + 0.05) continue;
      if (t < bestT) { bestT = t; best = ob; bestKind = kind; }
    }
    if (!best) { h.sounded = null; return; }
    if (bestKind === 'step') {
      const dir = this._freeSide(best);
      if (!dir) return;
      bestKind = dir < 0 ? 'left' : 'right';
    }
    // Already doing the move: don't nag.
    if ((bestKind === 'jump' && !b.grounded) || (bestKind === 'roll' && b.rolling)) {
      h.kind = bestKind; h.ob = best; h.tta = bestT; h.phase = 'done';
      return;
    }
    h.kind = bestKind; h.ob = best; h.tta = bestT;
    h.phase = bestT <= now ? 'now' : 'ready';
    if (h.phase === 'now' && h.sounded !== best && this.settings.hints) {
      h.sounded = best;
      this.audio && this.audio.play('hint');
    }
    if (prevOb !== best || prevKind !== h.kind) this.emit('hint', h);
  }

  // Which way is the nearest lane that's free at an obstacle? -1, 1 or 0.
  _freeSide(ob) {
    const lane = ob.lane;
    const at = ob.moving ? ob.moving.sMeet : ob.s0;
    const freeLane = (l) => {
      if (l < 0 || l > 2) return false;
      for (const o of this.world.obstacles) {
        if (o.lane !== l || o.knocked) continue;
        const s0 = o.moving ? o.moving.sMeet : o.s0;
        const len = o.moving ? o.len / (1 + o.moving.k) : o.len;
        if (o.kind === 'hurdle' || o.kind === 'barrier' || o.kind === 'ramp') continue;
        if (s0 < at + 4 && s0 + len > at - 4) return false;
      }
      return true;
    };
    const order = lane === 1 ? [0, 2] : lane === 0 ? [1, 2] : [1, 0];
    for (const l of order) if (freeLane(l)) return l < lane ? -1 : 1;
    return 0;
  }

  // ------------------------------------------------------------------ autopilot (tests)
  // Reads the hint system for jumps and rolls; steers away from trains and walls.
  _autopilot() {
    const b = this.body, r = this.run, v = Math.max(1, r.speed);
    const h = this.hint;
    const lead = { jump: 0.22, roll: 0.28 };
    if ((h.kind === 'jump' || h.kind === 'roll') && h.phase !== 'done' && h.tta <= lead[h.kind] + 0.02) {
      if (h.kind === 'jump' && b.grounded) b.requestJump(this.world.near);
      if (h.kind === 'roll' && !b.rolling) b.requestRoll();
    }
    if (b.changingLane) return;
    // Free running distance in each lane at ground level (thinking in seconds,
    // so it works at VR walking speeds too).
    const look = v * 4.5 + 6;
    const free = [look, look, look];
    for (const ob of this.world.obstacles) {
      if (ob.knocked || ob.noCollide) continue;
      if (ob.kind === 'hurdle' || ob.kind === 'barrier') continue;
      let s0 = ob.moving ? ob.moving.sMeet : obstacleS0(ob, b.s);
      let s1 = ob.moving ? ob.moving.sMeet + ob.len / (1 + ob.moving.k) : s0 + ob.len;
      if (ob.kind === 'ramp') continue;
      if (ob.kind === 'train' && ob.ramp) {
        // A ramp lane is a fine route: up and over.
        if (b.lane === ob.lane && b.y > 1) continue;
        const rampS = s0 - OBST.ramp.len;
        if (rampS > b.s + 0.5) continue;
      }
      if (s1 < b.s - 1) continue;
      if (b.y > ROOF_Y - 0.4 && b.lane === ob.lane && s0 < b.s) continue; // riding it
      const d = s0 - b.s;
      if (d < free[ob.lane]) free[ob.lane] = Math.max(-1, d);
    }
    const cur = b.lane;
    if (free[cur] > v * 2.2 + 4) return;
    const alongside = (l) => {
      for (const ob of this.world.near) {
        if (ob.lane !== l || ob.knocked || ob.noCollide) continue;
        if (ob.kind !== 'train' && ob.kind !== 'wall' && ob.kind !== 'ramp') continue;
        const s0 = obstacleS0(ob, b.s);
        if (s0 < b.s + v * 0.25 + 1 && s0 + ob.len > b.s - 1) {
          if (b.y > ROOF_Y - 0.4 && ob.kind === 'train') continue; // roof to roof is fine
          return true;
        }
      }
      return false;
    };
    // A hurdle or barrier right ahead in a lane is a reason not to switch into it
    // (no time to jump/roll), but never worth staying in front of a train for.
    const tooClose = (l) => {
      for (const ob of this.world.near) {
        if (ob.lane !== l || ob.knocked || ob.noCollide || (ob.kind !== 'hurdle' && ob.kind !== 'barrier')) continue;
        const d = ob.s0 - b.s;
        if (d > -0.5 && d < v * 0.6 + 1) return true;
      }
      return false;
    };
    const urgent = free[cur] < v * 0.9 + 2;
    let bestL = cur, bestF = free[cur];
    const score = (l) => (tooClose(l) && !urgent ? Math.min(free[l], v * 0.5) : free[l]);
    for (const l of [cur - 1, cur + 1]) {
      if (l < 0 || l > 2 || alongside(l)) continue;
      const f = score(l);
      if (f > bestF + 0.5) { bestF = f; bestL = l; }
      // two lanes over, via the middle
      if (l === 1) {
        const far = cur === 0 ? 2 : 0;
        if (!alongside(far) && free[far] > bestF + 0.5 && free[1] > 2) { bestF = free[far]; bestL = l; }
      }
    }
    if (bestL !== cur) b.requestLane(bestL > cur ? 1 : -1);
  }

  // ------------------------------------------------------------------ camera
  _camera(dt) {
    const view = this.view, cam = this.cam, b = this.body;
    if (this.isVR) { this.vr && this.vr.updateCamera(dt, this); return; }
    const camera = view.camera;
    const zP = this.world.z(b.s);
    const fp = this.settings.camera === 'fp';
    const speedK = this.run ? clamp((this.run.speed - this.cfg.v0) / (this.cfg.v1 - this.cfg.v0), 0, 1) : 0;
    if (this.state === 'menu') {
      cam.x = damp(cam.x, Math.sin(this.menuT * 0.15) * 1.2, 2, dt);
      camera.position.set(cam.x, 2.6, zP + 4);
      camera.lookAt(cam.x * 0.4, 1.6, zP - 20);
      camera.fov = 62;
      camera.updateProjectionMatrix();
      return;
    }
    if (fp) {
      const eye = b.rolling ? BODY.rollEyeH : BODY.eyeH;
      cam.y = damp(cam.y, b.y + eye, 18, dt);
      cam.x = damp(cam.x, b.x, 20, dt);
      camera.position.set(cam.x, cam.y, zP - 0.05);
      camera.lookAt(cam.x, cam.y - 0.25, zP - 10);
      cam.fov = damp(cam.fov, 78 + speedK * 6, 3, dt);
    } else {
      // Chase camera: follows lanes loosely and jumps softly.
      cam.x = damp(cam.x, b.x * 0.8, 9, dt);
      const ty = 3.15 + Math.max(0, b.y) * 0.7;
      cam.y = damp(cam.y, ty, b.y > cam.y - 3.15 ? 6 : 10, dt);
      const dz = this.state === 'dying' ? lerp(5.6, 7.5, Math.min(1, this.run.deathT)) : 5.6;
      camera.position.set(cam.x, cam.y, zP + dz);
      _v.set(cam.x * 0.92 + (b.x - cam.x) * 0.15, cam.y - 2.0, zP - 7);
      camera.lookAt(_v);
      cam.fov = damp(cam.fov, 66 + speedK * 8, 3, dt);
    }
    if (cam.shake > 0 && !PLATFORM.reducedMotion) {
      const k = cam.shake * cam.shake * 0.16;
      camera.position.x += (Math.random() - 0.5) * k;
      camera.position.y += (Math.random() - 0.5) * k;
      cam.shake = Math.max(0, cam.shake - dt * 2.5);
    } else cam.shake = 0;
    if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
    if (this.run && this.run.flash > 0) this.run.flash = Math.max(0, this.run.flash - dt * 3);
  }
}
