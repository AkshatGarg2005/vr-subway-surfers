// Real jump, crouch and side-step detection from the phone's motion sensors
// (phone VR). Pure JavaScript, no three.js and no DOM, so tools/motion-sim.mjs
// can drive it with synthetic sensor data.
//
// API
//   sample(reading, now)   reading = { mag, ax, ay, az, rot, turn }
//       mag   |accelerationIncludingGravity| in m/s² (does not depend on how the
//             phone sits in the headset or on iOS/Android axis conventions)
//       ax..  gravity-free acceleration in world axes (y up), or null
//       rot   gyroscope rotation rate magnitude in °/s, or null
//       turn  degrees the head turned since the previous reading, or null
//     now in ms. Returns 'jump' | 'crouch' | 'left' | 'right' | null.
//   enabled, setSensitivity(level), reset(), cfg()
//   setRight(x, z)         the player's right direction (horizontal, world axes)
//   beginCapture(kind)     'still' | 'jump' | 'crouch' | 'step'
//   captureResult()        { kind, done, ...measured } or null
//   cancelCapture()
//   setCalibration(c) / calibration   thresholds learned in calibration (only ever looser)

export const DEFAULTS = {
  push: 2.5,          // m/s² above rest: push-off
  ffDepth: 4.5,       // m/s² below rest: free fall
  ffTime: 0.04,       // s of free fall needed
  ffWindow: 0.6,      // s after a push-off in which the free fall must start
  wobbleMax: 0.035,   // s: one reading this long above the free-fall line is tolerated...
  wobbleBand: 2.5,    // ...while the phone is still clearly unloaded (|a| - rest < -2.5)
  cooldown: 0.7,      // s after a jump: the landing spike is not a new push-off
  crouchV: -0.4,      // m/s
  crouchDrop: -0.08,  // m below the recent high point
  vTau: 0.8, zTau: 1.2, highTau: 0.9,
  crouchAfterJump: 0.9, crouchAfterNear: 0.5, zeroAfterJump: 0.6,
  standGuard: 1.6, standGuardDepth: 7,
  stepV: 0.35,        // m/s lateral velocity
  stepX: 0.08,        // m lateral offset
  stepPeak: 1.5,      // m/s² lateral acceleration peak within peakWindow
  peakWindow: 0.4,
  lvTau: 0.5, lxTau: 0.8,
  turnRate: 90,       // °/s: faster head turns block side-steps
  turnAngle: 20,      // ° turned within turnWindow blocks side-steps
  turnWindow: 0.4,
  stepIgnore: 0.45, stepOppBlock: 0.5, stepZero: 0.5, stepAfterLand: 0.5,
  stillSpread: 0.45, stillWindow: 0.4, startIgnore: 0.6,
};

