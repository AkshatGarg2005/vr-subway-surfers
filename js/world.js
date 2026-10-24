// The track: recycled 40 m chunks of scenery, obstacles, coins and power-ups.
// Everything repeated is drawn through instanced pools (js/pool.js).
//
// Floating origin: game logic uses s (metres along the track, unbounded).
// Rendering uses z = -(s - origin). Every REBASE_EVERY metres the origin moves
// forward and every pool shifts back, so coordinates stay small.
import * as THREE from 'three';
import {
  CHUNK_LEN, CHUNKS_AHEAD, CHUNKS_BEHIND, REBASE_EVERY, LANES, OBST, makeRng, hashSeed,
} from './config.js';
import { obstacleS0 } from './physics.js';
import { PatternGenerator } from './patterns.js';
import { InstancePool } from './pool.js';
import { LIVERIES } from './materials.js';
import * as B from './builders.js';

const COIN_SPIN = 3.2;

export class World {
  constructor(scene, mats) {
    this.scene = scene;
    this.mats = mats;
    this.root = new THREE.Group();
    this.root.name = 'world';
    scene.add(this.root);
    this.origin = 0;
    this.seed = 1;
    this.chunks = new Map();
    this.obstacles = [];     // active obstacles (sorted roughly by s)
    this.near = [];          // obstacles near the player this frame (for physics)
    this.coins = [];
    this.powerups = [];
    this.knocked = [];
    this.gen = null;
    this.time = 0;
    this._buildPools();
  }

  _pool(geo, mat, cap, opts) {
    const p = new InstancePool(geo, mat, cap, opts);
    this.root.add(p.mesh);
    return p;
  }

  _buildPools() {
    const M = this.mats;
    const P = (this.pools = {});
    const N = CHUNKS_AHEAD + CHUNKS_BEHIND + 2;
    // track
    P.ballast = this._pool(B.planeGeometry(8.2, CHUNK_LEN, 2, CHUNK_LEN / 4), M.ballast, N, { name: 'ballast' });
    P.ground = this._pool(B.planeGeometry(40, CHUNK_LEN, 40 / 6, CHUNK_LEN / 6), M.ground, N * 2, { name: 'ground' });
    P.sleeper = this._pool(B.sleeperGeometry(), M.sleeper, N * 160, { name: 'sleeper' });
    P.rail = this._pool(B.railGeometry(CHUNK_LEN), M.rail, N * 6, { name: 'rail' });
    // sides
    P.walls = [];
    for (let v = 0; v < 4; v++) {
      P.walls.push(this._pool(B.wallPanelGeometry(10, 2.6, 1 - (v + 1) * 0.25 + 0.002, 1 - v * 0.25 - 0.002), M.walls[0], N * 8, { name: 'wall' + v, castShadow: true }));
    }
    P.fencePanel = this._pool(B.fencePanelGeometry(10, 2.4), M.fence, N * 8, { name: 'fencePanel' });
    P.fencePost = this._pool(B.fencePostGeometry(2.6), M.metal, N * 8 * 5, { name: 'fencePost' });
    P.mast = this._pool(B.mastGeometry(), M.metal, N * 4, { name: 'mast', castShadow: true });
    P.wire = this._pool(B.wireGeometry(CHUNK_LEN), M.wire, N * 3, { name: 'wire', receiveShadow: false });
    P.gantry = this._pool(B.gantryGeometry(), M.metal, 4, { name: 'gantry', castShadow: true });
    P.signal = this._pool(B.signalLampGeometry(), M.signal, 4, { name: 'signal', receiveShadow: false, colors: true });
    P.cabinet = this._pool(B.cabinetGeometry(), M.paint, N * 6, { name: 'cabinet', castShadow: true });
    P.drum = this._pool(B.drumGeometry(), M.paint, N * 4, { name: 'drum', castShadow: true });
    P.barrel = this._pool(B.barrelGeometry(), M.paint, N * 6, { name: 'barrel', castShadow: true });
    P.lampPost = this._pool(B.lampPostGeometry(), M.metal, N * 2, { name: 'lampPost', castShadow: true });
    P.shed = this._pool(B.shedGeometry(), M.paint, N * 2, { name: 'shed', castShadow: true });
    P.wagon = this._pool(B.wagonGeometry(), M.wagon, N * 8, { name: 'wagon', colors: true });
    P.sideSleeper = this._pool(B.sleeperGeometry(), M.sleeper, N * 100, { name: 'sideSleeper' });
    P.sideRail = this._pool(B.railGeometry(CHUNK_LEN), M.rail, N * 4, { name: 'sideRail' });
    // obstacles
    P.hurdle = this._pool(B.hurdleGeometry(), M.hurdle, 48, { name: 'hurdle', castShadow: true });
    P.barrier = this._pool(B.barrierGeometry(), M.barrier, 48, { name: 'barrier', castShadow: true });
    P.wallOb = this._pool(B.wallGeometry(), M.wallOb, 48, { name: 'wallOb', castShadow: true });
    P.wallLamp = this._pool(B.wallLampGeometry(), M.lampRed, 48, { name: 'wallLamp', receiveShadow: false });
    P.ramp = this._pool(B.rampGeometry(), M.ramp, 24, { name: 'ramp', castShadow: true });
    P.trainBody = [];
    for (let i = 0; i < LIVERIES; i++) P.trainBody.push(this._pool(B.trainBodyGeometry(), M.trainBody[i], 48, { name: 'trainBody' + i, castShadow: true }));
    P.trainUnder = this._pool(B.trainUnderGeometry(), M.trainUnder, 160, { name: 'trainUnder', castShadow: false });
    P.headlight = this._pool(B.headlightGeometry(), M.headlight, 24, { name: 'headlight', receiveShadow: false });
    // pickups
    P.coin = this._pool(B.coinGeometry(), M.coin, 640, { name: 'coin', receiveShadow: false });
    P.power = {};
    for (const k of ['magnet', 'double', 'sneakers', 'shield']) P.power[k] = this._pool(B.powerupGeometry(k), M.power, 8, { name: 'power-' + k, receiveShadow: false });
    P.halo = this._pool(B.blobGeometry(0.75), M.halo, 32, { name: 'halo', receiveShadow: false });
    this.poolList = [];
    const walk = (o) => { if (o instanceof InstancePool) this.poolList.push(o); else if (o && typeof o === 'object') Object.values(o).forEach(walk); };
    walk(P);
  }

