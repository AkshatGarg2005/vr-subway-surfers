#!/usr/bin/env node
// Synthetic bench for the WebXR head gestures (js/headgestures.js).
// Head poses at 72 Hz with ±1 mm tracking noise. The eye point sits 10 cm in
// front of the neck's rotation axis, so turning and nodding move it a little.
import { HeadGestures } from '../js/headgestures.js';

const HZ = 72, DT = 1 / HZ;
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const mj = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : 10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5);

// A trial: functions of time for the body (x lateral, y height) and head angles.
function run(trial, seconds = 6) {
  const g = new HeadGestures();
  const evs = [];
  for (let i = 0; i < seconds * HZ; i++) {
    const t = i * DT;
    const s = trial(t);
    const yaw = s.yaw || 0, pitch = s.pitch || 0;
    // eye point 10 cm in front of the neck, neck at the body position
    const ex = (s.x || 0) - 0.1 * Math.sin(yaw) * Math.cos(pitch);
    const ez = -0.1 * Math.cos(yaw) * Math.cos(pitch);
    const ey = 1.65 + (s.y || 0) + 0.1 * Math.sin(pitch) - 0.1 * (1 - Math.cos(pitch)) * 0;
    const n = () => (rnd() - 0.5) * 0.002;
    if (i === 0) g.recenter(ex, ey, ez, 0);
    const e = g.update(ex + n(), ey + n(), ez + n(), t, DT);
    if (e) evs.push({ e, t });
  }
  return evs;
}

const cases = [];
const add = (name, expect, trial) => cases.push({ name, expect, trial });
// Steps / leans to each side and back (0.3-0.45 m)
for (const D of [0.3, 0.35, 0.45]) for (const T of [0.3, 0.6]) for (const dir of [-1, 1]) {
  add(`step ${dir > 0 ? 'right' : 'left'} ${D} m in ${T} s and back`, [dir > 0 ? 'right' : 'left', dir > 0 ? 'left' : 'right'],
    (t) => ({ x: dir * D * (mj((t - 1) / T) - mj((t - 3) / T)) }));
}
// Jumps: dip 8 cm, push up onto the toes (head +4 cm at take-off), then fly h.
for (const h of [0.05, 0.08, 0.15, 0.3]) {
  const v0 = Math.sqrt(2 * 9.81 * h), T = (2 * v0) / 9.81, Tp = 0.2;
  add(`jump ${Math.round(h * 100)} cm`, ['jump'], (t) => {
    const u = t - 2;
    if (u < 0) return { y: 0 };
    if (u < 0.25) return { y: -0.08 * Math.sin((Math.PI * u) / 0.5) ** 2 }; // dip down to -8 cm
    if (u < 0.25 + Tp) {
      // push: from -8 cm (at rest) to +4 cm at take-off, leaving at speed v0
      // (cubic Hermite through those end positions and speeds)
      const k = (u - 0.25) / Tp;
      const h00 = 2 * k ** 3 - 3 * k ** 2 + 1, h01 = -2 * k ** 3 + 3 * k ** 2, h11 = k ** 3 - k ** 2;
      return { y: -0.08 * h00 + 0.04 * h01 + v0 * Tp * h11 };
    }
    const f = u - 0.25 - Tp;
    if (f < T) return { y: 0.04 + v0 * f - 4.905 * f * f };
    const l = f - T;
    return { y: l < 0.3 ? 0.04 * (1 - l / 0.3) - 0.06 * Math.sin((Math.PI * l) / 0.3) : 0 };
  });
}
// Crouches
for (const d of [0.35, 0.5]) add(`crouch ${Math.round(d * 100)} cm`, ['crouch'], (t) => ({ y: -d * (mj((t - 1.5) / 0.5) - mj((t - 3) / 0.6)) }));
// Things that must not trigger anything
add('small lean 0.18 m', [], (t) => ({ x: 0.18 * (mj((t - 1) / 0.5) - mj((t - 3) / 0.5)) }));
add('heel raise 6 cm', [], (t) => ({ y: 0.06 * (mj((t - 1) / 0.3) - mj((t - 2) / 0.3)) }));
add('small squat 18 cm', [], (t) => ({ y: -0.18 * (mj((t - 1) / 0.5) - mj((t - 2.5) / 0.5)) }));
for (const deg of [60, 90]) for (const dir of [-1, 1]) add(`look ${dir > 0 ? 'right' : 'left'} ${deg}° and back`, [], (t) => ({ yaw: -dir * (deg * Math.PI / 180) * (mj((t - 1) / 0.4) - mj((t - 3) / 0.4)) }));
add('nodding', [], (t) => ({ pitch: (t > 1 && t < 5 ? 0.3 * Math.sin(2 * Math.PI * 1.5 * (t - 1)) : 0) }));
add('look down 45°', [], (t) => ({ pitch: -(Math.PI / 4) * (mj((t - 1) / 0.5) - mj((t - 3) / 0.5)) }));
add('swaying ±8 cm', [], (t) => ({ x: 0.08 * Math.sin(2 * Math.PI * 0.4 * t) }));

let pass = 0;
for (const c of cases) {
  const evs = run(c.trial).map((e) => e.e);
  const ok = evs.length === c.expect.length && evs.every((e, i) => e === c.expect[i]);
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(36)} expected [${c.expect.join(', ')}]  got [${evs.join(', ')}]`);
}
console.log(`\n${pass}/${cases.length} head-gesture cases passed`);
if (pass !== cases.length) process.exitCode = 1;