// Calibration and sensitivity never go below these.
export const FLOORS = { push: 1.5, ffDepth: 3.5, ffTime: 0.025, stepV: 0.25, stepX: 0.05, crouchV: -0.25, crouchDrop: -0.05 };
export const SENSITIVITY = { low: 0.75, normal: 1, high: 1.35 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// Fixed-size ring of (time, value) pairs: no allocation per reading.
class Ring {
  constructor(n) { this.n = n; this.t = new Float64Array(n); this.v = new Float64Array(n); this.head = 0; this.len = 0; }
  clear() { this.head = 0; this.len = 0; }
  push(t, v) {
    if (this.len === this.n) { this.head = (this.head + 1) % this.n; this.len--; }
    const i = (this.head + this.len) % this.n;
    this.t[i] = t; this.v[i] = v; this.len++;
  }
  dropBefore(tMin) { while (this.len && this.t[this.head] < tMin) { this.head = (this.head + 1) % this.n; this.len--; } }
  firstT() { return this.t[this.head]; }
  val(k) { return this.v[(this.head + k) % this.n]; }
}

export class MotionDetector {
  constructor() {
    this.enabled = true;
    this.sens = 1;
    this.calibration = null; // { push, ffDepth, ffTime, stepV, stepX, crouchV, crouchDrop }
    this.right = [1, 0];
    this.capture = null;
    this.lastEvent = null;
    this.reset();
  }

  setSensitivity(level) { this.sens = SENSITIVITY[level] || (typeof level === 'number' ? level : 1); this._cfg = null; }
  setCalibration(c) { this.calibration = c ? { ...c } : null; this._cfg = null; }
  setRight(x, z) { const l = Math.hypot(x, z) || 1; this.right = [x / l, z / l]; }

  // Effective thresholds: calibration (only looser than the defaults), then
  // sensitivity (Low/Normal/High = 0.75/1/1.35 more or less sensitive), floored.
  cfg() {
    if (this._cfg) return this._cfg;
    const D = DEFAULTS, c = this.calibration || {}, k = this.sens;
    const loosen = (key, sign = 1) => {
      const def = D[key];
      const cal = c[key] != null ? (sign > 0 ? Math.min(def, c[key]) : Math.max(def, c[key])) : def;
      return cal;
    };
    const out = { ...D };
    out.push = Math.max(FLOORS.push, loosen('push') / k);
    out.ffDepth = Math.max(FLOORS.ffDepth, loosen('ffDepth') / k);
    out.ffTime = Math.max(FLOORS.ffTime, loosen('ffTime') / k);
    out.stepV = Math.max(FLOORS.stepV, loosen('stepV') / k);
    out.stepX = Math.max(FLOORS.stepX, loosen('stepX') / k);
    out.crouchV = Math.min(FLOORS.crouchV, loosen('crouchV', -1) / k);
    out.crouchDrop = Math.min(FLOORS.crouchDrop, loosen('crouchDrop', -1) / k);
    this._cfg = out;
    return out;
  }

  reset() {
    this.t0 = null;
    this.lastT = null;
    this.period = 1 / 60;
    this.rest = this.rest || 9.81;
    if (!this.still) { this.still = new Ring(512); this.turnHist = new Ring(512); }
    this.still.clear();        // (t, |a|) over the stillness window
    this.stillTime = 0;
    this.isStill = false;
    // jump
    this.pushT = -99; this.pushPeak = 0;
    this.ffStart = null; this.ffN = 0; this.ffMin = 0; this.wobbleT = null; this.wobbleUsed = false;
    this.lastJumpT = -99; this.nearT = -99; this.inAir = false; this.landT = -99; this.zeroed = true;
    // crouch
    this.v = 0; this.z = 0; this.high = 0; this.crouchArmed = true; this.lastCrouchT = -99;
    this.crouched = false; this.standT = -99; this.pending = false; this.pendT = 0; this.pendPush = false; this.pushEndT = null;
    this.upT = null; this.sawUp = false; this.topping = false;
    // side-step
    this.lv = 0; this.lx = 0; this.posPeakT = -99; this.negPeakT = -99; this.posStartT = -99; this.negStartT = -99;
    this.posImp = 0; this.negImp = 0;
    this.restLearned = false;
    this.turnHist.clear(); this.turned = 0; this.rot = 0;
    this.lastStepT = -99; this.lastStepDir = 0; this.zeroAt = null;
    this.aLat = 0; this.av = 0; this.drop = 0;
    this._cfg = null;
  }

  // Forget the body baseline (crouch/step integrators) but keep the learned gravity.
  rebase() {
    this.v = 0; this.z = 0; this.high = 0; this.lv = 0; this.lx = 0; this.crouchArmed = true;
  }

  // ------------------------------------------------------------------ calibration capture
  beginCapture(kind) {
    this.capture = { kind, done: false, t0: null, peak: 0, depth: 0, ffDur: 0, v: 0, drop: 0, lv: 0, lx: 0, rest: null };
  }
  cancelCapture() { this.capture = null; }
  captureResult() { return this.capture; }

  // ------------------------------------------------------------------ main
  sample(r, now) {
    if (!this.enabled || r == null || r.mag == null || !isFinite(r.mag)) return null;
    const t = now / 1000;
    if (this.t0 == null) this.t0 = t;
    const gap = this.lastT == null ? this.period : t - this.lastT;
    this.lastT = t;
    // Readings arrive late, bunched or dropped: the period is the moving average
    // of the gaps (bunched readings have ~0 gaps, which averages out correctly).
    if (gap >= 0 && gap < 0.25) this.period += (gap - this.period) * 0.04;
    const dt = clamp(gap, 0.0005, 0.05);
    const C = this.capture && !this.capture.done ? this._loose() : this.cfg();
    const cap = this.capture && !this.capture.done ? this.capture : null;
    if (cap && cap.t0 == null) cap.t0 = t;

    const mag = r.mag;
    this._learnRest(t, mag, dt);
    const d = mag - this.rest;
    this.av = d;
    let ev = null;

    // ---------------- jump: push-off, then free fall
    const cooling = t - this.lastJumpT < C.cooldown;
    if (!cooling && d > C.push) {
      if (t - this.pushT > C.ffWindow) this.pushPeak = 0;
      this.pushT = t;
      this.pushPeak = Math.max(this.pushPeak, d);
    }
    // Shortly after a crouch, standing up unloads the sensor too: then only a
    // near-complete free fall counts.
    // (The guard also lasts while crouched and for 1 s after standing up starts,
    // so a long crouch can't outlast it.)
    const guard = t - this.lastCrouchT < C.standGuard || this.crouched || t - this.standT < 0.4;
    const ffLine = guard ? Math.max(C.ffDepth, C.standGuardDepth) : C.ffDepth;
    const inWindow = !cooling && t - this.pushT <= C.ffWindow;
    if (inWindow && d < -ffLine) {
      if (this.ffStart == null) { this.ffStart = t; this.ffN = 0; this.ffMin = 0; this.wobbleUsed = false; }
      this.ffN++;
      this.wobbleT = null;
      this.ffMin = Math.min(this.ffMin, d);
      this.nearT = t;
      const dur = Math.max(t - this.ffStart, (this.ffN - 1) * this.period);
      if (dur >= C.ffTime) {
        ev = 'jump';
        if (cap && cap.kind === 'jump') { cap.peak = this.pushPeak; cap.depth = -this.ffMin; cap.ffDur = dur; cap.done = true; }
        this.lastJumpT = t; this.inAir = true; this.zeroed = false;
        this.ffStart = null; this.pushT = -99;
      }
    } else if (this.ffStart != null && inWindow && d < -C.wobbleBand) {
      // Strap or viewer wobble: tolerate one short excursion above the line.
      if (this.wobbleT == null) {
        if (this.wobbleUsed) this.ffStart = null;
        else { this.wobbleUsed = true; this.wobbleT = t; this.ffN++; }
      } else if (t - this.wobbleT > C.wobbleMax) this.ffStart = null;
      else this.ffN++;
    } else {
      this.ffStart = null;
      this.wobbleT = null;
    }
    // landing (for blocking side-steps around jumps)
    if (this.inAir && ((t - this.lastJumpT > 0.06 && d > 3) || t - this.lastJumpT > 1.2)) { this.inAir = false; this.landT = t; }

    // ---------------- crouch: leaky integration of vertical acceleration
    this.v += (d - this.v / C.vTau) * dt;
    this.z += (this.v - this.z / C.zTau) * dt;
    this.high = Math.max(this.z, this.z + (this.high - this.z) * Math.exp(-dt / C.highTau));
    this.drop = this.z - this.high;
    if (!this.zeroed && t - this.lastJumpT >= C.zeroAfterJump) { this.v = 0; this.z = 0; this.high = 0; this.zeroed = true; }
    const crouchBlocked = t - this.lastJumpT < C.crouchAfterJump || t - this.nearT < C.crouchAfterNear || this.inAir;
    if (cap && cap.kind === 'crouch' && !crouchBlocked) { cap.v = Math.min(cap.v, this.v); cap.drop = Math.min(cap.drop, this.drop); }
    // A jump's countermovement (the dip before take-off) looks like the start of a
    // crouch. So a crouch waits briefly: if a push-off followed by free fall starts,
    // it was a jump and the crouch is dropped. Otherwise it is committed 120 ms
    // later (or, if there was a push, 120 ms after the push ends with no free
    // fall: that push was the crouch braking at the bottom).
    if (!ev && this.restLearned && this.crouchArmed && !this.pending && !crouchBlocked && this.v < C.crouchV && this.drop < C.crouchDrop) {
      this.pending = true; this.pendT = t; this.pendPush = false;
    }
    if (this.pending) {
      if (d > C.push) { this.pendPush = true; this.pushEndT = null; }
      if (this.pendPush && this.pushEndT == null && d < 1.0) this.pushEndT = t;
      if (crouchBlocked || (this.pendPush && d < -C.ffDepth)) {
        this.pending = false; this.crouchArmed = false; this.lastCrouchT = Math.min(this.lastCrouchT, t - 0.4);
      } else if (!ev && ((!this.pendPush && t - this.pendT >= 0.12) ||
                 (this.pendPush && this.pushEndT != null && t - this.pushEndT >= 0.12) || t - this.pendT >= 0.6)) {
        ev = 'crouch';
        this.pending = false;
        this.crouchArmed = false;
        this.crouched = true; this.upT = null; this.sawUp = false; this.topping = false;
        this.lastCrouchT = t;
        if (cap && cap.kind === 'crouch') cap.done = true;
      }
    }
    // Standing back up: an upward push, then the slow-down at the top. Until that
    // has finished, only a near-complete free fall counts as a jump.
    if (this.crouched) {
      if (d > 1.5) { if (this.upT == null) this.upT = t; if (t - this.upT > 0.08) this.sawUp = true; } else this.upT = null;
      if (this.sawUp && d < -2.0) this.topping = true;
      if ((this.topping && d > -0.5) || t - this.lastCrouchT > 6) { this.crouched = false; this.standT = t; }
    }
    if (!this.crouchArmed && !this.pending && this.v > -0.1 && t - this.lastCrouchT > 0.4) this.crouchArmed = true;

    // ---------------- side-step: lateral motion in the running frame
    if (r.ax != null) {
      const aLat = r.ax * this.right[0] + r.az * this.right[1];
      this.aLat = aLat;
      this.lv += (aLat - this.lv / C.lvTau) * dt;
      this.lx += (this.lv - this.lx / C.lxTau) * dt;
      // Peak episodes per direction, with the velocity change each one carried.
      if (aLat > C.stepPeak) {
        if (t - this.posPeakT > 0.15) { this.posStartT = t; this.posImp = 0; }
        this.posPeakT = t; this.posImp += aLat * dt;
      }
      if (aLat < -C.stepPeak) {
        if (t - this.negPeakT > 0.15) { this.negStartT = t; this.negImp = 0; }
        this.negPeakT = t; this.negImp -= aLat * dt;
      }
    }
    // How much the head turned recently (gyro, or orientation if there's no gyro).
    const rate = r.rot != null ? r.rot : r.turn != null ? r.turn / Math.max(gap, 0.004) : 0;
    this.rot = rate;
    const ang = r.turn != null ? Math.abs(r.turn) : (r.rot != null ? r.rot * dt : 0);
    const TH = this.turnHist;
    TH.push(t, ang);
    TH.dropBefore(t - C.turnWindow);
    let turned = 0;
    for (let i = 0; i < TH.len; i++) turned += TH.val(i);
    this.turned = turned;
    if (this.zeroAt != null && t >= this.zeroAt) { this.lv = 0; this.lx = 0; this.zeroAt = null; }
    if (r.ax != null) {
      const jumping = this.inAir || t - this.nearT < 0.25 || t - this.landT < C.stepAfterLand;
      const crouching = t - this.lastCrouchT < 1.2;
      const turning = rate > C.turnRate || turned > C.turnAngle;
      if (cap && cap.kind === 'step') { cap.lv = Math.max(cap.lv, Math.abs(this.lv)); cap.lx = Math.max(cap.lx, Math.abs(this.lx)); }
      // why a candidate step didn't fire (for the debug overlay and the bench)
      if (Math.abs(this.lv) > C.stepV * 0.8) {
        this.why = ev ? 'event' : jumping ? 'jumping' : crouching ? 'crouching' : turning ? `turning ${rate.toFixed(0)}°/s ${turned.toFixed(0)}°` :
          t - this.lastStepT <= C.stepIgnore ? 'just stepped' : !this.restLearned ? 'no gravity yet' : 'thresholds';
      }
      if (!ev && !jumping && !crouching && !turning && t - this.lastStepT > C.stepIgnore) {
        const dir = this.lv > 0 ? 1 : -1;
        const peakT = dir > 0 ? this.posPeakT : this.negPeakT;
        // A step starts by accelerating its own way. Acceleration that comes
        // straight after an opposite push is the braking of that step, not a new one.
        const startT = dir > 0 ? this.posStartT : this.negStartT;
        const oppStart = dir > 0 ? this.negStartT : this.posStartT;
        const oppImp = dir > 0 ? this.negImp : this.posImp;
        const braking = oppStart < startT && startT - oppStart < 0.7 && oppImp > 0.2;
        if (!braking && this.restLearned && Math.abs(this.lv) > C.stepV && this.lx * dir > C.stepX && t - peakT <= C.peakWindow &&
            !(dir === -this.lastStepDir && t - this.lastStepT < C.stepOppBlock)) {
          ev = dir > 0 ? 'right' : 'left';
          this.lastStepT = t;
          this.lastStepDir = dir;
          this.zeroAt = t + C.stepZero;
          if (cap && cap.kind === 'step') cap.done = true;
        }
      }
    }

    if (cap && cap.kind === 'still' && this.stillTime >= 1.2) { cap.rest = this.rest; cap.done = true; }
    if (ev) this.lastEvent = { ev, t };
    return ev;
  }

  // Loose thresholds used while capturing a calibration move (the floors).
  _loose() {
    const c = { ...this.cfg() };
    c.push = FLOORS.push; c.ffDepth = FLOORS.ffDepth; c.ffTime = FLOORS.ffTime;
    c.stepV = FLOORS.stepV; c.stepX = FLOORS.stepX; c.crouchV = FLOORS.crouchV; c.crouchDrop = FLOORS.crouchDrop;
    return c;
  }

  // Resting gravity: learned only while the phone is still (|a| spread over
  // 0.4 s under 0.45 m/s²), and never from the first readings, when the phone
  // is usually still being pushed into the headset.
  _learnRest(t, mag, dt) {
    const W = this.still;
    W.push(t, mag);
    W.dropBefore(t - DEFAULTS.stillWindow);
    const n = W.len;
    const span = Math.max(t - W.firstT(), (n - 1) * this.period);
    if (t - this.t0 < DEFAULTS.startIgnore || span < DEFAULTS.stillWindow * 0.9) { this.isStill = false; this.stillTime = 0; return; }
    let lo = 1e9, hi = -1e9, sum = 0;
    for (let i = 0; i < n; i++) { const v = W.val(i); if (v < lo) lo = v; if (v > hi) hi = v; sum += v; }
    this.isStill = hi - lo < DEFAULTS.stillSpread;
    if (this.isStill) {
      this.stillTime += dt;
      if (this.stillTime > 0.25 && !this.restLearned) {
        // first time we know gravity: the vertical integrators ran on a guess, start them over
        this.restLearned = true;
        this.v = 0; this.z = 0; this.high = 0;
      }
      const mean = sum / n;
      this.rest += (mean - this.rest) * (1 - Math.exp(-dt / 0.6));
    } else this.stillTime = 0;
  }

  // Calibration helpers: turn captured features into (looser-only) thresholds.
  static thresholdsFrom(captures, prev = null) {
    const c = { ...(prev || {}) };
    const D = DEFAULTS, F = FLOORS;
    const j = captures.jump;
    if (j && j.done) {
      c.push = clamp(j.peak * 0.5, F.push, D.push);
      c.ffDepth = clamp(j.depth * 0.75, F.ffDepth, D.ffDepth);
      c.ffTime = clamp(j.ffDur * 0.6, F.ffTime, D.ffTime);
    }
    const cr = captures.crouch;
    if (cr && cr.done) {
      c.crouchV = clamp(cr.v * 0.55, D.crouchV, F.crouchV);
      c.crouchDrop = clamp(cr.drop * 0.55, D.crouchDrop, F.crouchDrop);
    }
    const s = captures.step;
    if (s && s.done) {
      c.stepV = clamp(s.lv * 0.6, F.stepV, D.stepV);
      c.stepX = clamp(s.lx * 0.6, F.stepX, D.stepX);
    }
    return c;
  }
}
