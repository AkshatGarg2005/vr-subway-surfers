// Phone VR: head tracking (look only), recentering, the VR camera with its
// comfort rules, and the Cardboard session (fullscreen, landscape, wake lock).
//
// Lanes never follow head rotation. Turning, tilting or nodding only looks
// around; the straight track fixes the running direction, and recentering just
// realigns the view with it.
import * as THREE from 'three';
import { BODY, clamp, damp, store } from './config.js';
import { BodySensing, Calibration } from './sensing.js';

const DEG = Math.PI / 180;
const _euler = new THREE.Euler();
const _q0 = new THREE.Quaternion();
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -90° about X: look out of the back of the phone
const _zee = new THREE.Vector3(0, 0, 1);
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _yawQ = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

// Same maths as three's (removed) DeviceOrientationControls.
export function deviceQuaternion(out, alpha, beta, gamma, screenAngleDeg) {
  _euler.set(beta * DEG, alpha * DEG, -gamma * DEG, 'YXZ');
  out.setFromEuler(_euler);
  out.multiply(_q1);
  out.multiply(_q0.setFromAxisAngle(_zee, -screenAngleDeg * DEG));
  return out;
}

// Body facing (yaw) that stays well defined even looking straight up or down:
// blend the gaze direction with the head's up vector.
export function facingYaw(q) {
  _f.set(0, 0, -1).applyQuaternion(q);
  _u.set(0, 1, 0).applyQuaternion(q);
  // horizontal facing = horiz(gaze) * up.y - horiz(up) * gaze.y
  const x = _f.x * _u.y - _u.x * _f.y;
  const z = _f.z * _u.y - _u.z * _f.y;
  return Math.atan2(-x, -z);
}

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class HeadTracker {
  constructor(input) {
    this.input = input;
    this.raw = new THREE.Quaternion();     // device orientation in its own world
    this.q = new THREE.Quaternion();       // after recentering (what the camera uses)
    this.offset = 0;                       // yaw that maps the body's facing to -Z
    this.pitch = 0;
    this.relYaw = 0;
    this.valid = false;
    this.lookUpT = 0;
    this.onRecenter = null;
  }

  reset() { this.offset = 0; this.lookUpT = 0; }

  recenter() {
    this.offset = facingYaw(this.raw);
    this.lookUpT = 0;
    this._apply();
    if (this.onRecenter) this.onRecenter();
  }

  _apply() {
    _yawQ.setFromAxisAngle(_up, -this.offset);
    this.q.copy(_yawQ).multiply(this.raw);
  }

  // Right direction of the running frame, in the device's raw world (for side-steps).
  rightRaw(out) {
    return out.set(Math.cos(this.offset), 0, -Math.sin(this.offset));
  }

  update(dt) {
    const o = this.input.orient;
    if (!o.valid) { this.valid = false; this.q.identity(); this.pitch = 0; return; }
    const first = !this.valid;
    this.valid = true;
    deviceQuaternion(this.raw, o.alpha, o.beta, o.gamma, this.input.screenAngle);
    if (first) this.offset = facingYaw(this.raw);
    this._apply();
    _f.set(0, 0, -1).applyQuaternion(this.q);
    this.pitch = Math.asin(clamp(_f.y, -1, 1));
    this.relYaw = wrap(facingYaw(this.raw) - this.offset);
    // While you look roughly forward, small body rotations slowly re-centre the view.
    if (Math.abs(this.pitch) < 25 * DEG && Math.abs(this.relYaw) < 20 * DEG) {
      this.offset = wrap(this.offset + this.relYaw * (1 - Math.exp(-dt / 7)));
    }
  }

  // Hands-free recenter: look up past ~55° and hold for 2 s. Returns progress 0..1 or null.
  lookUpGesture(dt) {
    if (!this.valid) return null;
    if (this.pitch > 55 * DEG) {
      this.lookUpT += dt;
      if (this.lookUpT >= 2) { this.recenter(); return null; }
      return this.lookUpT / 2;
    }
    if (this.pitch < 45 * DEG) this.lookUpT = 0; // looking back down cancels
    return this.lookUpT > 0 ? this.lookUpT / 2 : null;
  }
}

