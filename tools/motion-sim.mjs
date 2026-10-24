#!/usr/bin/env node
// Synthetic accelerometer bench for js/motion.js.
//
//   node tools/motion-sim.mjs [--seed 1] [--verbose] [--only jumps|nonjumps|steps|heads|gravity]
//
// Body and head motion are simulated at 1 kHz; the phone sits 9 cm in front of
// (and 10 cm above) the neck's rotation axis, so head turns, tilts and nods
// produce real sideways acceleration at the phone. Sensor readings get gravity,
// noise, a small orientation error and strap wobble, and are delivered five ways:
// exact 60 Hz, ±6 ms jitter, batched (two readings per 33 ms frame), Chrome
// under load (~30 Hz, latest value only) and a soft sensor (45 ms low-pass).
// Everything runs without calibration and after calibrating with a medium hop
// and with a big jump, then is scored against the pass criteria.
import { MotionDetector } from '../js/motion.js';

const G = 9.81;
const DT = 0.001;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SEED = Number(arg('--seed', 1));
const VERBOSE = argv.includes('--verbose');
const ONLY = arg('--only', null);

function makeRng(seed) {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  r.pick = (a) => a[Math.floor(r() * a.length)];
  return r;
}

// ------------------------------------------------------------------ timeline
// A trial is a set of 1 kHz arrays: body acceleration (world, y up, x right),
// head angles (yaw/pitch/roll, radians), and extra phone wobble.
class Trial {
  constructor(seconds, rng) {
    this.n = Math.ceil(seconds / DT);
    this.rng = rng;
    const n = this.n;
    this.bax = new Float64Array(n); this.bay = new Float64Array(n); this.baz = new Float64Array(n);
    this.yaw = new Float64Array(n); this.pitch = new Float64Array(n); this.roll = new Float64Array(n);
    this.wob = new Float64Array(n); this.wobX = new Float64Array(n);
    this.posX = new Float64Array(n);   // lateral body position (m), differentiated twice
    this.noise = 0.04;        // m/s² sensor noise
    this.rattle = 0;          // extra vibration
    this.gain = 1;            // sensor scale error on gravity
    this.events = [];         // expected: { kind, t, t1, dir }
  }
  i(t) { return Math.max(0, Math.min(this.n - 1, Math.round(t / DT))); }
  // add f(tau) to arr over [t0, t0 + dur]
  add(arr, t0, dur, f) { const a = this.i(t0), b = this.i(t0 + dur); for (let k = a; k <= b; k++) arr[k] += f((k - a) * DT, dur); }
  set(arr, t0, dur, f) { const a = this.i(t0), b = this.i(t0 + dur); for (let k = a; k <= b; k++) arr[k] = f((k - a) * DT, dur); }
}

const sinPulse = (peak) => (tau, dur) => peak * Math.sin((Math.PI * tau) / dur);
// Smooth fade in/out over the first/last `edge` seconds (no sudden starts or stops).
const env = (tau, dur, edge = 0.6) => {
  const a = Math.min(1, tau / edge, (dur - tau) / edge);
  return a <= 0 ? 0 : a * a * (3 - 2 * a);
};

// Vertical move with velocity v(t) = V sin²(πt/T): acceleration a = Vπ/T sin(2πt/T)
// (starts at zero, speeds up, slows down). Asymmetric version: accelerate with
// peak P over Ta, then decelerate with peak P*k over Ta/k.
function velocityBump(tr, arr, t0, dv, Ta, k = 1) {
  // phase 1: velocity 0 -> dv/2 ... we split the change into accel then decel lobes
  const P = (Math.PI * dv) / (2 * Ta) * 2 / 2;
  tr.add(arr, t0, Ta, (tau, d) => P * Math.sin((Math.PI * tau) / d));          // area = 2*P*Ta/π = dv
  tr.add(arr, t0 + Ta, Ta / k, (tau, d) => -P * k * Math.sin((Math.PI * tau) / d)); // area = -dv
  return Ta + Ta / k;
}