  z(s) { return -(s - this.origin); }

  // ------------------------------------------------------------------ run
  reset({ seed, cfg, planSpeed, coins = true, powerups = true }) {
    for (const p of this.poolList) p.clear();
    this.chunks.clear();
    this.obstacles.length = 0;
    this.near.length = 0;
    this.coins.length = 0;
    this.powerups.length = 0;
    this.knocked.length = 0;
    this.origin = 0;
    this.seed = seed;
    this.cfg = cfg;
    this.gen = new PatternGenerator({ seed, cfg, planSpeed, coins, powerups });
    this.coinCount = 0;
    this.lastS = 0;
  }

  // Called each frame with the player's s. Returns true if the origin moved.
  update(dt, sPlayer) {
    this.time += dt;
    let rebased = false;
    if (sPlayer - this.origin > REBASE_EVERY) {
      this.origin += REBASE_EVERY;
      for (const p of this.poolList) p.shiftZ(REBASE_EVERY);
      if (this.onRebase) this.onRebase(REBASE_EVERY);
      rebased = true;
    }
    const c0 = Math.floor(sPlayer / CHUNK_LEN) - CHUNKS_BEHIND;
    const c1 = Math.floor(sPlayer / CHUNK_LEN) + CHUNKS_AHEAD;
    for (const [c, ch] of this.chunks) if (c < c0) { this._freeChunk(ch); this.chunks.delete(c); }
    for (let c = Math.max(0, c0); c <= c1; c++) if (!this.chunks.has(c)) this._buildChunk(c);

    // Obstacles, coins and power-ups for everything up to the far end of the track.
    this.gen.generateUntil((c1 + 1) * CHUNK_LEN);
    const items = this.gen.items;
    if (items.length) {
      for (let i = 0; i < items.length; i++) this._spawn(items[i]);
      items.length = 0;
    }

    this._updateObstacles(dt, sPlayer);
    this._updateCoins(dt, sPlayer);
    this._updatePowerups(dt, sPlayer);
    this.lastS = sPlayer;
    return rebased;
  }