// Camera for both VR modes: the rig follows the runner; the head only looks.
export class VRCamera {
  constructor(view) {
    this.view = view;
    this.y = BODY.eyeH;
    this.x = 0;
    this.comfort = 0;
    this.prevX = 0;
    this.prevY = 0;
  }

  reset() { this.y = BODY.eyeH; this.comfort = 0; }

  // Rig height above the feet: eye height (lower while rolling), plus all of a
  // climb but only 0.55x of a jump, smoothed. No roll, no bob, no shake.
  update(dt, game, eyeH = BODY.eyeH, rollEye = 0.95) {
    const b = game.body;
    let feet = b.y;
    if (!b.grounded && b.jumped) feet = b.jumpFromY + (b.y - b.jumpFromY) * 0.55;
    const eye = b.rolling && game.mode === 'cardboard' ? rollEye : eyeH;
    const target = feet + eye;
    this.y = damp(this.y, target, b.grounded ? 9 : 12, dt);
    this.x = b.x;
    const rig = this.view.rig;
    rig.position.set(this.x, this.y, game.world.z(b.s));
    rig.quaternion.identity();
    // comfort vignette: narrows during lane changes and climbs
    const vx = Math.abs(this.x - this.prevX) / Math.max(dt, 1e-3);
    const vy = Math.abs(this.y - this.prevY) / Math.max(dt, 1e-3);
    this.prevX = this.x; this.prevY = this.y;
    const want = game.settings.vignette && game.state === 'running' ? clamp(vx / 9 + Math.max(0, vy - 0.6) / 3, 0, 1) : 0;
    this.comfort = damp(this.comfort, want, want > this.comfort ? 14 : 4, dt);
    this.view.fx.comfort = this.comfort;
  }
}

// Phone VR session: fullscreen, landscape lock, wake lock, rotate overlay,
// head tracking and the run-start countdown.
export class PhoneVR {
  constructor({ game, view, input, hud, audio, ui, settings }) {
    this.game = game; this.view = view; this.input = input; this.hud = hud; this.audio = audio; this.ui = ui;
    this.settings = settings;
    this.head = new HeadTracker(input);
    this.cam = new VRCamera(view);
    this.sensing = new BodySensing({ input, head: this.head, settings });
    this.calibration = new Calibration(this.sensing, hud, audio);
    // Real body moves become ordinary game actions (processed next frame).
    this.sensing.onEvent = (ev) => {
      if (!this.active) return;
      const g = this.game;
      if (g.state === 'over') { if (ev === 'jump') input.push('bodyjump', 'body'); return; }
      if (g.state !== 'running') return;
      if (ev === 'jump') input.push('jump', 'body');
      else if (ev === 'crouch') input.push('roll', 'body');
      else if (ev === 'left' || ev === 'right') input.push(ev, 'body');
      hud.moveFlash(ev);
      audio.play('move');
    };
    this.onBaseline = () => this.sensing.motion.rebase();
    this.sensorWait = 0;
    this.active = false;
    this.wakeLock = null;
    this.portrait = false;
    this.goRecentered = false;
    this.head.onRecenter = () => { audio.play('recenter'); if (this.onRecenter) this.onRecenter(); };
    this._onVis = () => { if (document.visibilityState === 'visible' && this.active) this._wake(); };
    document.addEventListener('visibilitychange', this._onVis);
  }