// A jump: countermovement, push, flight (free fall), landing.
function addJump(tr, t0, flight, o = {}) {
  const r = tr.rng;
  const cmDepth = o.cmDepth ?? r.range(0.06, 0.18);
  const Tcm = o.Tcm ?? r.range(0.22, 0.34);
  const Tp = o.Tp ?? r.range(0.14, 0.24);
  const Tl = o.Tl ?? r.range(0.09, 0.15);
  const v0 = (G * flight) / 2;
  // countermovement: v = -Vd sin²(πτ/Tcm), depth = Vd*Tcm/2
  const Vd = (2 * cmDepth) / Tcm;
  tr.add(tr.bay, t0, Tcm, (tau, d) => -Vd * (Math.PI / d) * Math.sin((2 * Math.PI * tau) / d));
  // push: v from 0 to v0, a = v0π/(2Tp) sin(πτ/Tp)
  const tp = t0 + Tcm;
  tr.add(tr.bay, tp, Tp, sinPulse((v0 * Math.PI) / (2 * Tp)));
  const to = tp + Tp; // take-off
  tr.add(tr.bay, to, flight, () => -G);
  const land = to + flight;
  tr.add(tr.bay, land, Tl, sinPulse((v0 * Math.PI) / (2 * Tl)));
  tr.add(tr.bay, land, 0.025, sinPulse(o.heel ?? r.range(4, 10)));
  tr.add(tr.bay, land + Tl, 0.4, (tau) => 2.2 * Math.sin(2 * Math.PI * 4 * tau) * Math.exp(-tau / 0.12));
  // strap / viewer wobble, excited at take-off
  const A = o.wobble ?? r.range(0.8, 3.0), f = r.range(12, 22), ph = r.range(0, 6.28);
  tr.add(tr.wob, to, flight + 0.05, (tau) => A * Math.sin(2 * Math.PI * f * tau + ph) * Math.exp(-tau / 0.2));
  tr.add(tr.wobX, to, flight + 0.05, (tau) => A * 0.6 * Math.sin(2 * Math.PI * f * 1.1 * tau) * Math.exp(-tau / 0.2));
  if (o.spike) {
    // one wobbly reading mid-air: the phone briefly loaded (~30 ms)
    const ts = to + flight * r.range(0.35, 0.6) - 0.015;
    tr.add(tr.wob, ts, 0.03, sinPulse(o.spike));
  }
  tr.events.push({ kind: 'jump', t: to, t1: land + 0.4 });
  return land + Tl + 0.4;
}

// Crouch down, hold, stand up (stand-up acceleration peak = standPeak).
function addCrouch(tr, t0, depth, standPeak, hold) {
  const r = tr.rng;
  // down: v = -Vd sin²(πτ/Td)
  const Td = r.range(0.6, 1.0);
  const Vd = (2 * depth) / Td;
  tr.add(tr.bay, t0, Td, (tau, d) => -Vd * (Math.PI / d) * Math.sin((2 * Math.PI * tau) / d));
  const tu = t0 + Td + hold;
  // up: push with peak standPeak, then a gentler slow-down (people ease into standing)
  const k = 0.75;
  const P = standPeak;
  // push lobe (peak P, Ta) then a gentler slow-down lobe (peak kP, Ta/k): rises by `depth`
  const Ta = Math.sqrt((Math.PI * depth) / (P * (1 + 1 / k)));
  const dv = (2 * P * Ta) / Math.PI;
  tr.add(tr.bay, tu, Ta, sinPulse(P));
  tr.add(tr.bay, tu + Ta, Ta / k, sinPulse(-P * k));
  // the stand-up must also bring the body back up `depth`: close enough for the sensor model
  tr.events.push({ kind: 'crouch', t: t0, t1: tu + Ta + Ta / k + 0.3, standPeak });
  return tu + Ta + Ta / k + 0.3 + dv * 0;
}

// Sideways step of D metres (signed) over T seconds, minimum-jerk profile.
function addStep(tr, t0, D, T, o = {}) {
  const r = tr.rng;
  tr.add(tr.bax, t0, T, (tau, d) => { const u = tau / d; return (D / (d * d)) * (60 * u - 180 * u * u + 120 * u * u * u); });
  // weight shift: a small dip and rise, and the foot landing
  tr.add(tr.bay, t0, T, (tau, d) => (o.bob ?? 1.4) * Math.sin((2 * Math.PI * tau) / d));
  tr.add(tr.bay, t0 + T * 0.7, 0.05, sinPulse(o.impact ?? r.range(1, 3)));
  // people turn their head a little when they step
  const yawA = (r.range(-4, 4) * Math.PI) / 180;
  tr.add(tr.yaw, t0, T * 1.5, (tau, d) => yawA * Math.sin((Math.PI * tau) / d) ** 2);
  tr.events.push({ kind: 'step', t: t0, t1: t0 + T + 0.35, dir: Math.sign(D), D: Math.abs(D), T });
  return t0 + T;
}