  flush() { for (const p of this.poolList) p.flush(); }

  // ------------------------------------------------------------------ chunks
  _take(ch, pool) {
    const i = pool.alloc();
    if (i >= 0) ch.slots.push(pool, i);
    return i;
  }

  _buildChunk(c) {
    const P = this.pools;
    const ch = { c, slots: [] };
    this.chunks.set(c, ch);
    const rng = makeRng(hashSeed(this.seed, c));
    const s0 = c * CHUNK_LEN;
    const zc = this.z(s0 + CHUNK_LEN / 2);
    let i;

    i = this._take(ch, P.ballast); P.ballast.setTRS(i, 0, -0.02, zc);
    i = this._take(ch, P.ground); P.ground.setTRS(i, -24.1, -0.06, zc);
    i = this._take(ch, P.ground); P.ground.setTRS(i, 24.1, -0.06, zc);

    const gap = B.TRACK.sleeperGap;
    for (let l = 0; l < 3; l++) {
      const x = LANES[l];
      for (let k = 0; k < CHUNK_LEN / gap; k++) {
        i = this._take(ch, P.sleeper);
        P.sleeper.setTRS(i, x + rng.range(-0.03, 0.03), 0, this.z(s0 + (k + 0.5) * gap), rng.range(-0.015, 0.015));
      }
      for (const sx of [-1, 1]) {
        i = this._take(ch, P.rail);
        P.rail.setTRS(i, x + (sx * B.TRACK.gauge) / 2, 0, zc);
      }
    }

    // Sides: graffiti walls or fences in 10 m segments.
    for (const side of [-1, 1]) {
      for (let k = 0; k < 4; k++) {
        const z = this.z(s0 + k * 10 + 5);
        const x = side * B.TRACK.wallX;
        if (rng.chance(0.6)) {
          const v = rng.int(0, 3);
          i = this._take(ch, P.walls[v]);
          P.walls[v].setTRS(i, x, 0, z, side > 0 ? 0 : Math.PI);
        } else {
          i = this._take(ch, P.fencePanel);
          P.fencePanel.setTRS(i, x, 0, z);
          for (let p = 0; p < 4; p++) {
            i = this._take(ch, P.fencePost);
            P.fencePost.setTRS(i, x, 0, this.z(s0 + k * 10 + p * 2.5));
          }
        }
      }
      // Outer sidings: a spare track with parked freight wagons.
      const sx = side * 9.2;
      for (let k = 0; k < CHUNK_LEN / 1.2; k++) {
        i = this._take(ch, P.sideSleeper);
        P.sideSleeper.setTRS(i, sx, -0.03, this.z(s0 + (k + 0.5) * 1.2), rng.range(-0.03, 0.03), 1, 1, 1);
      }
      for (const gx of [-1, 1]) {
        i = this._take(ch, P.sideRail);
        P.sideRail.setTRS(i, sx + (gx * B.TRACK.gauge) / 2, -0.03, zc);
      }
      if (rng.chance(0.7)) {
        const n = rng.int(1, 3);
        const start = rng.range(0, 6);
        const palette = [[0.55, 0.22, 0.16], [0.18, 0.32, 0.5], [0.42, 0.44, 0.4], [0.62, 0.48, 0.22], [0.25, 0.38, 0.28]];
        for (let w = 0; w < n; w++) {
          i = this._take(ch, P.wagon);
          P.wagon.setTRS(i, sx, 0, this.z(s0 + start + w * 13.6 + 6.5));
          const col = rng.pick(palette);
          P.wagon.setColor(i, col[0], col[1], col[2]);
        }
      }
    }

    // Catenary masts every 20 m and wires over each lane.
    for (const ms of [0, 20]) {
      for (const side of [-1, 1]) {
        i = this._take(ch, P.mast);
        P.mast.setTRS(i, side * 4.6, 0, this.z(s0 + ms), side > 0 ? 0 : Math.PI);
      }
    }
    for (let l = 0; l < 3; l++) {
      i = this._take(ch, P.wire);
      P.wire.setTRS(i, LANES[l], 5.75, zc);
    }
    if (c % 5 === 3) {
      const z = this.z(s0 + 10);
      i = this._take(ch, P.gantry); P.gantry.setTRS(i, 0, 0, z);
      i = this._take(ch, P.signal); P.signal.setTRS(i, 0, 0, z);
      const go = rng.chance(0.5);
      P.signal.setColor(i, go ? 0.2 : 5, go ? 4 : 0.3, go ? 1 : 0.2);
    }

    // Trackside props between the outer rail and the wall.
    const props = [P.cabinet, P.cabinet, P.drum, P.barrel, P.barrel, P.lampPost, P.shed];
    const nProps = rng.int(2, 5);
    for (let k = 0; k < nProps; k++) {
      const pool = rng.pick(props);
      const side = rng.chance(0.5) ? -1 : 1;
      const big = pool === P.shed;
      const x = side * (big ? rng.range(6.6, 7.2) : rng.range(3.95, 4.3));
      if (big && rng.chance(0.5)) continue;
      i = this._take(ch, pool);
      const yaw = pool === P.lampPost ? (side > 0 ? 0 : Math.PI) : rng.range(-0.3, 0.3) + (side > 0 ? Math.PI / 2 : -Math.PI / 2);
      pool.setTRS(i, x, 0, this.z(s0 + rng.range(2, CHUNK_LEN - 2)), yaw);
    }
  }

