#!/usr/bin/env node
// Solvability check for the pattern generator, using the game's own physics.
//
//   node tools/solvable.mjs [--seeds 1,2,3] [--km 5] [--only screen|vr] [--jobs 8]
//                           [--what-if vr.jumpV=7,vr.gravity=40]
//
// --what-if overrides tuning values (MODES.<mode>.<key> or OBST.<kind>.<key>)
// to see whether a change would make the track impossible.
//
// For each mode, each speed preset's minimum and maximum speed, with and
// without super sneakers, and several seeds, it generates `km` of track and:
//  1. Rows: rebuilds the rows from the obstacles (independently of the
//     generator) and checks every row has a passable lane and that rows that
//     force a lane change are at least speed * (lanes * lane time + 0.35 s) apart.
//  2. Windows: for every hurdle and barrier, simulates the jump arc / roll with
//     js/physics.js at that speed and measures the range of take-off times that
//     clears it. A window under MIN_WINDOW fails. Every ramp is ridden straight
//     up, along the roof and off the end: that must be clean too.
//  3. Path: a beam search runs the real PlayerBody through the whole track
//     (jump, roll, left, right or nothing every few hundredths of a second) and
//     must find a clean path: no stumbles, no crashes.
// Any failure prints the seed and the distance of the impossible spot, and the
// process exits with code 1.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { modeConfig, VR_SPEEDS, MODES, BODY, OBST, ROOF_Y } from '../js/config.js';
import { PatternGenerator } from '../js/patterns.js';
import { PlayerBody, EV, obstacleS0 } from '../js/physics.js';

const MIN_WINDOW = 0.12;   // s: shortest acceptable take-off window for a jump or roll
const REACT = 0.35;        // s: reaction time in the spacing rule

// ------------------------------------------------------------------ jobs
function jobList(argv) {
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const seeds = get('--seeds', '1,2,3').split(',').map(Number);
  const km = Number(get('--km', 5));
  const only = get('--only', null);
  const whatIf = {};
  for (const kv of (get('--what-if', '') || '').split(',').filter(Boolean)) {
    const [k, val] = kv.split('=');
    whatIf[k] = Number(val);
  }
  const jobs = [];
  const speeds = [];
  if (only !== 'vr') speeds.push(['screen', 'screen', MODES.screen.v0], ['screen', 'screen', MODES.screen.v1]);
  if (only !== 'screen') {
    const vs = new Set();
    for (const [name, [a, b]] of Object.entries(VR_SPEEDS)) {
      if (!vs.has(a)) { vs.add(a); speeds.push(['vr', name, a]); }
      if (!vs.has(b)) { vs.add(b); speeds.push(['vr', name, b]); }
    }
  }
  for (const [mode, preset, v] of speeds) for (const sneakers of [false, true]) for (const seed of seeds) jobs.push({ mode, preset, v, sneakers, seed, km, whatIf });
  return { jobs, jobsN: Number(get('--jobs', Math.max(1, os.cpus().length - 1))) };
}

// ------------------------------------------------------------------ one job
function applyWhatIf(whatIf) {
  for (const [k, val] of Object.entries(whatIf || {})) {
    const [a, b] = k.split('.');
    const table = MODES[a] || OBST[a];
    if (!table || !(b in table)) throw new Error('unknown --what-if key ' + k);
    table[b] = val;
  }
}

function runJob({ mode, preset, v, sneakers, seed, km, whatIf }) {
  applyWhatIf(whatIf);
  const cfg = modeConfig(mode, preset);
  const gen = new PatternGenerator({ seed, cfg, planSpeed: () => v, coins: false, powerups: false });
  const end = km * 1000;
  gen.generateUntil(end + 200);
  const obs = gen.items.filter((it) => it.type === 'ob').map((it) => it.ob);
  const fails = [];
  const rowRes = checkRows(obs, cfg, v, end, fails);
  const win = checkWindows(obs, cfg, v, sneakers, end, fails);
  const path = searchPath(obs, cfg, v, sneakers, end, fails);
  return { mode, preset, v, sneakers, seed, rows: rowRes.rows, obstacles: obs.length, minJump: win.jump, minRoll: win.roll, path, fails: fails.slice(0, 6) };
}