// Head yaw turn of `deg` degrees at peak rate `rate` °/s (min-jerk), and back.
function addTurn(tr, t0, deg, rate, back = true) {
  const T = (1.875 * Math.abs(deg)) / rate;
  const a = (deg * Math.PI) / 180;
  const mj = (u) => 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5;
  const base = tr.yaw[tr.i(t0)];
  tr.set(tr.yaw, t0, T, (tau, d) => base + a * mj(tau / d));
  let t = t0 + T;
  const hold = tr.rng.range(0.3, 0.8);
  tr.set(tr.yaw, t, hold, () => base + a);
  t += hold;
  if (back) { tr.set(tr.yaw, t, T, (tau, d) => base + a * (1 - mj(tau / d))); t += T; }
  else tr.set(tr.yaw, t, tr.n * DT - t, () => base + a);
  return t;
}

// ------------------------------------------------------------------ sensor
const R0 = [0, 0.1, -0.09]; // phone offset from the neck pivot (up, forward)

function phonePos(yaw, pitch, roll, out) {
  // rotate R0 by roll (about z), then pitch (about x), then yaw (about y)
  let [x, y, z] = R0;
  let c = Math.cos(roll), s = Math.sin(roll);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(pitch); s = Math.sin(pitch);
  [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(yaw); s = Math.sin(yaw);
  [x, z] = [x * c + z * s, -x * s + z * c];
  out[0] = x; out[1] = y; out[2] = z;
}

// Truth signals at 1 kHz: |a|, world linear acceleration, rotation rate.
function truth(tr) {
  const n = tr.n, r = tr.rng;
  const mag = new Float64Array(n), ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n), rot = new Float64Array(n);
  const P = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const tmp = [0, 0, 0];
  for (let k = 0; k < n; k++) { phonePos(tr.yaw[k], tr.pitch[k], tr.roll[k], tmp); P[0][k] = tmp[0]; P[1][k] = tmp[1]; P[2][k] = tmp[2]; }
  // small, slowly varying orientation error in the gravity-free world vector
  const err = (r.range(-2, 2) * Math.PI) / 180;
  const ce = Math.cos(err), se = Math.sin(err);
  for (let k = 0; k < n; k++) {
    const km = Math.max(0, k - 1), kp = Math.min(n - 1, k + 1);
    const hx = (P[0][kp] - 2 * P[0][k] + P[0][km]) / (DT * DT);
    const hy = (P[1][kp] - 2 * P[1][k] + P[1][km]) / (DT * DT);
    const hz = (P[2][kp] - 2 * P[2][k] + P[2][km]) / (DT * DT);
    const px = (tr.posX[kp] - 2 * tr.posX[k] + tr.posX[km]) / (DT * DT);
    const lx = tr.bax[k] + hx + tr.wobX[k] + px, ly = tr.bay[k] + hy + tr.wob[k], lz = tr.baz[k] + hz;
    const nz = () => r.gauss() * (tr.noise + tr.rattle);
    const gx = lx + nz(), gy = ly + G * tr.gain + nz(), gz = lz + nz();
    mag[k] = Math.sqrt(gx * gx + gy * gy + gz * gz);
    ax[k] = (lx * ce - lz * se) + r.gauss() * (0.05 + tr.rattle * 0.7);
    ay[k] = ly + r.gauss() * (0.05 + tr.rattle * 0.7);
    az[k] = (lx * se + lz * ce) + r.gauss() * (0.05 + tr.rattle * 0.7);
    const dy = (tr.yaw[kp] - tr.yaw[km]) / (2 * DT), dp = (tr.pitch[kp] - tr.pitch[km]) / (2 * DT), dr = (tr.roll[kp] - tr.roll[km]) / (2 * DT);
    rot[k] = (Math.sqrt(dy * dy + dp * dp + dr * dr) * 180) / Math.PI + Math.abs(r.gauss()) * 1.0;
  }
  return { mag, ax, ay, az, rot };
}

function lowpass(arr, tau) {
  const out = new Float64Array(arr.length);
  const k = 1 - Math.exp(-DT / tau);
  let y = arr[0];
  for (let i = 0; i < arr.length; i++) { y += (arr[i] - y) * k; out[i] = y; }
  return out;
}

