// Player physics and collision rules. Pure JavaScript (no three.js, no DOM) so
// that tools/solvable.mjs runs exactly this code in Node.
//
// Coordinates: s = metres along the track (increasing forward), x = metres
// sideways (lanes at LANES), y = metres up from the ground.
//
// Obstacles are plain objects made by js/patterns.js:
//   { kind, lane, x, s0, len, y0, y1, moving?: { k, sMeet, sStart }, knocked, noCollide }
// A moving train's position depends only on the player's s (see obstacleS0),
// so it always meets the player exactly at sMeet whatever the speed.

import { LANES, LANE_W, BODY, OBST, MARGIN, ROOF_Y, SNEAKER_HEIGHT, clamp, lerp, smoothstep } from './config.js';

const SNEAK = Math.sqrt(SNEAKER_HEIGHT);
const ROOF_HALF = LANE_W / 2;  // roofs and ramps support you across the whole lane, so adjacent roofs join

export function obstacleS0(ob, sPlayer) {
  const m = ob.moving;
  if (!m) return ob.s0;
  return Math.min(m.sStart, m.sMeet + m.k * (m.sMeet - sPlayer));
}

// Top surface height of an obstacle at track position s (ramps slope up).
export function obstacleTop(ob, s, s0) {
  if (ob.kind === 'ramp') return ROOF_Y * clamp((s - s0) / ob.len, 0, 1);
  return ob.y1;
}

// Event kinds returned by step()
export const EV = { JUMP: 1, LAND: 2, ROLL: 3, LANE: 4, SIDE: 5, FRONT: 6, ROLL_END: 7, FALL: 8 };

export class PlayerBody {
  constructor(cfg) {
    this.cfg = cfg;
    this.events = [];      // [{ type, ob, value }] reused records
    this._evPool = [];
    for (let i = 0; i < 8; i++) this._evPool.push({ type: 0, ob: null, value: 0 });
    this.nEvents = 0;
    this.reset();
  }

  reset(s = 0, lane = 1) {
    this.s = s;
    this.lane = lane;
    this.prevLane = lane;
    this.x = LANES[lane];
    this.laneFromX = this.x;
    this.laneT = 1;
    this.laneDur = 1;
    this.y = 0;
    this.vy = 0;
    this.grounded = true;
    this.airT = 0;
    this.coyoteT = 0;
    this.jumpBufT = 0;
    this.rollT = 0;
    this.rollQueued = false;
    this.height = BODY.standH;
    this.sneakers = false;
    this.jumped = false;
    this.jumpFromY = 0;
    this.bounceT = 0;
    this.bounceOb = null;
    this.supportOb = null;
    this.ps = s; this.px = this.x; this.py = 0; this.ph = this.height;
    this.nEvents = 0;
  }

  copyFrom(o) {
    this.cfg = o.cfg;
    this.s = o.s; this.lane = o.lane; this.prevLane = o.prevLane; this.x = o.x;
    this.laneFromX = o.laneFromX; this.laneT = o.laneT; this.laneDur = o.laneDur;
    this.y = o.y; this.vy = o.vy; this.grounded = o.grounded; this.airT = o.airT;
    this.coyoteT = o.coyoteT; this.jumpBufT = o.jumpBufT; this.rollT = o.rollT;
    this.rollQueued = o.rollQueued; this.height = o.height; this.sneakers = o.sneakers;
    this.jumped = o.jumped; this.jumpFromY = o.jumpFromY;
    this.bounceT = o.bounceT; this.bounceOb = o.bounceOb; this.supportOb = o.supportOb;
    this.ps = o.ps; this.px = o.px; this.py = o.py; this.ph = o.ph;
    return this;
  }

  get rolling() { return this.rollT > 0 || this.rollQueued; }
  get changingLane() { return this.laneT < this.laneDur; }
  get onRoof() { return this.grounded && this.y > ROOF_Y - 0.3; }
  jumpVelocity() { return this.cfg.jumpV * (this.sneakers ? SNEAK : 1); }

  _emit(type, ob = null, value = 0) {
    if (this.nEvents >= this._evPool.length) return;
    const e = this._evPool[this.nEvents];
    e.type = type; e.ob = ob; e.value = value;
    this.events[this.nEvents++] = e;
  }

  // ------------------------------------------------------------ requests
  requestLane(dir) {
    const target = this.lane + dir;
    if (target < 0 || target > 2) return false;
    this.prevLane = this.lane;
    this.lane = target;
    this.laneFromX = this.x;
    this.laneT = 0;
    // A partial move (re-targeting mid-change) takes proportionally less time.
    this.laneDur = Math.max(0.06, this.cfg.laneTime * Math.min(1.5, Math.abs(LANES[target] - this.x) / LANE_W));
    this._emit(EV.LANE, null, dir);
    return true;
  }