  _freeChunk(ch) {
    const s = ch.slots;
    for (let k = 0; k < s.length; k += 2) s[k].free(s[k + 1]);
    s.length = 0;
  }

  // ------------------------------------------------------------------ spawning
  _spawn(it) {
    const P = this.pools;
    if (it.type === 'coin') {
      const slot = P.coin.alloc();
      this.coins.push({ s: it.s, x: it.x, y: it.y, lane: it.lane, slot, taken: false, t: 0, magnet: false, ms: 0, mx: 0, my: 0 });
      return;
    }
    if (it.type === 'power') {
      const pool = P.power[it.kind];
      const slot = pool.alloc();
      const halo = P.halo.alloc();
      this.powerups.push({ kind: it.kind, s: it.s, x: it.x, y: it.y, lane: it.lane, slot, halo, pool, taken: false, t: 0 });
      return;
    }
    const ob = it.ob;
    const v = (ob.view = { slots: [], cars: [] });
    const take = (pool) => { const i = pool.alloc(); v.slots.push(pool, i); return i; };
    switch (ob.kind) {
      case 'hurdle': v.main = take(P.hurdle); v.pool = P.hurdle; break;
      case 'barrier': v.main = take(P.barrier); v.pool = P.barrier; break;
      case 'wall': v.main = take(P.wallOb); v.pool = P.wallOb; v.lamp = take(P.wallLamp); break;
      case 'ramp': v.main = take(P.ramp); v.pool = P.ramp; break;
      case 'train': {
        const livery = ob.moving ? (ob.id % 2) * 2 + 1 : ob.id % LIVERIES;
        v.livery = P.trainBody[livery];
        for (let k = 0; k < ob.cars; k++) v.cars.push(take(v.livery), take(P.trainUnder));
        if (ob.moving) v.light = take(P.headlight);
        break;
      }
    }
    this.obstacles.push(ob);
    this._placeObstacle(ob, ob.moving ? obstacleS0(ob, this.lastS) : ob.s0);
  }