// Turn truth into delivered readings: [{ now (ms), mag, ax, ay, az, rot, turn }].
function deliver(tr, T, mode, rng) {
  let { mag, ax, ay, az, rot } = T;
  if (mode === 'soft') { mag = lowpass(mag, 0.045); ax = lowpass(ax, 0.045); ay = lowpass(ay, 0.045); az = lowpass(az, 0.045); }
  const out = [];
  const period = 1000 / 60;
  let lastAng = null;
  const angAt = (k) => [tr.yaw[k], tr.pitch[k], tr.roll[k]];
  const reading = (k, now) => {
    const a = angAt(k);
    let turn = 0;
    if (lastAng) { const d0 = a[0] - lastAng[0], d1 = a[1] - lastAng[1], d2 = a[2] - lastAng[2]; turn = (Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2) * 180) / Math.PI; }
    lastAng = a;
    return { now, mag: mag[k], ax: ax[k], ay: ay[k], az: az[k], rot: rot[k], turn };
  };
  const N = Math.floor((tr.n * DT * 1000) / period);
  let lastNow = 0;
  for (let j = 0; j < N; j++) {
    const ts = j * period;
    const k = Math.min(tr.n - 1, Math.round(ts));
    if (mode === 'exact' || mode === 'soft') out.push(reading(k, ts));
    else if (mode === 'jitter') { const now = Math.max(lastNow, ts + rng.range(-6, 6)); lastNow = now; out.push(reading(k, now)); }
    else if (mode === 'batched') {
      // two readings per 33 ms frame, both handed over at the end of the frame
      if (j % 2 === 1) { const prev = Math.min(tr.n - 1, Math.round(ts - period)); const now = ts + 1.5; out.push(reading(prev, now), reading(k, now)); }
    } else if (mode === 'load30') {
      if (j % 2 === 1) { const now = Math.max(lastNow, ts + rng.range(0, 5)); lastNow = now; out.push(reading(k, now)); }
    }
  }
  return out;
}

const MODES = ['exact', 'jitter', 'batched', 'load30', 'soft'];

// Run readings through a detector; returns events [{ ev, t }].
function run(det, readings) {
  const evs = [];
  for (const r of readings) { const e = det.sample(r, r.now); if (e) evs.push({ ev: e, t: r.now / 1000 }); }
  return evs;
}

function freshDetector(cal, sens = 'normal') {
  const d = new MotionDetector();
  d.setSensitivity(sens);
  d.setCalibration(cal);
  d.setRight(1, 0);
  return d;
}

// ------------------------------------------------------------------ calibration
function calibrate(kind, seed) {
  const rng = makeRng(seed);
  const det = freshDetector(null);
  const tr = new Trial(14, rng);
  // still 2.5 s, jump, crouch, step out and back
  let t = 2.5;
  const flight = kind === 'big' ? 0.36 : 0.2;
  const jEnd = addJump(tr, t, flight, { wobble: 1.5 });
  const cEnd = addCrouch(tr, jEnd + 1.2, 0.4, 3.5, 0.6);
  const sEnd = addStep(tr, cEnd + 1.6, 0.3, 0.45);
  addStep(tr, sEnd + 1.2, -0.3, 0.45);
  const T = truth(tr);
  const readings = deliver(tr, T, 'exact', rng);
  const caps = {};
  const order = [['still', 0], ['jump', t - 0.6], ['crouch', jEnd + 1.0], ['step', cEnd + 1.4]];
  let oi = 0;
  for (const r of readings) {
    const ts = r.now / 1000;
    if (oi < order.length && ts >= order[oi][1]) { det.beginCapture(order[oi][0]); oi++; }
    det.sample(r, r.now);
    const c = det.captureResult();
    if (c && c.done && !caps[c.kind]) caps[c.kind] = { ...c };
  }
  return { thresholds: MotionDetector.thresholdsFrom(caps), caps };
}

// ------------------------------------------------------------------ suites
function jumpSuite(cal, seed) {
  const res = { trials: 0, bigTrials: 0, bigHits: 0, small: 0, smallHits: 0, lat: [], perMode: {}, lateral: 0, crouchFalse: 0 };
  const flights = [0.1, 0.13, 0.15, 0.18, 0.22, 0.27, 0.32];
  for (const mode of MODES) {
    const pm = (res.perMode[mode] = { n: 0, hit: 0 });
    for (const flight of flights) {
      for (let rep = 0; rep < 6; rep++) {
        const rng = makeRng(seed * 7919 + flight * 1000 + rep * 31 + MODES.indexOf(mode) * 101);
        const tr = new Trial(5, rng);
        const end = addJump(tr, 2.2, flight, { spike: rep === 2 ? rng.range(5.2, 6.2) : 0, wobble: rep === 4 ? 3.5 : undefined });
        const T = truth(tr);
        const evs = run(freshDetector(cal), deliver(tr, T, mode, rng));
        const exp = tr.events[0];
        const hit = evs.find((e) => e.ev === 'jump' && e.t >= exp.t - 0.15 && e.t <= exp.t1);
        const big = flight >= 0.13;
        res.trials++;
        if (big) { res.bigTrials++; pm.n++; if (hit) { res.bigHits++; pm.hit++; } }
        else { res.small++; if (hit) res.smallHits++; }
        if (hit) res.lat.push(hit.t - exp.t);
        res.lateral += evs.filter((e) => e.ev === 'left' || e.ev === 'right').length;
        res.crouchFalse += evs.filter((e) => e.ev === 'crouch').length;
        if (VERBOSE && big && !hit) console.log(`   miss: jump flight ${flight} mode ${mode} rep ${rep}`, evs);
        void end;
      }
    }
  }
  return res;
}

