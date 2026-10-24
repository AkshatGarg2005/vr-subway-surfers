// Pattern generator: fills the track with hand-authored rows (one cell per lane)
// from a weighted library that unlocks harder rows with distance.
//
// Every accepted row is checked in code:
//  - it leaves at least one passable lane;
//  - from every lane a player can be in at the previous row (including people
//    who rode a roof and drop off its end), some passable lane of the new row
//    is reachable in time: spacing >= speed * (lanes moved * lane time + reaction),
//    without passing through a train's side;
//  - two jumps in a row on one path are far enough apart to land in between.
// Pure JavaScript (no three.js) so tools/solvable.mjs can run it in Node.

import { LANES, OBST, ROOF_Y, makeRng, trainLength, airTime, POWERUPS } from './config.js';
import { makeObstacle } from './physics.js';

// Cells: '.' free, H hurdle (jump), B high barrier (roll), W tall barrier,
// T<n> parked train of n cars, R<n> ramp up to a parked train, M<n> moving train.
// [cells, weight, tier]. Each row is also used in every lane permutation.
const BASE_ROWS = [
  [['H', '.', '.'], 4, 0],
  [['B', '.', '.'], 4, 0],
  [['W', '.', '.'], 2.5, 0],
  [['T1', '.', '.'], 2.5, 0],
  [['T2', '.', '.'], 2, 0],
  [['R2', '.', '.'], 2, 0],
  [['H', 'H', '.'], 1.5, 0],
  [['B', 'B', '.'], 1.2, 0],
  [['H', 'H', 'H'], 1.5, 1],
  [['B', 'B', 'B'], 1.5, 1],
  [['H', 'B', '.'], 2, 1],
  [['W', 'H', '.'], 2, 1],
  [['W', 'B', '.'], 2, 1],
  [['W', '.', 'W'], 1.5, 1],
  [['T2', '.', 'T2'], 1.5, 1],
  [['R2', 'T2', '.'], 1.5, 1],
  [['T1', 'H', '.'], 1.5, 1],
  [['M1', '.', '.'], 1.5, 1],
  [['R3', '.', '.'], 1, 1],
  [['H', 'W', 'B'], 1.2, 2],
  [['T3', '.', 'T3'], 1.2, 2],
  [['R3', 'T3', '.'], 1.2, 2],
  [['T2', 'B', 'T2'], 1, 2],
  [['T2', 'H', 'T2'], 1, 2],
  [['M2', '.', '.'], 1.2, 2],
  [['M1', 'H', '.'], 1, 2],
  [['W', 'W', 'H'], 1, 2],
  [['W', 'W', 'B'], 1, 2],
  [['R2', 'T2', 'T2'], 1, 3],
  [['M1', '.', 'M1'], 0.8, 3],
  [['T3', 'M1', '.'], 0.8, 3],
  [['B', 'W', 'H'], 1, 3],
  [['W', 'B', 'W'], 1, 3],
  [['W', 'H', 'W'], 1, 3],
];