  _placeObstacle(ob, s0) {
    const v = ob.view, P = this.pools;
    if (ob.kind === 'train') {
      const pitch = OBST.train.car + OBST.train.coupler;
      for (let k = 0; k < ob.cars; k++) {
        const z = this.z(s0 + k * pitch + OBST.train.car / 2);
        v.livery.setTRS(v.cars[k * 2], ob.x, 0, z);
        P.trainUnder.setTRS(v.cars[k * 2 + 1], ob.x, 0, z);
      }
      if (v.light !== undefined) P.headlight.setTRS(v.light, ob.x, 0, this.z(s0 + OBST.train.car / 2));
      return;
    }
    const z = this.z(s0 + ob.len / 2);
    if (ob.kind === 'ramp') { v.pool.setTRS(v.main, ob.x, 0, z); return; }
    v.pool.setTRS(v.main, ob.x, 0, z);
    if (v.lamp !== undefined) P.wallLamp.setTRS(v.lamp, ob.x, 0, z);
  }

  _despawn(ob) {
    const s = ob.view.slots;
    for (let k = 0; k < s.length; k += 2) s[k].free(s[k + 1]);
    ob.view = null;
  }

  knock(ob) {
    ob.knocked = true;
    ob.knockT = 0;
    this.knocked.push(ob);
  }

  _updateObstacles(dt, sp) {
    const obs = this.obstacles;
    const near = this.near;
    near.length = 0;
    let w = 0;
    for (let r = 0; r < obs.length; r++) {
      const ob = obs[r];
      const s0 = ob.moving ? obstacleS0(ob, sp) : ob.s0;
      if (s0 + ob.len < sp - 25) { this._despawn(ob); continue; }
      obs[w++] = ob;
      if (ob.moving) this._placeObstacle(ob, s0);
      if (s0 < sp + 40 && s0 + ob.len > sp - 6) near.push(ob);
    }
    obs.length = w;
    // knocked-over hurdles tip forward
    for (let k = this.knocked.length - 1; k >= 0; k--) {
      const ob = this.knocked[k];
      if (!ob.view) { this.knocked.splice(k, 1); continue; }
      ob.knockT += dt;
      const a = Math.min(1, ob.knockT / 0.35);
      const ang = -(Math.PI / 2) * (a * a);
      const z = this.z(ob.s0 + ob.len / 2) - a * 0.4;
      ob.view.pool.setTRSE(ob.view.main, ob.x, 0.02, z, ang, 0, 0);
      if (a >= 1) this.knocked.splice(k, 1);
    }
  }

  // ------------------------------------------------------------------ coins
  _updateCoins(dt, sp) {
    const P = this.pools;
    const coins = this.coins;
    const ang = this.time * COIN_SPIN;
    let w = 0;
    for (let r = 0; r < coins.length; r++) {
      const c = coins[r];
      if (c.s < sp - 6 && !c.magnet) { P.coin.free(c.slot); continue; }
      if (c.taken) {
        c.t += dt;
        if (c.t > 0.18) { P.coin.free(c.slot); continue; }
        const k = 1 - c.t / 0.18;
        P.coin.setTRS(c.slot, c.x, c.y + c.t * 4, this.z(c.s), ang * 3, k, k, k);
        coins[w++] = c;
        continue;
      }
      coins[w++] = c;
      if (c.s > sp + 120) { P.coin.setTRS(c.slot, c.x, c.y, this.z(c.s), 0); continue; }
      P.coin.setTRS(c.slot, c.x, c.y, this.z(c.s), ang + c.s * 0.35);
    }
    coins.length = w;
  }

  _updatePowerups(dt, sp) {
    const P = this.pools;
    const list = this.powerups;
    let w = 0;
    for (let r = 0; r < list.length; r++) {
      const p = list[r];
      if (p.s < sp - 6 || (p.taken && (p.t += dt) > 0.25)) {
        p.pool.free(p.slot);
        P.halo.free(p.halo);
        continue;
      }
      list[w++] = p;
      const bob = Math.sin(this.time * 3 + p.s) * 0.12;
      const k = p.taken ? 1 + p.t * 3 : 1;
      p.pool.setTRS(p.slot, p.x, p.y + bob + (p.taken ? p.t * 3 : 0), this.z(p.s), this.time * 2.2, k, k, k);
      P.halo.setTRS(p.halo, p.x, 0.03, this.z(p.s), 0, 1, 1, 1);
    }
    list.length = w;
  }
}