function nonJumpSuite(cal, seed, sens = 'normal') {
  const kinds = ['still', 'rattle', 'nod', 'look', 'march', 'fastmarch', 'heels'];
  const res = { falseJumps: {}, falseSteps: 0, standUp: { upTo6: 0, upTo6Trials: 0, over6: 0, over6Trials: 0, crouchHits: 0, crouchTrials: 0 } };
  for (const kind of kinds) res.falseJumps[kind] = 0;
  for (const mode of MODES) {
    for (const kind of kinds) {
      for (let rep = 0; rep < 3; rep++) {
        const rng = makeRng(seed * 104729 + kinds.indexOf(kind) * 17 + rep * 3 + MODES.indexOf(mode) * 1009);
        const tr = new Trial(14, rng);
        if (kind === 'rattle') { tr.rattle = rng.range(0.5, 1.1); }
        if (kind === 'nod') { const A = (rng.range(10, 20) * Math.PI) / 180, f = rng.range(1, 2); tr.set(tr.pitch, 2, 10, (tau, d) => A * env(tau, d) * Math.sin(2 * Math.PI * f * tau)); }
        if (kind === 'look') { let t = 2; while (t < 12) t = addTurn(tr, t, rng.range(30, 90) * (rng() < 0.5 ? -1 : 1), rng.range(120, 300)) + 0.3; }
        if (kind === 'march' || kind === 'fastmarch') {
          const rate = kind === 'march' ? rng.range(1.6, 2.2) : rng.range(2.8, 3.4);
          const imp = kind === 'march' ? rng.range(2.5, 4.5) : rng.range(5, 8);
          const unl = kind === 'march' ? rng.range(1.5, 3) : rng.range(3, 4.5);
          for (let t = 2, i = 0; t < 12; t += 1 / rate, i++) {
            tr.add(tr.bay, t, 0.06, sinPulse(imp));
            tr.add(tr.bay, t + 0.08, 0.1, sinPulse(-unl));
            tr.add(tr.bax, t, 1 / rate, sinPulse((i % 2 ? 1 : -1) * 0.35));
          }
        }
        if (kind === 'heels') {
          for (let t = 2; t < 11; t += 2.2) {
            velocityBump(tr, tr.bay, t, 0.25, 0.22, 1);
            tr.add(tr.bay, t + 1.1, 0.12, sinPulse(-rng.range(2.5, 3.5)));
            tr.add(tr.bay, t + 1.22, 0.08, sinPulse(rng.range(4, 6)));
          }
        }
        const T = truth(tr);
        const evs = run(freshDetector(cal, sens), deliver(tr, T, mode, rng));
        res.falseJumps[kind] += evs.filter((e) => e.ev === 'jump').length;
        res.falseSteps += evs.filter((e) => e.ev === 'left' || e.ev === 'right').length;
        if (VERBOSE && evs.some((e) => e.ev === 'jump')) console.log(`   false jump: ${kind} ${mode} rep ${rep}`, evs);
      }
    }
    // crouches with stand-up peaks of 2.5..8 m/s²
    for (const peak of [2.5, 3.5, 4.5, 5.5, 6, 7, 8]) {
      for (let rep = 0; rep < 2; rep++) {
        const rng = makeRng(seed * 31337 + peak * 10 + rep + MODES.indexOf(mode) * 77);
        const tr = new Trial(7, rng);
        addCrouch(tr, 2.2, rng.range(0.3, 0.5), peak, rng.range(0.3, 1.4));
        const T = truth(tr);
        const evs = run(freshDetector(cal, sens), deliver(tr, T, mode, rng));
        const jumps = evs.filter((e) => e.ev === 'jump').length;
        const S = res.standUp;
        if (peak <= 6) { S.upTo6 += jumps; S.upTo6Trials++; } else { S.over6 += jumps; S.over6Trials++; }
        S.crouchTrials++;
        if (evs.some((e) => e.ev === 'crouch')) S.crouchHits++;
        res.falseSteps += evs.filter((e) => e.ev === 'left' || e.ev === 'right').length;
        if (VERBOSE && peak <= 6 && jumps) console.log(`   stand-up jump: peak ${peak} ${mode} rep ${rep}`, evs);
      }
    }
  }
  return res;
}

