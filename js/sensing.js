// Body sensing in phone VR: turns devicemotion events into readings for
// js/motion.js, runs the calibration flow, and draws the ?debug overlay.
import * as THREE from 'three';
import { MotionDetector } from './motion.js';
import { store } from './config.js';

const DEG = Math.PI / 180;
const _e = new THREE.Euler();
const _qd = new THREE.Quaternion();
// W3C device axes (x right, y top, z out of the screen) relative to three's
// orientation Euler: the same -90° about X that DeviceOrientationControls uses.
const _q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();

export class BodySensing {
  constructor({ input, head, settings }) {
    this.input = input;
    this.head = head;
    this.settings = settings;
    this.motion = new MotionDetector();
    this.motion.setSensitivity(settings.sensitivity);
    this.motion.setCalibration(store.get('calibration', null));
    this.sign = 0;               // accelerometer sign convention (+1 spec, -1 flipped), learned while still
    this.signVotes = 0;
    this.prevQ = new THREE.Quaternion();
    this.havePrev = false;
    this.count = 0;
    this.lastT = 0;
    this.onEvent = null;         // (ev) => void
    this.reading = { mag: 0, ax: null, ay: null, az: null, rot: null, turn: null };
    input.onMotion = (e, now) => this._onMotion(e, now);
  }

  setSensitivity(level) { this.motion.setSensitivity(level); }

  // Rotation from the device's own axes (W3C: x right, y top, z out of the
  // screen) into the world (three axes, y up), from deviceorientation.
  _deviceQuat() {
    const o = this.input.orient;
    _e.set(o.beta * DEG, o.alpha * DEG, -o.gamma * DEG, 'YXZ');
    return _qd.setFromEuler(_e).multiply(_q1);
  }

  _onMotion(e, now) {
    this.count++;
    this.lastT = now;
    if (!this.motion.enabled) return;
    const aig = e.accelerationIncludingGravity, lin = e.acceleration, rr = e.rotationRate;
    const hasAig = aig && aig.x != null;
    const hasLin = lin && lin.x != null;
    if (!hasAig && !hasLin) return;
    const r = this.reading;
    const haveOrient = this.input.orient.valid;
    const q = haveOrient ? this._deviceQuat() : null;
    const det = this.motion;

    // |a|: from accelerationIncludingGravity (independent of how the phone sits
    // and of axis conventions). Without it, project the gravity-free vector on
    // world-up and add the resting gravity.
    if (hasAig) r.mag = Math.hypot(aig.x, aig.y, aig.z);
    else if (q) { _v.set(lin.x, lin.y, lin.z).applyQuaternion(q); r.mag = det.rest + _v.y * (this.sign || 1); }
    else r.mag = det.rest;

    // Learn the sign convention while still: at rest the reading points up.
    if (hasAig && q && det.isStill) {
      _up.set(0, 1, 0).applyQuaternion(_qi.copy(q).invert());
      const dot = aig.x * _up.x + aig.y * _up.y + aig.z * _up.z;
      this.signVotes = Math.max(-20, Math.min(20, this.signVotes + (dot > 0 ? 1 : -1)));
      if (Math.abs(this.signVotes) > 8) this.sign = this.signVotes > 0 ? 1 : -1;
    }

    // Gravity-free acceleration in world axes (for side-steps).
    if (q && this.sign) {
      if (hasLin) _v.set(lin.x, lin.y, lin.z).multiplyScalar(this.sign).applyQuaternion(q);
      else { _v.set(aig.x, aig.y, aig.z).multiplyScalar(this.sign).applyQuaternion(q); _v.y -= det.rest; }
      r.ax = _v.x; r.ay = _v.y; r.az = _v.z;
    } else { r.ax = r.ay = r.az = null; }

    r.rot = rr && rr.alpha != null ? Math.hypot(rr.alpha || 0, rr.beta || 0, rr.gamma || 0) : null;
    // How far the head turned since the last reading (any axis).
    if (this.head.valid) {
      const hq = this.head.raw;
      r.turn = this.havePrev ? (2 * Math.acos(Math.min(1, Math.abs(hq.dot(this.prevQ)))) / DEG) : 0;
      this.prevQ.copy(hq);
      this.havePrev = true;
    } else r.turn = null;

    // Side-steps are measured along the running frame's right direction.
    this.head.rightRaw(_right);
    det.setRight(_right.x, _right.z);

    const ev = det.sample(r, now);
    if (ev && this.onEvent) this.onEvent(ev);
  }

  // Has motion data arrived recently?
  get alive() { return this.count > 0 && performance.now() - this.lastT < 2500; }

  saveCalibration(c) {
    this.motion.setCalibration(c);
    store.set('calibration', c);
  }
}