  requestJump(obs) {
    if (this.grounded || this.coyoteT > 0) {
      if (this.rolling && obs && this._underCeiling(obs)) { this.jumpBufT = BODY.jumpBuffer; return false; }
      this._doJump();
      return true;
    }
    this.jumpBufT = BODY.jumpBuffer;
    return false;
  }

  _doJump() {
    this.jumpFromY = this.y;   // the VR camera rises only part of a jump, but all of a climb
    this.jumped = true;
    this.vy = this.jumpVelocity();
    this.grounded = false;
    this.coyoteT = 0;
    this.jumpBufT = 0;
    this.airT = 0;
    this.rollT = 0;
    this.rollQueued = false;
    this.height = BODY.standH;
    this.supportOb = null;
    this._emit(EV.JUMP);
  }

  requestRoll() {
    this.jumpBufT = 0;
    if (this.grounded) {
      this.rollT = this.cfg.rollTime;
      this.rollQueued = false;
    } else {
      // Mid-air roll: drop fast, then roll on landing.
      this.vy = Math.min(this.vy, BODY.fastFallVy);
      this.rollQueued = true;
    }
    this.height = BODY.rollH;
    this._emit(EV.ROLL);
    return true;
  }

  // ------------------------------------------------------------ queries
  // Highest surface under the player's footprint that the feet can stand on.
  _support(obs) {
    let h = 0;
    let best = null;
    // Ramps and roofs carry you up small steps; hurdles and barriers only hold
    // you if you come down onto them from above (no stepping up onto a hurdle).
    const reachWide = this.y + BODY.stepUp;
    const reachSmall = Math.max(this.y, this.py) + 0.03;
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i];
      if (ob.knocked) continue;
      const wide = ob.kind === 'train' || ob.kind === 'ramp';
      const reach = wide ? reachWide : reachSmall;
      const hw = wide ? ROOF_HALF : ob.halfW;
      if (Math.abs(this.x - ob.x) > hw) continue;
      const s0 = obstacleS0(ob, this.s);
      // Roofs and ramps carry you while your centre is over them; small
      // obstacles while any part of your footprint is.
      const pad = wide ? 0 : BODY.halfD;
      if (this.s < s0 - pad || this.s > s0 + ob.len + pad) continue;
      // On a ramp the front of the body sets the height, so you reach roof
      // height exactly as your front reaches the train (not 12 cm below it).
      const top = obstacleTop(ob, ob.kind === 'ramp' ? this.s + BODY.halfD : this.s, s0);
      if (top <= reach && top > h) { h = top; best = ob; }
    }
    this.supportOb = best;
    return h;
  }

  // Would a standing body hit something overhead right now?
  _underCeiling(obs) {
    const y0 = this.y, y1 = this.y + BODY.standH;
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i];
      if (ob.knocked || ob.noCollide || ob.kind === 'ramp') continue;
      const s0 = obstacleS0(ob, this.s) + MARGIN.s;
      const s1 = s0 + ob.len - 2 * MARGIN.s;
      if (this.s + BODY.halfD <= s0 || this.s - BODY.halfD >= s1) continue;
      if (Math.abs(this.x - ob.x) >= ob.halfW - MARGIN.x + BODY.halfW) continue;
      if (y1 > ob.y0 + MARGIN.y && y0 < ob.y1 - MARGIN.y && y0 + BODY.rollH <= ob.y0 + MARGIN.y) return true;
    }
    return false;
  }

  // ------------------------------------------------------------ step
  // Advance by dt at forward speed v. Returns the number of events in this.events.
  // Stops at the first collision so the caller can resolve it.
  step(dt, v, obs) {
    this.nEvents = 0;
    this.ps = this.s; this.px = this.x; this.py = this.y; this.ph = this.height;
    const cfg = this.cfg;

    this.s += v * dt;

    // Sideways: smooth move between lanes, never an instant jump.
    if (this.laneT < this.laneDur) {
      this.laneT += dt;
      this.x = lerp(this.laneFromX, LANES[this.lane], smoothstep(Math.min(1, this.laneT / this.laneDur)));
    } else {
      this.x = LANES[this.lane];
    }

    if (this.bounceT > 0) { this.bounceT -= dt; if (this.bounceT <= 0) this.bounceOb = null; }
    if (this.coyoteT > 0) this.coyoteT -= dt;
    if (this.jumpBufT > 0) this.jumpBufT -= dt;

    if (this.rollT > 0) {
      this.rollT -= dt;
      if (this.rollT <= 0) {
        if (this._underCeiling(obs)) {
          this.rollT = 0.04; // keep rolling until clear of the barrier overhead
        } else {
          this.rollT = 0;
          this.height = BODY.standH;
          this._emit(EV.ROLL_END);
        }
      }
    }

    // Vertical: exact ballistic integration, so the arc doesn't depend on dt.
    if (!this.grounded) {
      const g = cfg.gravity;
      this.y += this.vy * dt - 0.5 * g * dt * dt;
      this.vy -= g * dt;
      this.airT += dt;
    }

    const sup = this._support(obs);
    if (this.grounded) {
      if (sup < this.y - 0.02) {
        // Ran off an edge (end of a roof): fall with normal gravity.
        this.grounded = false;
        this.vy = 0;
        this.airT = 0;
        this.coyoteT = BODY.coyote;
        this.jumped = false;
        this._emit(EV.FALL);
      } else {
        this.y = sup;
      }
    } else if (this.y <= sup) {
      if (this.vy <= 0) {
        this.y = sup;
        const air = this.airT;
        this.vy = 0;
        this.grounded = true;
        this.jumped = false;
        this._emit(EV.LAND, this.supportOb, air);
        if (this.rollQueued) {
          this.rollQueued = false;
          this.rollT = cfg.rollTime;
          this.height = BODY.rollH;
        }
        if (this.jumpBufT > 0 && !(this.rolling && this._underCeiling(obs))) this._doJump();
      } else {
        this.y = sup; // pushed up onto a ledge while still rising
      }
    }

    if (!this.rolling) this.height = BODY.standH;

    this._collide(obs);
    return this.nEvents;
  }

  _collide(obs) {
    const hx = BODY.halfW, hd = BODY.halfD;
    const feet = this.y, head = this.y + this.height;
    const pFeet = this.py, pHead = this.py + this.ph;
    for (let i = 0; i < obs.length; i++) {
      const ob = obs[i];
      if (ob.knocked || ob.noCollide) continue;
      const ohw = ob.halfW - MARGIN.x;
      if (Math.abs(this.x - ob.x) >= ohw + hx) continue;
      const s0 = obstacleS0(ob, this.s) + MARGIN.s;
      const s1 = s0 + ob.len - 2 * MARGIN.s;
      if (this.s + hd <= s0 || this.s - hd >= s1) continue;
      const top = obstacleTop(ob, this.s, s0 - MARGIN.s) - MARGIN.y;
      const bot = ob.y0 + (ob.y0 > 0 ? MARGIN.y : 0);
      if (feet >= top - 0.02 || head <= bot) continue;

      // Overlapping: work out what we ran into from where we were a step ago.
      const ps0 = obstacleS0(ob, this.ps) + MARGIN.s;
      const ps1 = ps0 + ob.len - 2 * MARGIN.s;
      const wasSepS = this.ps + hd <= ps0 || this.ps - hd >= ps1;
      const wasSepX = Math.abs(this.px - ob.x) >= ohw + hx;
      const pTop = obstacleTop(ob, this.ps, ps0 - MARGIN.s) - MARGIN.y;
      if (pFeet >= pTop - 0.02 && !wasSepS && !wasSepX) {
        // Came down onto it from above: stand on it.
        this.y = top + MARGIN.y; this.vy = 0; this.grounded = true; this.jumped = false;
        continue;
      }
      if (wasSepX && !wasSepS && !(pHead <= bot)) {
        if (ob === this.bounceOb) continue;
        // Scraped its side during a lane change: bounce back to the lane we left.
        this.bounceOb = ob;
        this.bounceT = 0.4;
        const back = this.prevLane;
        this.prevLane = this.lane;
        this.lane = back;
        this.laneFromX = this.x;
        this.laneT = 0;
        this.laneDur = Math.max(0.08, this.cfg.laneTime * Math.abs(LANES[back] - this.x) / LANE_W);
        this._emit(EV.SIDE, ob);
        return;
      }
      this._emit(EV.FRONT, ob);
      return;
    }
  }
}

// Collision volumes per kind (shared by patterns.js and the tools).
export function makeObstacle(kind, lane, s0, extra = {}) {
  const o = OBST[kind];
  const ob = {
    id: 0, kind, lane, x: LANES[lane], s0,
    len: 0, halfW: o.halfW, y0: 0, y1: 0,
    cars: 0, moving: null, knocked: false, noCollide: false,
    view: null, hinted: false,
    ...extra,
  };
  switch (kind) {
    case 'hurdle': ob.len = o.d; ob.y1 = o.h; break;
    case 'barrier': ob.len = o.d; ob.y0 = o.y0; ob.y1 = o.y1; break;
    case 'wall': ob.len = o.d; ob.y1 = o.h; break;
    case 'train': ob.y1 = o.h; break; // len set by caller from cars
    case 'ramp': ob.len = o.len; ob.y1 = ROOF_Y; break;
  }
  return ob;
}