// 1. Rows rebuilt from the obstacles (independently of the generator's own bookkeeping).
// Rule: every lane a player can be in at one row must reach a passable lane of
// the next row; each sideways move needs both lanes clear for
// speed * (lane-change time + 0.35 s reaction), starting no earlier than a
// reaction time after the previous row, and finishing before the next.
function checkRows(obs, cfg, v, end, fails) {
  const rowMap = new Map();
  const block = [[], [], []]; // can't be here on the ground: [a, b]
  const act = [[], [], []];   // jump/roll obstacles: fine to run through, not to cut across
  const roofEnd = [];         // { lane, s, end } a ramp at s leads up to a roof ending at end
  for (const ob of obs) {
    let s = ob.s0;
    if (ob.kind === 'train' && ob.moving) {
      s = ob.moving.sMeet;
      block[ob.lane].push([s, s + ob.len / (1 + ob.moving.k)]);
    } else if (ob.kind === 'train') {
      block[ob.lane].push([ob.s0, ob.s0 + ob.len]);
      if (ob.ramp) { roofEnd.push({ lane: ob.lane, s: ob.s0 - OBST.ramp.len, end: ob.s0 + ob.len }); continue; }
    } else if (ob.kind === 'ramp') {
      block[ob.lane].push([ob.s0 + 0.5, ob.s0 + ob.len]); // only enterable from the front
    } else if (ob.kind === 'wall') {
      block[ob.lane].push([ob.s0, ob.s0 + ob.len]);
    } else {
      act[ob.lane].push([ob.s0, ob.s0 + ob.len]);
    }
    const key = s.toFixed(2);
    if (!rowMap.has(key)) rowMap.set(key, { s, cells: ['.', '.', '.'] });
    rowMap.get(key).cells[ob.lane] = ob.kind;
  }
  const rows = [...rowMap.values()].filter((r) => r.s < end).sort((a, b) => a.s - b.s);
  const hits = (list, a, b, pad) => list.some(([x0, x1]) => x1 + pad > a && x0 - pad < b);
  const stayOK = (l, a, b) => !hits(block[l], a, b, 0);
  const crossOK = (l, a, b) => !hits(block[l], a, b, 0.5) && !hits(act[l], a, b, 0.3);
  const fall = Math.sqrt((2 * ROOF_Y) / cfg.gravity);

  function reach(lane, s0, s1) {
    const span = s1 - s0;
    if (span <= 0) return 1 << lane;
    const ds = Math.max(0.1, span / 240);
    const N = Math.ceil(span / ds);
    const r = Math.ceil((v * REACT) / ds);
    const m = Math.max(1, Math.ceil((v * cfg.laneTime) / ds));
    const R = new Uint8Array(N + 1);
    R[0] = 1 << lane;
    for (let k = 0; k < N; k++) {
      if (!R[k]) continue;
      const sk = s0 + k * ds;
      for (let L = 0; L < 3; L++) {
        if (!(R[k] & (1 << L))) continue;
        if (stayOK(L, sk, sk + ds)) R[k + 1] |= 1 << L;
        if (k < r || k + m + r > N - Math.ceil(0.3 / ds)) continue;
        const se = s0 + (k + m + r) * ds;
        for (const L2 of [L - 1, L + 1]) {
          if (L2 < 0 || L2 > 2) continue;
          if (stayOK(L, sk, se) && crossOK(L2, sk, se)) R[k + m] |= 1 << L2;
        }
      }
    }
    return R[N];
  }

  // Start: lane 1 at s = 0.
  let starts = [{ lane: 1, s: 0 }];
  let roofs = []; // riders: { lane, until }
  for (const r of rows) {
    const pass = [0, 1, 2].filter((l) => r.cells[l] === 'ramp' || (r.cells[l] !== 'wall' && r.cells[l] !== 'train' && stayOK(l, r.s - 0.3, r.s + 0.3)));
    if (!pass.length) fails.push({ at: r.s, what: `row [${r.cells.join(',')}] has no passable lane` });
    // Roof riders whose roof ends before this row drop off and become ground starts.
    const still = [];
    for (const rf of roofs) {
      if (rf.until > r.s + 1) still.push(rf);
      else starts.push({ lane: rf.lane, s: Math.min(r.s, rf.until + v * fall) });
    }
    const next = new Map();
    for (const st of starts) {
      const mask = reach(st.lane, st.s, r.s);
      const ok = pass.filter((b) => mask & (1 << b));
      if (!ok.length) {
        fails.push({ at: r.s, what: `from lane ${st.lane} at ${st.s.toFixed(1)} m no passable lane of row [${r.cells.join(',')}] is reachable in time` });
        continue;
      }
      for (const b of ok) {
        if (r.cells[b] === 'ramp') {
          const re = roofEnd.find((x) => x.lane === b && Math.abs(x.s - r.s) < 0.01);
          if (re) still.push({ lane: b, until: re.end });
        } else next.set(b, { lane: b, s: r.s });
      }
    }
    starts = [...next.values()];
    roofs = still;
  }
  return { rows: rows.length };
}