// First-time calibration in phone VR. Tapping the screen skips a step.
export class Calibration {
  constructor(sensing, hud, audio) {
    this.sensing = sensing;
    this.hud = hud;
    this.audio = audio;
    this.active = false;
  }

  start(onDone) {
    this.onDone = onDone;
    this.active = true;
    this.steps = [
      { kind: 'still', title: 'Stand still', lines: ['Phone in the headset, stand tall', 'and look straight ahead'], timeout: 6 },
      { kind: 'jump', title: 'Jump once', lines: ['A small hop is enough'] },
      { kind: 'crouch', title: 'Crouch once', lines: ['Duck down, then stand up'] },
      { kind: 'step', title: 'Step to one side', lines: ['…then back to the middle'] },
    ];
    this.captures = {};
    this.i = -1;
    this._next();
  }

  _next() {
    this.i++;
    const m = this.sensing.motion;
    if (this.i >= this.steps.length) {
      m.cancelCapture();
      const prev = store.get('calibration', null);
      const c = MotionDetector.thresholdsFrom(this.captures, prev);
      this.sensing.saveCalibration(c);
      this.active = false;
      this.hud.showMessage('All set!', ['Body sensing is calibrated']);
      this.audio.play('power');
      this.onDone && this.onDone(c);
      return;
    }
    const st = this.steps[this.i];
    this.t = 0;
    this.doneT = null;
    m.beginCapture(st.kind);
    this.hud.showMessage(st.title, [...st.lines, 'Tap the screen to skip'], '#2fe0c8');
  }

  skip() { if (this.active) { this.sensing.motion.cancelCapture(); this._next(); } }

  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const st = this.steps[this.i];
    const c = this.sensing.motion.captureResult();
    if (this.doneT == null && c && c.done) {
      this.captures[st.kind] = { ...c };
      this.doneT = this.t;
      this.audio.play('move');
      this.hud.showMessage('Nice!', [st.kind === 'step' ? 'Now back to the middle' : 'Got it']);
    }
    // a short pause after each capture (and after a step, time to step back)
    const pause = st.kind === 'step' ? 1.6 : 1.0;
    if (this.doneT != null && this.t - this.doneT > pause) this._next();
    else if (st.timeout && this.t > st.timeout) this._next();
  }
}

// ?debug overlay: live sensor values, thresholds, last event and frame stats.
export class DebugOverlay {
  constructor(el, sensing, view) {
    this.el = el;
    this.sensing = sensing;
    this.view = view;
    this.t = 0;
    this.frames = [];
    el.classList.remove('hidden');
  }

  update(dt) {
    this.frames.push(dt * 1000);
    if (this.frames.length > 240) this.frames.shift();
    this.t += dt;
    if (this.t < 0.1) return;
    this.t = 0;
    const m = this.sensing.motion, c = m.cfg(), r = this.sensing.reading;
    const s = [...this.frames].sort((a, b) => a - b);
    const p95 = s[Math.floor(s.length * 0.95)] || 0;
    const avg = this.frames.reduce((a, b) => a + b, 0) / Math.max(1, this.frames.length);
    const f = (v, n = 2) => (v == null ? '  -  ' : (v >= 0 ? ' ' : '') + v.toFixed(n));
    const le = m.lastEvent;
    this.el.textContent = [
      `|a| ${f(r.mag)}  rest ${f(m.rest)}  vert ${f(m.av)}  still ${m.isStill ? 'y' : 'n'}`,
      `v ${f(m.v)}  drop ${f(m.drop, 3)}  crouch @ v<${c.crouchV.toFixed(2)} drop<${c.crouchDrop.toFixed(3)}`,
      `lat a ${f(m.aLat)}  v ${f(m.lv)}  x ${f(m.lx, 3)}  step @ v>${c.stepV.toFixed(2)} x>${c.stepX.toFixed(3)}`,
      `turn ${f(m.rot, 0)}°/s  ${f(m.turned, 0)}° in 0.4 s  ${m.why || ''}`,
      `jump: push>${c.push.toFixed(1)}  ff<-${c.ffDepth.toFixed(1)} for ${(c.ffTime * 1000).toFixed(0)} ms  period ${(m.period * 1000).toFixed(1)} ms`,
      `sign ${this.sensing.sign}  readings ${this.sensing.count}  last ${le ? le.ev + ' ' + (performance.now() / 1000 - le.t).toFixed(1) + ' s ago' : '-'}`,
      `fps ${(1000 / avg).toFixed(0)}  p95 ${p95.toFixed(1)} ms  dpr ${this.view.q.dpr.toFixed(2)}  calls ${this.view.stats.calls}`,
    ].join('\n');
  }
}