function permutations(cells) {
  const out = [];
  const idx = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const seen = new Set();
  for (const p of idx) {
    const c = [cells[p[0]], cells[p[1]], cells[p[2]]];
    const key = c.join(',');
    if (!seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

const LIBRARY = [];
for (const [cells, w, tier] of BASE_ROWS) {
  const perms = permutations(cells);
  for (const c of perms) {
    const mask = (c[0] !== '.' ? 1 : 0) | (c[1] !== '.' ? 2 : 0) | (c[2] !== '.' ? 4 : 0);
    LIBRARY.push({ cells: c, w: w / perms.length, tier, mask });
  }
}

// Distance (m) at which tiers 1, 2, 3 unlock.
const TIERS = { screen: [350, 1100, 2200], vr: [110, 330, 700] };
// Seconds between rows by tier: [min, max]
const GAPS = {
  screen: [[1.5, 2.3], [1.2, 1.9], [1.0, 1.6], [0.95, 1.45]],
  vr: [[3.2, 4.6], [2.8, 4.0], [2.5, 3.6], [2.3, 3.3]],
};

const CELL_KIND = { H: 'hurdle', B: 'barrier', W: 'wall' };
const PAD_MOVE = 0.6;   // pad around blocks for sideways moves (body depth + forgiveness)

export class PatternGenerator {
  // cfg: mode config (js/config.js modeConfig); planSpeed(s) -> expected speed when the player gets to s.
  constructor({ seed = 1, cfg, planSpeed, start = null, coins = true, powerups = true }) {
    this.cfg = cfg;
    this.mode = cfg.name;
    this.rng = makeRng(seed);
    this.planSpeed = planSpeed;
    this.coins = coins;
    this.powerups = powerups;
    this.nextId = 1;
    this.items = [];          // output queue: { type: 'ob'|'coin'|'power', ... }
    this.rows = [];           // accepted rows, for the tools
    this.feats = [[], [], []];// per lane: { a, b, kind } where kind is block|jump|roll|ramp|reserve
    this.lastRowS = 0;
    this.lastRowCells = ['.', '.', '.'];
    // Reachable player states at the last row. Ground: { lane, roof: 0, jumped }.
    // Roof: { lane, roof: endS } (rode a ramp, or could have hopped onto that roof).
    this.states = [{ lane: 1, roof: 0, jumped: false }];
    this.cursor = start != null ? start : (this.mode === 'vr' ? 22 : 70);
    this.nextPower = this.cursor + (this.mode === 'vr' ? 90 : 300);
    this.air = airTime(cfg, true);  // worst case: super sneakers
    this.fall = Math.sqrt((2 * ROOF_Y) / cfg.gravity);
    this.stats = { rows: 0, rejected: 0, fallbacks: 0 };
  }

  tier(s) {
    const t = TIERS[this.mode];
    return s >= t[2] ? 3 : s >= t[1] ? 2 : s >= t[0] ? 1 : 0;
  }

  generateUntil(sEnd) {
    while (this.cursor < sEnd) this._row();
  }

  // ------------------------------------------------------------ lane features
  _add(lane, a, b, kind) {
    const list = this.feats[lane];
    list.push({ a, b, kind });
    // keep sorted by a (insertions are almost always at the end)
    for (let i = list.length - 1; i > 0 && list[i - 1].a > list[i].a; i--) {
      const t = list[i]; list[i] = list[i - 1]; list[i - 1] = t;
    }
  }

  _prune(sMin) {
    for (let l = 0; l < 3; l++) {
      if (this.feats[l].length > 48) this.feats[l] = this.feats[l].filter((f) => f.b >= sMin);
    }
  }

  // Can a player stay in (move = false) or cross into (move = true) this lane over [a, b]?
  _clear(lane, a, b, move, extra) {
    const pad = move ? PAD_MOVE : 0;
    const lists = extra ? [this.feats[lane], extra[lane]] : [this.feats[lane]];
    for (const list of lists) {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (f.kind === 'reserve') continue;
        if (f.a - pad > b) break;
        if (f.b + pad < a) continue;
        if (f.kind === 'block' || f.kind === 'ramp') return false;
        if (move) return false; // don't plan sideways moves across hurdles/barriers
      }
    }
    return true;
  }

  _reservedAt(lane, s) {
    const list = this.feats[lane];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f.a > s) break;
      if (f.b >= s && (f.kind === 'reserve' || f.kind === 'block' || f.kind === 'ramp')) return true;
    }
    return false;
  }

  // Lanes reachable (bitmask) at s1 for a ground player in `lane` at s0.
  // Cautious model (fast = false): sideways moves start after a reaction time,
  // take planLane per lane, and need both lanes clear for planLane + planReact.
  // Fast model (fast = true): the quickest anyone could move (game lane time,
  // no reaction). Used to find every lane a player might be in.
  _reach(lane, s0, s1, v, extra, fast = false) {
    const span = s1 - s0;
    if (span <= 0) return 1 << lane;
    const ds = Math.max(0.12, span / 180);
    const N = Math.ceil(span / ds);
    const m = Math.max(1, Math.ceil((v * (fast ? this.cfg.laneTime : this.cfg.planLane)) / ds));
    const r = fast ? 0 : Math.ceil((v * this.cfg.planReact) / ds);
    const R = this._reachBuf && this._reachBuf.length > N ? this._reachBuf : (this._reachBuf = new Uint8Array(N + 64));
    R.fill(0, 0, N + 1);
    R[0] = 1 << lane;
    for (let k = 0; k < N; k++) {
      const mask = R[k];
      if (!mask) continue;
      const sk = s0 + k * ds;
      for (let L = 0; L < 3; L++) {
        if (!(mask & (1 << L))) continue;
        if (this._clear(L, sk, sk + ds, false, extra)) R[k + 1] |= 1 << L;
        if (k < r) continue;
        // A sideways move needs both lanes clear for lane-change time + reaction,
        // all of it before the row: no split-second timing as a lane opens up.
        const kk = k + m;
        const kw = k + m + r;
        if (kw > N - (fast ? 0 : Math.ceil(0.4 / ds))) continue;
        const se = s0 + kw * ds;
        for (let d = -1; d <= 1; d += 2) {
          const L2 = L + d;
          if (L2 < 0 || L2 > 2) continue;
          if (this._clear(L, sk, se, false, extra) && this._clear(L2, sk, se, true, extra)) R[kk] |= 1 << L2;
        }
      }
    }
    return R[N];
  }

  // ------------------------------------------------------------ rows
  _row() {
    const s = this.cursor;
    const v = this.planSpeed(s) * 1.04;
    const tier = this.tier(s);
    const [g0, g1] = GAPS[this.mode][tier];
    const rng = this.rng;

    let accepted = null;
    for (let attempt = 0; attempt < 14 && !accepted; attempt++) {
      const extraGap = attempt < 8 ? 0 : (attempt - 7) * 0.5;
      const sj = Math.max(s, this.lastRowS + v * (rng.range(g0, g1) + extraGap));
      // Only rows that leave lanes still occupied by a train (or its run-off) empty.
      let busy = 0;
      for (let l = 0; l < 3; l++) if (this._reservedAt(l, sj - 0.5)) busy |= 1 << l;
      const cells = this._pick(tier, busy);
      if (!cells) { this.stats.rejected++; continue; }
      const res = this._check(cells, sj, v);
      if (res) accepted = { cells, s: sj, res };
      else this.stats.rejected++;
    }
    if (!accepted) {
      // Nothing fits here (usually long trains still running): leave a gap and try again later.
      this.stats.fallbacks++;
      this.cursor = Math.max(s, this.lastRowS) + v * 0.8;
      const empty = ['.', '.', '.'];
      const sj = this.cursor;
      const res = this._check(empty, sj, v);
      if (res) this._commit(empty, sj, v, res);
      return;
    }
    this._commit(accepted.cells, accepted.s, v, accepted.res);
    this.cursor = accepted.s + 0.01;
  }

  _pick(tier, busy = 0) {
    let total = 0;
    const ok = (e) => e.tier <= tier && !(e.mask & busy);
    const weight = (e) => e.w * (e.tier === tier && tier > 0 ? 1.4 : 1);
    for (const e of LIBRARY) if (ok(e)) total += weight(e);
    if (total <= 0) return null;
    let r = this.rng() * total;
    for (const e of LIBRARY) {
      if (!ok(e)) continue;
      r -= weight(e);
      if (r <= 0) return e.cells;
    }
    return null;
  }

  // Plan the features a row would add: { extra: per-lane features, objs: obstacle specs, roofs }
  _plan(cells, sj, v) {
    const extra = [[], [], []];
    const specs = [];
    const roofs = [];
    const carsAt = [0, 0, 0];
    const drop = v * (this.fall + this.cfg.planReact + this.cfg.planLane) + 3;
    for (let l = 0; l < 3; l++) {
      const c = cells[l];
      if (c === '.') continue;
      const k = c[0];
      if (CELL_KIND[k]) {
        const kind = CELL_KIND[k];
        const len = OBST[kind].d;
        extra[l].push({ a: sj, b: sj + len, kind: k === 'H' ? 'jump' : k === 'B' ? 'roll' : 'block' });
        specs.push({ kind, lane: l, s0: sj });
        continue;
      }
      let cars = Number(c.slice(1));
      // At VR walking speeds a long train takes many seconds to pass: keep them short.
      if (this.mode === 'vr') cars = Math.min(cars, 2) - (cars >= 2 && this.rng.chance(0.4) ? 1 : 0);
      const L = trainLength(cars);
      carsAt[l] = cars;
      if (k === 'T') {
        extra[l].push({ a: sj, b: sj + L, kind: 'block' });
        extra[l].push({ a: sj, b: sj + L + drop, kind: 'reserve' });
        specs.push({ kind: 'train', lane: l, s0: sj, cars });
        roofs.push({ lane: l, end: sj + L });
      } else if (k === 'R') {
        const rl = OBST.ramp.len;
        extra[l].push({ a: sj, b: sj + rl, kind: 'ramp' });
        extra[l].push({ a: sj + rl, b: sj + rl + L, kind: 'block' });
        extra[l].push({ a: sj, b: sj + rl + L + drop, kind: 'reserve' });
        specs.push({ kind: 'ramp', lane: l, s0: sj });
        specs.push({ kind: 'train', lane: l, s0: sj + rl, cars, ramp: true });
        roofs.push({ lane: l, end: sj + rl + L, ramp: true });
      } else if (k === 'M') {
        const [k0, k1] = this.cfg.trainK;
        const kk = this.rng.range(k0, k1);
        const sStart = sj + kk * v * this.cfg.trainTrigger;
        const enc = L / (1 + kk);        // how long (in your s) it stays alongside you
        extra[l].push({ a: sj, b: sj + enc, kind: 'block' });
        extra[l].push({ a: sj - 1, b: sStart + L + drop, kind: 'reserve' });
        specs.push({ kind: 'train', lane: l, s0: sStart, cars, moving: { k: kk, sMeet: sj, sStart } });
        roofs.push({ lane: l, end: sj + enc });
      }
    }
    return { extra, specs, roofs, cars: carsAt };
  }

  // Returns the new player-state list if the row is acceptable at sj, else null.
  _check(cells, sj, v) {
    // No new feature may go where a lane is reserved (inside or just after a train).
    for (let l = 0; l < 3; l++) if (cells[l] !== '.' && this._reservedAt(l, sj - 0.5)) return null;
    // Moving trains need their whole run clear.
    const plan = this._plan(cells, sj, v);
    for (let l = 0; l < 3; l++) {
      for (const f of plan.extra[l]) {
        if (f.kind !== 'reserve') continue;
        for (const g of this.feats[l]) if (g.kind !== 'reserve' && g.b > f.a && g.a < f.b && g.a >= sj - 0.5) return null;
      }
    }

    // Lanes a ground player can be in at sj and survive the row.
    let enter = 0;
    for (let l = 0; l < 3; l++) {
      const c = cells[l][0];
      if (c === 'W' || c === 'T' || c === 'M') continue;
      if (!this._clear(l, sj - 0.3, sj + 0.3, false)) continue; // a train from an earlier row is here
      enter |= 1 << l;
    }
    if (!enter) return null;

    const out = [];
    const seen = new Set();
    const push = (st) => {
      const key = st.lane + ':' + (st.roof ? 'r' + Math.round(st.roof) : 'g' + (st.jumped ? 'j' : ''));
      if (!seen.has(key)) { seen.add(key); out.push(st); }
    };
    const extra = plan.extra;

    for (const st of this.states) {
      let lane = st.lane, from = this.lastRowS, jumped = st.jumped;
      if (st.roof) {
        if (st.roof > sj + 1) { push(st); continue; }          // still up on the roof: safe
        from = st.roof + v * this.fall;                       // dropped off the end
        jumped = false;
        if (from > sj) from = sj;
      }
      // Must have a way out with cautious timing...
      let exit = this._reach(lane, from, sj, v, null) & enter;
      // ...and every lane a quick player could reach is somewhere someone may be.
      let maybe = (this._reach(lane, from, sj, v, null, true) & enter) | exit;
      // Two jumps on one path need time to land in between.
      if (jumped && sj - this.lastRowS < v * (this.air + this.cfg.planReact)) {
        for (let l = 0; l < 3; l++) if (cells[l] === 'H') exit &= ~(1 << l);
      }
      if (!exit) return null; // dead end for someone who was here
      for (let l = 0; l < 3; l++) {
        if (!(maybe & (1 << l))) continue;
        const c = cells[l][0];
        if (c === 'R') continue; // they go up the ramp: covered by the roof state below
        push({ lane: l, roof: 0, jumped: c === 'H' });
      }
    }
    // Anyone could be riding a new roof (ramp, or hopping across from a neighbouring roof).
    for (const r of plan.roofs) push({ lane: r.lane, roof: r.end });
    // Old roofs that end before the next row are handled next time.
    if (!out.some((st) => !st.roof || st.roof > sj)) return null;
    return { states: out, plan };
  }

  _commit(cells, sj, v, res) {
    const { plan } = res;
    for (let l = 0; l < 3; l++) for (const f of plan.extra[l]) this._add(l, f.a, f.b, f.kind);
    const obs = [];
    for (const sp of plan.specs) {
      const ob = makeObstacle(sp.kind, sp.lane, sp.s0, { id: this.nextId++, row: this.rows.length });
      if (sp.kind === 'train') {
        ob.cars = sp.cars;
        ob.len = trainLength(sp.cars);
        ob.ramp = !!sp.ramp;
        if (sp.moving) ob.moving = sp.moving;
      }
      obs.push(ob);
      this.items.push({ type: 'ob', ob });
    }
    this.rows.push({ s: sj, v, cells: cells.slice(), states: res.states });
    this.stats.rows++;
    if (this.coins) this._coinsFor(cells, sj, v, res.states, plan.cars);
    if (this.powerups && sj > this.nextPower) this._power(sj, v, cells);
    this.states = res.states;
    this.lastRowS = sj;
    this.lastRowCells = cells.slice();
    this._prune(sj - 80);
  }

  // ------------------------------------------------------------ coins & power-ups
  _coin(s, lane, y) {
    this.items.push({ type: 'coin', s, x: LANES[lane], y, lane });
  }

  _laneFreeForCoins(lane, a, b) {
    const list = this.feats[lane];
    for (const f of list) {
      if (f.a - 1 > b) break;
      if (f.b + 1 < a) continue;
      return false; // anything there, reserves included (a moving train would plough through)
    }
    return true;
  }

  _coinsFor(cells, sj, v, states, cars) {
    const rng = this.rng;
    const step = this.mode === 'vr' ? 1.1 : 1.5;
    const cfg = this.cfg;
    // Candidate lanes a ground player could be using at this row.
    const ground = states.filter((st) => !st.roof).map((st) => st.lane);
    const lanes = [0, 1, 2].filter((l) => ground.includes(l) || cells[l][0] === 'R');
    if (!lanes.length || !rng.chance(0.8)) return;
    const lane = rng.pick(lanes);
    const c = cells[lane];
    if (c[0] === 'R') {
      const L = trainLength(cars[lane]);
      const rl = OBST.ramp.len;
      for (let s = sj + 1; s < sj + rl + L - 1; s += step) {
        const u = Math.min(1, (s - sj) / rl);
        this._coin(s, lane, ROOF_Y * u + 1.0);
      }
      return;
    }
    if (c === 'H') {
      // Arc along the jump the player would make at this speed.
      const lead = this.mode === 'vr' ? 0.32 : 0.24;
      const t0 = sj - v * lead;
      const T = (2 * cfg.jumpV) / cfg.gravity;
      const n = Math.max(3, Math.round((v * T) / step));
      for (let i = 0; i <= n; i++) {
        const t = (i / n) * T;
        const y = cfg.jumpV * t - 0.5 * cfg.gravity * t * t;
        this._coin(t0 + v * t, lane, y + 1.0);
      }
      return;
    }
    // A line leading up to the row (and under a barrier).
    const len = Math.min(v * 1.2, 14) + rng.range(0, 6);
    const a = sj - len, b = c === 'B' ? sj + 1.2 : sj - 1.5;
    if (!this._laneFreeForCoinsExcept(lane, a, b, sj)) return;
    const y = c === 'B' ? 0.5 : 1.0;
    for (let s = a; s <= b; s += step) this._coin(s, lane, y);
  }

  _laneFreeForCoinsExcept(lane, a, b, sj) {
    const list = this.feats[lane];
    for (const f of list) {
      if (f.a - 1 > b) break;
      if (f.b + 1 < a) continue;
      if (Math.abs(f.a - sj) < 0.01 && f.kind === 'roll') continue; // this row's own barrier
      return false;
    }
    return true;
  }

  _power(sj, v, cells) {
    const rng = this.rng;
    const lanes = [0, 1, 2].filter((l) => cells[l] === '.' && this._laneFreeForCoins(l, sj - v * 0.8 - 2, sj + 2));
    if (!lanes.length) return;
    const kinds = ['magnet', 'magnet', 'double', 'sneakers', 'shield', 'shield'];
    const kind = rng.pick(kinds.filter((k) => POWERUPS[k]));
    const lane = rng.pick(lanes);
    this.items.push({ type: 'power', kind, s: sj - v * 0.5, x: LANES[lane], y: 1.1, lane });
    this.nextPower = sj + (this.mode === 'vr' ? rng.range(110, 200) : rng.range(320, 560));
  }
}