function stepSuite(cal, seed) {
  const res = { n: 0, hit: 0, right: 0, wrongDir: 0, smallN: 0, smallHit: 0, opposite: 0, lat: [], latQ: [], latS: [], perMode: {}, falseJumps: 0, backN: 0, backHit: 0 };
  for (const mode of MODES) {
    const pm = (res.perMode[mode] = { n: 0, hit: 0 });
    for (const D of [0.15, 0.2, 0.25, 0.3, 0.4]) {
      for (const speed of ['quick', 'slow']) {
        for (const dir of [-1, 1]) {
          for (let rep = 0; rep < 3; rep++) {
            const rng = makeRng(seed * 9973 + D * 1000 + (speed === 'quick' ? 1 : 2) * 7 + dir * 3 + rep * 13 + MODES.indexOf(mode) * 997);
            const T0 = speed === 'quick' ? rng.range(0.25, 0.38) : rng.range(0.45, 0.65);
            const tr = new Trial(6, rng);
            addStep(tr, 2.2, dir * D, T0);
            // half of the trials step back to the middle afterwards
            const back = rep === 1;
            if (back) addStep(tr, 2.2 + T0 + rng.range(1.0, 1.6), -dir * D, T0);
            const Tr = truth(tr);
            const evs = run(freshDetector(cal), deliver(tr, Tr, mode, rng));
            const lat = evs.filter((e) => e.ev === 'left' || e.ev === 'right');
            const e0 = tr.events[0];
            const first = lat.find((e) => e.t >= e0.t - 0.05 && e.t <= e0.t1);
            const firstOK = first && (first.ev === 'right' ? 1 : -1) === dir;
            res.falseJumps += evs.filter((e) => e.ev === 'jump').length;
            // any event in the opposite direction while stopping the first step
            const stopWin = lat.filter((e) => e.t > e0.t && e.t <= e0.t + e0.T + 0.8 && (e.ev === 'right' ? 1 : -1) === -dir);
            res.opposite += stopWin.length;
            if (D >= 0.2) {
              res.n++; pm.n++;
              if (first) { res.hit++; pm.hit++; if (firstOK) res.right++; else res.wrongDir++; res.lat.push(first.t - e0.t); (speed === 'quick' ? res.latQ : res.latS).push(first.t - e0.t); }
            } else { res.smallN++; if (firstOK) res.smallHit++; }
            if (back && D >= 0.2) {
              const e1 = tr.events[1];
              res.backN++;
              if (lat.some((e) => e.t >= e1.t - 0.05 && e.t <= e1.t1 && (e.ev === 'right' ? 1 : -1) === -dir)) res.backHit++;
            }
            if (VERBOSE && D >= 0.2 && !firstOK) {
              // replay to see what the detector saw
              const det = freshDetector(cal);
              let maxLv = 0, maxLx = 0, why = new Set(), brk = 0;
              const trace = [];
              for (const r of deliver(tr, Tr, mode, makeRng(1))) {
                det.sample(r, r.now);
                if (argv.includes('--trace') && r.now / 1000 > e0.t - 0.1 && r.now / 1000 < e0.t + e0.T + 0.3) trace.push(`${(r.now / 1000 - e0.t).toFixed(3)} a${r.ax.toFixed(2)} lv${det.lv.toFixed(2)} lx${det.lx.toFixed(3)} rot${r.rot.toFixed(0)} turn${det.turned.toFixed(1)} ${det.why || ''}`);
                if (r.now / 1000 > e0.t && r.now / 1000 < e0.t1) {
                  maxLv = Math.max(maxLv, det.lv * dir); maxLx = Math.max(maxLx, det.lx * dir);
                  if (det.why) why.add(det.why);
                }
              }
              if (trace.length) { console.log(trace.join('\n')); process.exit(0); }
              console.log(`   step miss: D ${D} T ${T0.toFixed(2)} dir ${dir} ${mode} rep ${rep} got ${JSON.stringify(lat.map((e) => e.ev + '@' + (e.t - e0.t).toFixed(2)))} maxLv ${maxLv.toFixed(2)} maxLx ${maxLx.toFixed(3)} why ${[...why].join('|')}`);
            }
          }
        }
      }
    }
  }
  return res;
}