// Simulate one approach with the real physics; returns true if the obstacle is cleared cleanly.
function tryApproach(ob, cfg, v, sneakers, action, lead) {
  const b = new PlayerBody(cfg);
  const pre = 1.6 + lead;
  b.reset(ob.s0 - BODY.halfD - v * pre, ob.lane);
  b.sneakers = sneakers;
  const list = [ob];
  const h = 1 / 240;
  let t = 0;
  let done = false;
  const tAct = pre - lead;
  const endS = ob.s0 + ob.len + 1.5;
  while (b.s < endS && t < 30) {
    if (!done && t >= tAct) {
      done = true;
      if (action === 'jump') b.requestJump(list); else b.requestRoll();
    }
    const n = b.step(h, v, list);
    for (let i = 0; i < n; i++) if (b.events[i].type === EV.FRONT || b.events[i].type === EV.SIDE) return false;
    t += h;
  }
  return true;
}

// Run straight up a ramp, along the roof and off the end, without touching
// anything: the ride itself must be clean.
function tryRide(ramp, train, cfg, v, sneakers) {
  const b = new PlayerBody(cfg);
  b.reset(ramp.s0 - 2 - BODY.halfD, ramp.lane);
  b.sneakers = sneakers;
  const list = [ramp, train];
  const h = 1 / 120;
  const endS = train.s0 + train.len + 4;
  for (let t = 0; b.s < endS && t < 60; t += h) {
    const n = b.step(h, v, list);
    for (let i = 0; i < n; i++) if (b.events[i].type === EV.FRONT || b.events[i].type === EV.SIDE) return false;
  }
  return true;
}

// 2. Take-off windows for every hurdle (jump) and barrier (roll), and every ramp ride.
function checkWindows(obs, cfg, v, sneakers, end, fails) {
  let jump = 9, roll = 9;
  const cache = new Map(); // same kind at the same speed behaves the same: memoise by kind
  for (const ob of obs) {
    if (ob.s0 > end) continue;
    if (ob.kind === 'ramp') {
      const train = obs.find((o) => o.kind === 'train' && o.ramp && o.lane === ob.lane && Math.abs(o.s0 - (ob.s0 + ob.len)) < 0.01);
      let ok = cache.get('ride' + (train ? train.cars : 0));
      if (ok === undefined) { ok = train ? tryRide(ob, train, cfg, v, sneakers) : false; cache.set('ride' + (train ? train.cars : 0), ok); }
      if (!ok) fails.push({ at: ob.s0, what: `running up the ramp in lane ${ob.lane} onto the train is not clean` });
      continue;
    }
    if (ob.kind !== 'hurdle' && ob.kind !== 'barrier') continue;
    const action = ob.kind === 'hurdle' ? 'jump' : 'roll';
    let w = cache.get(ob.kind);
    if (w === undefined) {
      // Scan leads 0..1.2 s in 5 ms steps; window = longest contiguous run that clears.
      let best = 0, run = 0;
      for (let lead = 0; lead <= 1.2; lead += 0.005) {
        if (tryApproach(ob, cfg, v, sneakers, action, lead)) { run += 0.005; best = Math.max(best, run); } else run = 0;
      }
      w = best;
      cache.set(ob.kind, w);
    }
    if (action === 'jump') jump = Math.min(jump, w); else roll = Math.min(roll, w);
    if (w < MIN_WINDOW) fails.push({ at: ob.s0, what: `${ob.kind} in lane ${ob.lane}: take-off window ${(w * 1000).toFixed(0)} ms` });
  }
  return { jump: jump === 9 ? null : +jump.toFixed(3), roll: roll === 9 ? null : +roll.toFixed(3) };
}

