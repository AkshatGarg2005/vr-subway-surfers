// Automatic quality. Measures frame intervals in 2 s windows:
//   budget = max(10th-percentile interval, 1/60 s); a frame is "missed" if it
//   takes over 1.5 x budget.
// Steps down when more than 8 % of frames are missed or the 10th percentile is
// over 20 ms (constant ~50 fps judder is not accepted), in this order:
//   1. multisampling off
//   2. pixel ratio, in proportion: dpr * sqrt(budget / mean) * 0.92 (a 0.1-0.5 step;
//      with p10 over 20 ms the goal is 1/60 s, since the budget is then the slow rate)
//   3. phone VR: bloom off before going below 1.25
//   4. lower pixel ratio
//   5. normal screen only: sun shafts off
// Steps up only after 30 s with under 1 % missed: +0.15, never above
// (failed level - 0.1). Each further step up waits twice as long (30 s, 60 s,
// 120 s...) and steps under 0.1 are skipped, so it doesn't keep probing. Waits 3 s after every change (each change rebuilds
// buffers and freezes briefly). Runs in menus too; reset on every mode change.
import { clamp } from './config.js';

const WINDOW = 2000, SETTLE = 3000, UP_AFTER = 30000;

export class AutoQuality {
  constructor(view) {
    this.view = view;
    this.enabled = true;
    this.log = view.qualityLog;
    this.buf = new Float32Array(512);
    this.reset();
  }

  reset() {
    this.n = 0;
    this.winStart = null;
    this.lastChange = performance.now();
    this.goodMs = 0;
    this.cap = Infinity;
    this.t0 = performance.now();
    this.ups = 0;
    this.downs = 0;
    this.upFrom = null;
    this.upWait = UP_AFTER;
    this.log.length = 0;
  }

  minDpr() { return this.view.mode === 'cardboard' ? 0.8 : 0.7; }

  // interval: ms since the previous frame
  sample(interval) {
    if (!this.enabled || this.view.mode === 'xr') return;
    const now = performance.now();
    if (interval > 250) { this.n = 0; this.winStart = now; return; } // tab was hidden
    if (now - this.lastChange < SETTLE) { this.n = 0; this.winStart = now; return; }
    if (this.winStart == null) this.winStart = now;
    if (this.n < this.buf.length) this.buf[this.n++] = interval;
    if (now - this.winStart >= WINDOW) {
      this._evaluate(now);
      this.n = 0;
      this.winStart = now;
    }
  }

  _evaluate(now) {
    const n = this.n;
    if (n < 10) return;
    const s = Array.from(this.buf.subarray(0, n)).sort((a, b) => a - b);
    const p10 = s[Math.floor(n * 0.1)];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += s[i];
    const mean = sum / n;
    const budget = Math.max(p10, 1000 / 60);
    let missed = 0;
    for (let i = 0; i < n; i++) if (s[i] > budget * 1.5) missed++;
    const frac = missed / n;
    this.last = { p10, mean, budget, missed: frac };
    if (frac > 0.08 || p10 > 20) {
      this.goodMs = 0;
      this._down(budget, mean, frac, p10, now);
    } else if (frac < 0.01) {
      this.goodMs += WINDOW;
      if (this.goodMs >= this.upWait) { this.goodMs = 0; this._up(now); }
    } else {
      this.goodMs = 0;
    }
  }

  _record(now, change, why) {
    const q = this.view.q;
    this.log.push({ t: +((now - this.t0) / 1000).toFixed(1), change, dpr: +q.dpr.toFixed(2), bloom: q.bloom, msaa: this.view.msaaSamples > 0, why });
    this.lastChange = now;
  }

  _down(budget, mean, frac, p10, now) {
    const v = this.view, q = v.q;
    const why = `${(frac * 100).toFixed(0)}% missed, p10 ${p10.toFixed(1)} ms`;
    this.downs++;
    // A step up that fails straight away: go back to the level that was fine.
    if (this.upFrom != null && now - this.lastChange < SETTLE + 2 * WINDOW + 100) {
      this.cap = q.dpr - 0.1;
      v.setQuality({ dpr: this.upFrom });
      this.upFrom = null;
      this._record(now, 'pixel ratio back', why);
      return;
    }
    this.upFrom = null;
    if (v.msaaSamples > 0) { v.setQuality({ msaa: false }); this._record(now, 'multisampling off', why); return; }
    const min = this.minDpr();
    // When even the fastest frames are slow (p10 > 20 ms) the budget is just the
    // slow rate itself, so aim the proportional step at 1/60 s instead.
    const goal = p10 > 20 ? 1000 / 60 : budget;
    const target = q.dpr * Math.sqrt(goal / mean) * 0.92;
    const step = clamp(q.dpr - target, 0.1, 0.5);
    const next = Math.max(min, q.dpr - step);
    if (v.mode === 'cardboard' && q.bloom && next < 1.25) {
      v.setQuality({ bloom: false });
      this._record(now, 'bloom off', why);
      return;
    }
    if (q.dpr - next >= 0.05) {
      this.cap = q.dpr - 0.1; // never step back up to (or near) a level that failed
      v.setQuality({ dpr: next });
      this._record(now, 'pixel ratio down', why);
      return;
    }
    if (v.mode === 'screen' && q.shafts) { v.setQuality({ shafts: false }); this._record(now, 'sun shafts off', why); return; }
    if (q.bloom) { v.setQuality({ bloom: false }); this._record(now, 'bloom off', why); return; }
    this.downs--; // nothing left to turn down
  }

  _up(now) {
    const v = this.view, q = v.q;
    const next = Math.min(q.dpr + 0.15, this.cap, v.maxDpr());
    if (next < q.dpr + 0.1) return; // not worth a rebuild
    this.upFrom = q.dpr;
    this.upWait *= 2;
    v.setQuality({ dpr: next });
    this.ups++;
    this._record(now, 'pixel ratio up', 'steady for 30 s');
  }
}