  // Must be called synchronously from the Phone VR tap (iOS permission prompts).
  enter() {
    const permission = this.input.requestSensors();
    this.active = true;
    this.input.vr = true;
    const el = document.documentElement;
    try {
      const fs = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fs) {
        const p = fs.call(el, { navigationUI: 'hide' });
        if (p && p.then) p.then(() => this._lock()).catch(() => {});
      }
    } catch { /* not allowed: fine */ }
    this._wake();
    this.head.reset();
    this.cam.reset();
    this.hud.show(true);
    this.hud.setEyeY(0);
    return permission;
  }

  _lock() {
    try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); } catch { /* unsupported */ }
  }

  async _wake() {
    try { if ('wakeLock' in navigator) this.wakeLock = await navigator.wakeLock.request('screen'); } catch { /* not granted */ }
  }

  exit() {
    this.active = false;
    this.input.vr = false;
    this.hud.show(false);
    this.view.fx.comfort = 0;
    try { if (this.wakeLock) this.wakeLock.release(); } catch { /* gone */ }
    this.wakeLock = null;
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {}); } catch { /* ignore */ }
    try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch { /* ignore */ }
  }

  recenter() { this.head.recenter(); this.sensing.motion.rebase(); }

  // Start a run: calibrate first (first time only), then the countdown.
  startRun() {
    const g = this.game;
    const needCal = this.sensing.motion.enabled && !store.get('calibration', null);
    this.sensorWait = 0;
    this.sensorProblem = false;
    g.startRun();
    if (needCal) {
      g.state = 'calibrate';
      this.calibration.start(() => setTimeout(() => { if (g.state === 'calibrate') g.beginCountdown(); }, 900));
    }
  }

  // Forget the calibration and run the calibration flow again (pause menu).
  recalibrate() {
    store.set('calibration', null);
    this.sensing.motion.setCalibration(null);
    this.sensing.motion.enabled = true;
    this.audio.setPaused(false);
    this.startRun();
  }

  playWithoutSensing() {
    this.sensing.motion.enabled = false;
    this.calibration.active = false;
    this.ui.hide('sensorHelp');
    this.sensorProblem = false;
    if (this.game.state === 'calibrate' || this.game.state === 'paused') this.game.beginCountdown();
  }

  retrySensors() {
    this.ui.hide('sensorHelp');
    this.input.requestSensors();
    this.sensorWait = 0;
    this.sensorProblem = false;
    if (this.game.state === 'paused') this.game.resume();
  }

  // Per frame (before the game update): orientation, gestures, overlays.
  update(dt) {
    if (!this.active) return;
    const g = this.game;
    this.head.update(dt);
    // No motion data for 2.5 s: explain how to fix it, offer to play without body sensing.
    if (this.sensing.motion.enabled && !this.sensorProblem && !this.portrait) {
      this.sensorWait += dt;
      if (this.sensorWait > 2.5 && !this.sensing.alive) {
        this.sensorProblem = true;
        this.ui.show('sensorHelp');
        if (g.state === 'running' || g.state === 'countdown') g.pause();
      }
    }
    if (g.state === 'calibrate') {
      this.calibration.update(dt);
      for (const a of this.input.peek()) if (a === 'tap') this.calibration.skip();
    }
    // Portrait: show the rotate overlay and pause.
    const portrait = window.innerHeight > window.innerWidth * 1.05;
    if (portrait !== this.portrait) {
      this.portrait = portrait;
      if (portrait) { this.ui.show('rotate'); g.pause(); }
      else this.ui.hide('rotate');
    }
    // Look-up recenter (not while paused or in menus).
    const ring = g.state === 'running' || g.state === 'countdown' || g.state === 'over' || g.state === 'calibrate' ? this.head.lookUpGesture(dt) : null;
    this.hud.setRing(ring);
    // Countdown: "Stand tall · look straight ahead"; recenter and reset the body
    // baseline 0.25 s before "go".
    if (g.state === 'countdown') {
      const n = Math.ceil(g.countdown);
      this.hud.showMessage(n > 0 ? String(n) : 'GO', ['Stand tall · look straight ahead']);
      if (n !== this.lastCount) { this.lastCount = n; this.audio.play(n > 0 ? 'beep' : 'go'); }
      if (!this.goRecentered && g.countdown <= 0.25) {
        this.goRecentered = true;
        this.head.recenter();
        if (this.onBaseline) this.onBaseline();
      }
    } else {
      this.goRecentered = false;
      this.lastCount = null;
    }
  }

  updateCamera(dt, game) {
    this.cam.update(dt, game);
    const cam = this.view.camera;
    cam.position.set(0, 0, 0);
    cam.quaternion.copy(this.head.q);
  }
}