// Head movements (and jumps/crouches) must never change lanes.
function headSuite(cal, seed) {
  const res = { turns: 0, tilts: 0, nods: 0, sway: 0, trials: 0 };
  for (const mode of MODES) {
    for (let rep = 0; rep < 6; rep++) {
      const rng = makeRng(seed * 4241 + rep * 7 + MODES.indexOf(mode) * 131);
      // turns of 30..90° at up to 300°/s
      {
        const tr = new Trial(14, rng);
        let t = 2;
        while (t < 12) t = addTurn(tr, t, rng.range(30, 90) * (rng() < 0.5 ? -1 : 1), rng.range(60, 300), rng() < 0.7) + rng.range(0.2, 0.6);
        res.turns += countLat(tr, cal, mode, rng);
      }
      // tilting side to side
      {
        const tr = new Trial(12, rng);
        const A = (rng.range(15, 30) * Math.PI) / 180, f = rng.range(0.5, 1.5);
        tr.set(tr.roll, 2, 9, (tau, d) => A * env(tau, d) * Math.sin(2 * Math.PI * f * tau));
        res.tilts += countLat(tr, cal, mode, rng);
      }
      // nodding
      {
        const tr = new Trial(12, rng);
        const A = (rng.range(10, 20) * Math.PI) / 180, f = rng.range(1, 2);
        tr.set(tr.pitch, 2, 9, (tau, d) => A * env(tau, d) * Math.sin(2 * Math.PI * f * tau));
        res.nods += countLat(tr, cal, mode, rng);
      }
      // swaying while standing
      {
        const tr = new Trial(14, rng);
        const A = rng.range(0.02, 0.06), f = rng.range(0.3, 0.9);
        // body sways side to side (position), the head tilts a little with it
        tr.set(tr.posX, 2, 11, (tau, d) => A * env(tau, d, 1.5) * Math.sin(2 * Math.PI * f * tau));
        tr.set(tr.roll, 2, 11, (tau, d) => A * 1.5 * env(tau, d, 1.5) * Math.sin(2 * Math.PI * f * tau));
        res.sway += countLat(tr, cal, mode, rng);
      }
      res.trials += 4;
    }
  }
  return res;
}
function countLat(tr, cal, mode, rng) {
  const evs = run(freshDetector(cal), deliver(tr, truth(tr), mode, rng));
  const n = evs.filter((e) => e.ev === 'left' || e.ev === 'right').length;
  if (VERBOSE && n) console.log('   lateral from head move', mode, evs);
  return n;
}

// Wrong gravity at start: the phone's |g| reads 10.4 (scale error) while being
// pushed into the headset for 1.5 s, then held still. It must recover.
function gravitySuite(seed) {
  const out = [];
  for (const gain of [0.95, 1.06]) {
    const rng = makeRng(seed * 13 + gain * 100);
    const tr = new Trial(16, rng);
    tr.gain = gain;
    // fumbling with the headset for the first 1.5 s
    tr.set(tr.bay, 0, 1.5, (tau) => 3 * Math.sin(2 * Math.PI * 3.1 * tau) + 2 * Math.sin(2 * Math.PI * 7.3 * tau));
    tr.set(tr.pitch, 0, 1.5, (tau) => 0.5 * Math.sin(2 * Math.PI * 1.3 * tau));
    addJump(tr, 8, 0.18);
    const det = freshDetector(null);
    const T = truth(tr);
    const readings = deliver(tr, T, 'exact', rng);
    let recovered = null;
    const evs = [];
    for (const r of readings) {
      const e = det.sample(r, r.now);
      if (e) evs.push({ ev: e, t: r.now / 1000 });
      if (recovered == null && Math.abs(det.rest - G * gain) < 0.08 && r.now > 1500) recovered = r.now / 1000;
    }
    out.push({ trueG: +(G * gain).toFixed(2), learned: +det.rest.toFixed(2), recoveredAt: recovered, jumpDetected: evs.some((e) => e.ev === 'jump' && e.t > 8), falseEvents: evs.filter((e) => e.t < 7.5).length });
  }
  return out;
}

// ------------------------------------------------------------------ main
const pct = (a, b) => (b ? (100 * a) / b : 100);
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const rows = [];
const check = (name, value, pass) => rows.push({ name, value, pass });
const info = (name, value) => rows.push({ name, value, pass: true, info: true });

const t0 = Date.now();
const cals = [['none', null]];
for (const kind of ['medium', 'big']) {
  const c = calibrate(kind, SEED + (kind === 'big' ? 5 : 3));
  cals.push([kind, c.thresholds]);
  console.log(`calibrated with a ${kind} ${kind === 'big' ? 'jump' : 'hop'}:`, Object.entries(c.thresholds).map(([k, v]) => `${k} ${(+v).toFixed(3)}`).join(', ') || '(no captures)',
    ` [captured: ${Object.keys(c.caps).join(', ')}]`);
}