// 3. Beam search with the real physics over the whole track.
function searchPath(obs, cfg, v, sneakers, end, fails) {
  const sorted = obs.slice().sort((a, b) => a.s0 - b.s0);
  const DEC = Math.min(0.1, Math.max(0.05, 1.0 / v));        // decision interval (s)
  // The game's own physics step (1/120 s): coarser steps could jump over narrow
  // collision windows that the game would hit.
  const nSub = Math.max(1, Math.round(DEC * 120));
  const h = DEC / nSub;
  const CAP = 48;
  const start = new PlayerBody(cfg);
  start.reset(0, 1);
  start.sneakers = sneakers;
  let beam = [start];
  const near = [];
  let lo = 0;
  let s = 0;
  let steps = 0, maxBeam = 1;
  const actions = ['none', 'left', 'right', 'jump', 'roll'];
  while (s < end) {
    // obstacles that matter around s (moving trains are found by their meeting point)
    near.length = 0;
    while (lo < sorted.length && sorted[lo].s0 + sorted[lo].len < s - 40 && !sorted[lo].moving) lo++;
    let busy = false;
    for (let i = lo; i < sorted.length; i++) {
      const ob = sorted[i];
      const s0 = ob.moving ? obstacleS0(ob, s) : ob.s0;
      if (!ob.moving && s0 > s + 60) break;
      if (s0 + ob.len < s - 8 || s0 > s + 60) continue;
      near.push(ob);
      const sm = ob.moving ? ob.moving.sMeet : s0;
      if (sm < s + v * 2.2 + 12 && sm + ob.len > s - 2) busy = true;
    }
    const next = [];
    const seen = new Set();
    for (const st of beam) {
      const acts = busy ? actions : ['none'];
      for (const a of acts) {
        if (a === 'jump' && !(st.grounded || st.coyoteT > 0)) continue;
        if (a === 'roll' && st.rollT > 0.3) continue;
        if (a === 'left' && st.lane === 0) continue;
        if (a === 'right' && st.lane === 2) continue;
        const b = new PlayerBody(cfg).copyFrom(st);
        if (a === 'left') b.requestLane(-1);
        else if (a === 'right') b.requestLane(1);
        else if (a === 'jump') b.requestJump(near);
        else if (a === 'roll') b.requestRoll();
        let ok = true;
        for (let k = 0; k < nSub && ok; k++) {
          const n = b.step(h, v, near);
          for (let e = 0; e < n; e++) if (b.events[e].type === EV.FRONT || b.events[e].type === EV.SIDE) { ok = false; break; }
        }
        if (!ok) continue;
        const key = `${b.lane}|${Math.round(b.x * 4)}|${Math.round(b.y * 4)}|${Math.round(b.vy / 2)}|${b.grounded ? 1 : 0}|${b.rollT > 0 ? Math.ceil(b.rollT * 5) : b.rollQueued ? 'q' : 0}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(b);
      }
    }
    s += v * DEC;
    steps++;
    if (!next.length) {
      const around = sorted.filter((ob) => (ob.moving ? ob.moving.sMeet : ob.s0) > s - 30 && (ob.moving ? ob.moving.sMeet : ob.s0) < s + 15)
        .map((ob) => `${ob.kind}${ob.moving ? '(moving)' : ''}${ob.ramp ? '(ramp)' : ''} lane ${ob.lane} @${(ob.moving ? ob.moving.sMeet : ob.s0).toFixed(1)}${ob.kind === 'train' ? '+' + ob.len.toFixed(1) : ''}`);
      fails.push({ at: +s.toFixed(1), what: `no surviving path. Nearby: ${around.join('; ')}` });
      return { ok: false, reached: +s.toFixed(1), steps, maxBeam };
    }
    // Keep a diverse, bounded beam: a quota per (lane, in the air, rolling, on a roof)
    // bucket, spread evenly over jump timing / roll timing / sideways position.
    if (next.length > CAP) {
      const buckets = new Map();
      for (const b of next) {
        const k = b.lane * 8 + (b.grounded ? 0 : 4) + (b.rolling ? 2 : 0) + (b.y > ROOF_Y - 0.4 ? 1 : 0);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(b);
      }
      const quota = Math.max(3, Math.floor(CAP / buckets.size));
      const keep = [];
      for (const list of buckets.values()) {
        if (list.length <= quota) { keep.push(...list); continue; }
        list.sort((a, b2) => (a.vy - b2.vy) || (a.rollT - b2.rollT) || (a.x - b2.x));
        for (let i = 0; i < quota; i++) keep.push(list[Math.floor((i * (list.length - 1)) / (quota - 1))]);
      }
      beam = keep;
    } else beam = next;
    maxBeam = Math.max(maxBeam, beam.length);
  }
  return { ok: true, reached: end, steps, maxBeam };
}

// ------------------------------------------------------------------ main
if (!isMainThread) {
  parentPort.on('message', (job) => {
    try { parentPort.postMessage({ ok: true, res: runJob(job) }); }
    catch (e) { parentPort.postMessage({ ok: false, job, err: e.stack }); }
  });
} else {
  const { jobs, jobsN } = jobList(process.argv.slice(2));
  const t0 = Date.now();
  const results = [];
  let next = 0;
  await new Promise((resolve) => {
    let active = 0;
    const startWorker = () => {
      const w = new Worker(fileURLToPath(import.meta.url));
      const feed = () => {
        if (next >= jobs.length) { w.terminate(); if (--active === 0) resolve(); return; }
        w.postMessage(jobs[next++]);
      };
      w.on('message', (m) => {
        if (!m.ok) { console.error('job crashed', m.job, m.err); process.exitCode = 1; }
        else {
          results.push(m.res);
          const r = m.res;
          process.stdout.write(`  ${r.fails.length ? 'FAIL' : 'ok  '} ${r.mode.padEnd(6)} ${String(r.v).padStart(4)} m/s ${r.sneakers ? 'sneakers' : '        '} seed ${r.seed}\n`);
        }
        feed();
      });
      active++;
      feed();
    };
    for (let i = 0; i < Math.min(jobsN, jobs.length); i++) startWorker();
  });

  // summary table
  const groups = new Map();
  for (const r of results) {
    const k = `${r.mode} ${r.v} m/s${r.sneakers ? ' +sneakers' : ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  console.log('\nconfig                     seeds  rows/5km  min jump window  min roll window  full path');
  let failed = 0;
  for (const [k, rs] of [...groups.entries()].sort()) {
    const minJ = Math.min(...rs.map((r) => r.minJump ?? 9));
    const minR = Math.min(...rs.map((r) => r.minRoll ?? 9));
    const paths = rs.filter((r) => r.path.ok).length;
    const rows = Math.round(rs.reduce((a, r) => a + r.rows, 0) / rs.length);
    console.log(`${k.padEnd(26)} ${String(rs.length).padStart(5)}  ${String(rows).padStart(8)}  ${(minJ * 1000).toFixed(0).padStart(12)} ms  ${(minR * 1000).toFixed(0).padStart(12)} ms  ${paths}/${rs.length} ${paths === rs.length ? 'ok' : 'FAIL'}`);
    for (const r of rs) for (const f of r.fails) { failed++; console.log(`   FAIL seed ${r.seed} at ${(+f.at).toFixed(1)} m: ${f.what}`); }
  }
  console.log(`\n${results.length} runs, ${failed ? failed + ' failures' : 'all passed'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (failed) process.exitCode = 1;
}