for (const [name, cal] of cals) {
  const tag = name === 'none' ? 'no calibration' : `calibrated (${name})`;
  if (!ONLY || ONLY === 'jumps') {
    const j = jumpSuite(cal, SEED);
    const worst = Object.entries(j.perMode).map(([m, v]) => [m, pct(v.hit, v.n)]).sort((a, b) => a[1] - b[1])[0];
    check(`[${tag}] jumps ≥0.13 s detected, worst mode (${worst[0]})`, `${worst[1].toFixed(1)}%  (all: ${pct(j.bigHits, j.bigTrials).toFixed(1)}%, 0.10 s hops: ${pct(j.smallHits, j.small).toFixed(0)}%)`, worst[1] >= 95);
    check(`[${tag}] median latency after take-off`, `${(median(j.lat) * 1000).toFixed(0)} ms`, median(j.lat) <= 0.12);
    check(`[${tag}] lane changes during jumps`, String(j.lateral), j.lateral === 0);
    info(`[${tag}] crouch (roll) events during jumps`, `${j.crouchFalse} in ${j.trials} jumps`);
    if (VERBOSE) console.log('   per mode', j.perMode, 'crouch events during jumps', j.crouchFalse);
  }
  if (!ONLY || ONLY === 'nonjumps') {
    const nj = nonJumpSuite(cal, SEED);
    const fj = nj.falseJumps;
    const total = fj.still + fj.nod + fj.look + fj.march;
    check(`[${tag}] false jumps: still/nod/look/march (Normal)`, `${total}  (rattle ${fj.rattle}, fast march ${fj.fastmarch}, heel raises ${fj.heels})`, total === 0);
    check(`[${tag}] false jumps from stand-ups ≤ 6 m/s²`, `${nj.standUp.upTo6} in ${nj.standUp.upTo6Trials}  (7–8 m/s²: ${nj.standUp.over6} in ${nj.standUp.over6Trials}; crouches detected ${nj.standUp.crouchHits}/${nj.standUp.crouchTrials})`, nj.standUp.upTo6 === 0);
    check(`[${tag}] lane changes from crouches and other non-jumps`, String(nj.falseSteps), nj.falseSteps === 0);
  }
  if (!ONLY || ONLY === 'steps') {
    const s = stepSuite(cal, SEED);
    const worst = Object.entries(s.perMode).map(([m, v]) => [m, pct(v.hit, v.n)]).sort((a, b) => a[1] - b[1])[0];
    check(`[${tag}] side-steps ≥0.2 m detected, worst mode (${worst[0]})`, `${worst[1].toFixed(1)}%  (all ${pct(s.hit, s.n).toFixed(1)}%, 0.15 m: ${pct(s.smallHit, s.smallN).toFixed(0)}%, back to middle ${pct(s.backHit, s.backN).toFixed(0)}%)`, worst[1] >= 95);
    check(`[${tag}] side-steps in the right direction`, `${pct(s.right, s.hit).toFixed(1)}%`, pct(s.right, s.hit) >= 98);
    info(`[${tag}] side-step latency from step start (median)`, `quick steps ${(median(s.latQ) * 1000).toFixed(0)} ms, slow steps ${(median(s.latS) * 1000).toFixed(0)} ms (target 150 ms)`);
    check(`[${tag}] stopping a step fires the opposite way`, String(s.opposite), s.opposite === 0);
    check(`[${tag}] false jumps from side-steps`, String(s.falseJumps), s.falseJumps === 0);
  }
  if (!ONLY || ONLY === 'heads') {
    const h = headSuite(cal, SEED);
    const tot = h.turns + h.tilts + h.nods + h.sway;
    check(`[${tag}] lane changes from head turns/tilts/nods/sway`, `${tot}  (turns ${h.turns}, tilts ${h.tilts}, nods ${h.nods}, sway ${h.sway}; ${h.trials} trials)`, tot === 0);
  }
}
if (!ONLY || ONLY === 'gravity') {
  const gs = gravitySuite(SEED);
  for (const g of gs) {
    check(`wrong gravity baseline at start (true |g| ${g.trueG})`, `learned ${g.learned}, recovered at ${g.recoveredAt != null ? g.recoveredAt.toFixed(1) + ' s' : 'never'}, jump after: ${g.jumpDetected ? 'yes' : 'no'}, events while settling: ${g.falseEvents}`, g.recoveredAt != null && g.jumpDetected && g.falseEvents === 0);
  }
}

const w = Math.max(...rows.map((r) => r.name.length));
console.log('');
for (const r of rows) console.log(`${r.info ? 'info' : r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.value}`);
const failed = rows.filter((r) => !r.pass).length;
const nChecks = rows.filter((r) => !r.info).length;
console.log(`\n${nChecks - failed}/${nChecks} checks passed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
if (failed) process.exitCode = 1;
