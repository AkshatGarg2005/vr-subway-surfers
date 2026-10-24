// Characters built from primitives and animated in code (no skinning, no assets).
//   Player:  a skater kid in a hoodie, cap worn backwards and a backpack.
//   Chasers: a rail-yard warden in a high-vis vest with a torch, and a robot dog.
import * as THREE from 'three';
import { clamp, damp } from './config.js';
import { tint, box, merge } from './builders.js';

const _tmp = { x: 0, y: 0 };
const set = (a, x, y) => { a[0] = x; a[1] = y; return a; };

function capsule(r, len, color, radial = 8) {
  const g = new THREE.CapsuleGeometry(r, Math.max(0.001, len - 2 * r), 3, radial);
  g.translate(0, -len / 2, 0); // pivot at the top
  return tint(g, color);
}
function sphere(r, color, x = 0, y = 0, z = 0, w = 10, h = 8) {
  const g = new THREE.SphereGeometry(r, w, h);
  g.translate(x, y, z);
  return tint(g, color);
}
function rbox(w, h, d, color, x = 0, y = 0, z = 0) {
  // softened box: a box with bevel-ish look via a slightly scaled sphere-capsule mix is overkill;
  // a plain box reads fine at game distance.
  return box(w, h, d, x, y, z, color);
}

function part(parent, geo, mat, x = 0, y = 0, z = 0) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  pivot.add(mesh);
  parent.add(pivot);
  return pivot;
}

// A humanoid with hips -> torso -> head, two arms (shoulder, elbow) and legs (hip, knee).
function humanoid(mat, P) {
  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = P.hipY;
  root.add(hips);
  const pelvis = part(hips, merge([rbox(P.hipW, 0.2, 0.22, P.pants, 0, -0.02, 0)]), mat);
  pelvis.name = 'pelvis';
  const torso = part(hips, merge(P.torsoParts()), mat, 0, 0.06, 0);
  const head = part(torso, merge(P.headParts()), mat, 0, P.neckY, 0);
  const limbs = {};
  for (const side of [-1, 1]) {
    const sh = part(torso, merge([capsule(P.armR, P.upperArm, P.sleeve)]), mat, side * P.shoulderX, P.shoulderY, 0);
    const el = part(sh, merge([capsule(P.armR * 0.9, P.foreArm, P.forearmColor), sphere(P.armR * 1.15, P.skin, 0, -P.foreArm, 0, 8, 6), ...(P.handExtra ? P.handExtra(side) : [])]), mat, 0, -P.upperArm, 0);
    const hp = part(hips, merge([capsule(P.legR, P.thigh, P.pants)]), mat, side * P.hipX, -0.05, 0);
    const kn = part(hp, merge([capsule(P.legR * 0.9, P.shin, P.shinColor || P.pants), rbox(P.legR * 2.2, 0.1, 0.3, P.shoe, 0, -P.shin - 0.02, 0.06), rbox(P.legR * 2.3, 0.03, 0.32, P.sole, 0, -P.shin - 0.08, 0.06)]), mat, 0, -P.thigh, 0);
    limbs[side] = { sh, el, hp, kn };
  }
  return { root, hips, torso, head, limbs };
}

const KID = {
  hipY: 0.92, hipW: 0.32, hipX: 0.1, neckY: 0.5,
  shoulderX: 0.22, shoulderY: 0.44,
  armR: 0.055, upperArm: 0.27, foreArm: 0.25,
  legR: 0.075, thigh: 0.42, shin: 0.4,
  skin: 0xc68a5e, pants: 0x2b3f63, shinColor: 0x2b3f63, shoe: 0xf0f0f0, sole: 0xe23b3b,
  sleeve: 0xff7a1a, forearmColor: 0xff7a1a,
  torsoParts() {
    return [
      rbox(0.4, 0.5, 0.25, 0xff7a1a, 0, 0.24, 0),          // hoodie
      rbox(0.36, 0.08, 0.22, 0xffe14a, 0, 0.06, 0.02),      // stripe
      rbox(0.18, 0.14, 0.02, 0xd9601a, 0, 0.18, 0.13),      // pocket
      rbox(0.34, 0.4, 0.17, 0x2fb3a0, 0, 0.27, -0.2),       // backpack
      rbox(0.26, 0.14, 0.05, 0x23897a, 0, 0.16, -0.3),      // pack pocket
      rbox(0.05, 0.42, 0.04, 0x1d1d1d, -0.13, 0.27, 0.13),  // straps
      rbox(0.05, 0.42, 0.04, 0x1d1d1d, 0.13, 0.27, 0.13),
      rbox(0.42, 0.1, 0.27, 0xe0661a, 0, 0.47, 0),          // shoulders/hood rim
    ];
  },
  headParts() {
    return [
      sphere(0.075, 0xc68a5e, 0, -0.02, 0, 8, 6),           // neck
      sphere(0.165, 0xc68a5e, 0, 0.14, 0, 14, 10),          // head
      sphere(0.172, 0x1f6fe0, 0, 0.19, 0, 14, 8),           // cap dome (cut by visor)
      rbox(0.24, 0.03, 0.16, 0x1650b0, 0, 0.21, -0.2),      // visor, worn backwards
      rbox(0.07, 0.07, 0.02, 0xffe14a, 0, 0.27, 0.16),      // cap patch
      sphere(0.03, 0x1b1b1b, -0.06, 0.15, 0.15, 6, 4),      // eyes
      sphere(0.03, 0x1b1b1b, 0.06, 0.15, 0.15, 6, 4),
      rbox(0.05, 0.03, 0.02, 0x8a4f33, 0, 0.07, 0.16),      // mouth
    ];
  },
};

const WARDEN = {
  hipY: 1.02, hipW: 0.4, hipX: 0.13, neckY: 0.6,
  shoulderX: 0.3, shoulderY: 0.53,
  armR: 0.07, upperArm: 0.3, foreArm: 0.28,
  legR: 0.09, thigh: 0.46, shin: 0.44,
  skin: 0xa96f4a, pants: 0x262b33, shoe: 0x1a1a1a, sole: 0x111111,
  sleeve: 0x3a4250, forearmColor: 0x3a4250,
  torsoParts() {
    return [
      rbox(0.52, 0.62, 0.34, 0x3a4250, 0, 0.3, 0),           // jacket
      rbox(0.54, 0.5, 0.36, 0xc8f02a, 0, 0.3, 0),             // high-vis vest
      rbox(0.55, 0.05, 0.37, 0xe6e6e6, 0, 0.18, 0),           // reflective stripes
      rbox(0.55, 0.05, 0.37, 0xe6e6e6, 0, 0.34, 0),
      rbox(0.08, 0.06, 0.02, 0xffd23d, -0.14, 0.45, 0.19),    // badge
      rbox(0.5, 0.1, 0.36, 0x2a2f38, 0, -0.02, 0),            // belt
    ];
  },
  headParts() {
    return [
      sphere(0.09, 0xa96f4a, 0, -0.02, 0, 8, 6),
      sphere(0.19, 0xa96f4a, 0, 0.15, 0, 14, 10),
      rbox(0.4, 0.04, 0.42, 0x1d2430, 0, 0.27, 0.03),         // cap brim
      sphere(0.2, 0x1d2430, 0, 0.27, -0.01, 14, 6),           // cap
      rbox(0.08, 0.06, 0.02, 0xffd23d, 0, 0.32, 0.19),
      rbox(0.22, 0.05, 0.03, 0x4a3326, 0, 0.08, 0.18),        // moustache
      sphere(0.03, 0x111111, -0.07, 0.17, 0.17, 6, 4),
      sphere(0.03, 0x111111, 0.07, 0.17, 0.17, 6, 4),
    ];
  },
  handExtra(side) {
    if (side < 0) return [];
    // torch in the right hand (the lit lens is a separate emissive mesh)
    const g = new THREE.CylinderGeometry(0.035, 0.03, 0.2, 8);
    g.rotateX(Math.PI / 2);
    g.translate(0, -0.3, 0.08);
    return [tint(g, 0x30343a)];
  },
};

export class Characters {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.05 });
    this.glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.4, 2.6, 3.2), toneMapped: false });
    this.torchMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.4, 3), toneMapped: false });

    // Player
    this.kid = humanoid(this.mat, KID);
    this.player = new THREE.Group();
    this.player.name = 'player';
    // Models are built facing +Z; everyone runs toward -Z.
    this.kid.root.rotation.y = Math.PI;
    this.player.add(this.kid.root);
    // hoverboard (shown while the board shield is active)
    const board = new THREE.Mesh(merge([
      box(0.36, 0.06, 1.1, 0, 0, 0, 0xffc23d), box(0.3, 0.065, 0.8, 0, 0.002, 0, 0xff6a2a),
      box(0.06, 0.02, 0.6, 0, -0.04, 0, 0x39d7ff),
    ]), this.mat);
    board.position.y = 0.05;
    board.visible = false;
    this.board = board;
    this.player.add(board);
    scene.add(this.player);

    // Warden
    this.warden = humanoid(this.mat, WARDEN);
    this.wardenG = new THREE.Group();
    this.warden.root.rotation.y = Math.PI;
    this.wardenG.add(this.warden.root);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.03, 10), this.torchMat);
    lens.position.set(0, -0.3, 0.185);
    this.warden.limbs[1].el.add(lens);
    scene.add(this.wardenG);

    // Robot dog
    this.dog = this._dog();
    scene.add(this.dog.root);

    this.phase = 0;
    this.dogPhase = 0;
    this.lean = 0;
    this.prevX = 0;
    this.rollSpin = 0;
    this.stumbleT = 9;
    this.visiblePlayer = true;
    this.reset();
  }

  _dog() {
    const root = new THREE.Group();
    const body = new THREE.Group();
    body.position.y = 0.55;
    body.rotation.y = Math.PI;
    root.add(body);
    const mat = this.mat;
    part(body, merge([
      rbox(0.36, 0.26, 0.78, 0x9aa3ad, 0, 0, 0),
      rbox(0.38, 0.06, 0.6, 0x3c4450, 0, 0.15, 0),
      rbox(0.3, 0.04, 0.3, 0xff7a1a, 0, 0.19, -0.05),
      rbox(0.4, 0.08, 0.08, 0x3c4450, 0, -0.05, 0.38),
    ]), mat);
    const head = part(body, merge([
      rbox(0.3, 0.22, 0.32, 0xb7c0ca, 0, 0.05, 0.1),
      rbox(0.24, 0.12, 0.14, 0x8a939d, 0, -0.02, 0.3),
      rbox(0.05, 0.16, 0.05, 0x3c4450, 0.1, 0.24, 0.0),
    ]), mat, 0, 0.12, 0.42);
    const eyes = new THREE.Mesh(merge([box(0.07, 0.04, 0.02, -0.07, 0.08, 0.27), box(0.07, 0.04, 0.02, 0.07, 0.08, 0.27)]), this.glow);
    head.add(eyes);
    const tail = part(body, merge([capsule(0.025, 0.3, 0x3c4450, 5)]), mat, 0, 0.08, -0.4);
    tail.rotation.x = -2.2;
    const legs = [];
    for (const [x, z] of [[-0.15, 0.3], [0.15, 0.3], [-0.15, -0.3], [0.15, -0.3]]) {
      const up = part(body, merge([capsule(0.045, 0.28, 0x6c7580, 6)]), mat, x, -0.08, z);
      const lo = part(up, merge([capsule(0.035, 0.26, 0x3c4450, 6), sphere(0.05, 0x22262b, 0, -0.26, 0.02, 6, 4)]), mat, 0, -0.28, 0);
      legs.push({ up, lo });
    }
    return { root, body, head, tail, legs };
  }

  reset() {
    this.phase = 0;
    this.lean = 0;
    this.rollSpin = 0;
    this.deathT = 0;
    this.stumbleT = 9;
    this.player.rotation.set(0, 0, 0);
    this.kid.root.rotation.set(0, Math.PI, 0);
    this.kid.root.position.set(0, 0, 0);
  }

  stumble() { this.stumbleT = 0; }

  update(dt, game) {
    const b = game.body, w = game.world, run = game.run;
    const vr = game.isVR;
    const state = game.state;
    // In VR you are the runner: hide the body.
    const firstPerson = vr || game.settings.camera === 'fp';
    this.player.visible = !firstPerson && this.visiblePlayer && state !== 'menu';
    const showChasers = state !== 'menu' && run;
    this.wardenG.visible = !!showChasers;
    this.dog.root.visible = !!showChasers;

    const speed = run ? run.speed : 0;
    const z = w.z(b.s);
    const groundOff = 0.1 * Math.max(0, 1 - b.y / 0.3); // feet on top of the sleepers
    this.player.position.set(b.x, b.y + groundOff, z);
    this.board.visible = !!(run && run.power.shield);

    // ---------------- player pose
    const K = this.kid;
    const running = state === 'running' || state === 'countdown';
    const dying = state === 'dying' || state === 'over';
    const freq = clamp(1.1 + speed * 0.075, 1.3, 3.0);
    if (running && b.grounded) this.phase += dt * freq * Math.PI * 2;
    const ph = this.phase;
    const vx = (b.x - this.prevX) / Math.max(dt, 1e-3);
    this.prevX = b.x;
    this.lean = damp(this.lean, clamp(-vx * 0.035, -0.35, 0.35), 12, dt);
    this.stumbleT += dt;

    // pose arrays are reused every frame (no per-frame allocations)
    const P = this._pose || (this._pose = { th: [0, 0], kn: [0, 0], ar: [0, 0], el: [0, 0] });
    let thighA = set(P.th, 0, 0), kneeA = set(P.kn, 0, 0), armA = set(P.ar, 0, 0), elbowA = set(P.el, 0, 0);
    let torsoX = 0.18, rootY = 0, rootRX = 0, headX = -0.1;
    if (state === 'menu' || state === 'countdown') {
      // idle bounce
      const t = performance.now() / 1000;
      set(thighA, 0.05, -0.05); set(kneeA, 0.1, 0.1); set(armA, 0.15, -0.15); set(elbowA, 0.4, 0.4);
      torsoX = 0.05 + Math.sin(t * 2) * 0.02; rootY = Math.sin(t * 4) * 0.01;
    } else if (b.rolling && !dying) {
      // tuck into a ball and spin
      this.rollSpin += dt * 14;
      set(thighA, 1.9, 1.9); set(kneeA, 2.4, 2.4); set(armA, 1.6, 1.6); set(elbowA, 1.8, 1.8);
      torsoX = 1.0; rootY = -0.45; rootRX = b.grounded ? this.rollSpin : 0.3;
      headX = 0.6;
    } else if (!b.grounded && !dying) {
      const up = clamp(b.vy / 10, -1, 1);
      set(thighA, 1.1 - up * 0.3, 0.4); set(kneeA, 1.6, 0.9); set(armA, -2.4 + up * 0.4, -2.0 + up * 0.4); set(elbowA, 0.6, 0.8);
      torsoX = 0.25; rootY = -0.05;
      this.rollSpin = 0;
    } else if (running) {
      const s = Math.sin(ph), c = Math.cos(ph);
      set(thighA, s * 0.95, -s * 0.95);
      set(kneeA, 0.35 + Math.max(0, -c) * 1.5, 0.35 + Math.max(0, c) * 1.5);
      set(armA, -s * 0.9, s * 0.9);
      set(elbowA, 1.3, 1.3);
      rootY = Math.abs(c) * 0.05 - 0.03;
      torsoX = 0.22 + Math.min(0.15, speed * 0.004);
      this.rollSpin = 0;
    }
    if (this.stumbleT < 0.45 && !dying) {
      const k = 1 - this.stumbleT / 0.45;
      armA[0] -= 2.2 * k; armA[1] -= 2.0 * k; torsoX -= 0.5 * k; headX -= 0.3 * k;
    }
    if (dying) {
      this.deathT += dt;
      const k = clamp(this.deathT / 0.5, 0, 1);
      rootRX = -1.45 * (k * k);
      rootY = -0.35 * k;
      set(thighA, 0.6, 0.2); set(kneeA, 0.4, 0.8); set(armA, -1.2, -0.6); set(elbowA, 0.3, 0.6); torsoX = -0.2;
    }
    K.root.position.y = rootY + (b.rolling && b.grounded ? 0 : 0);
    // root is turned 180° about Y, so its local X/Z axes point backwards
    K.root.rotation.x = -rootRX;
    K.root.rotation.z = -this.lean;
    K.torso.rotation.x = torsoX;
    K.head.rotation.x = headX;
    for (let i = 0; i < 2; i++) {
      const L = K.limbs[i === 0 ? -1 : 1];
      L.hp.rotation.x = -thighA[i];
      L.kn.rotation.x = kneeA[i];
      L.sh.rotation.x = armA[i];
      L.sh.rotation.z = (i === 0 ? -1 : 1) * 0.12;
      L.el.rotation.x = -elbowA[i];
    }
    if (b.rolling && b.grounded && !dying) {
      // spin around the body's middle rather than the feet
      K.root.position.y = 0.45 + rootY;
      K.hips.position.y = KID.hipY - 0.45 - 0.45;
    } else {
      K.hips.position.y = KID.hipY;
    }

    // ---------------- chasers
    if (!showChasers) return;
    const gap = run.chaseGap;
    const sW = b.s - gap - 1.8, sD = b.s - gap;
    game.trailAt(sW, _tmp);
    this.wardenG.position.set(_tmp.x - 0.35, _tmp.y, w.z(sW));
    game.trailAt(sD, _tmp);
    this.dog.root.position.set(_tmp.x + 0.45, _tmp.y, w.z(sD));
    const near = gap < 6;
    const caught = dying && run.deathKind === 'caught';

    const W = this.warden;
    const wf = clamp(1.0 + speed * 0.07, 1.2, 2.7);
    this.wPhase = (this.wPhase || 0) + dt * wf * Math.PI * 2 * (dying ? 0.4 : 1);
    const ws = Math.sin(this.wPhase), wc = Math.cos(this.wPhase);
    for (let i = 0; i < 2; i++) {
      const L = W.limbs[i === 0 ? -1 : 1];
      const sgn = i === 0 ? 1 : -1;
      L.hp.rotation.x = -ws * 0.8 * sgn;
      L.kn.rotation.x = 0.3 + Math.max(0, -wc * sgn) * 1.2;
      L.sh.rotation.x = ws * 0.7 * sgn - (i === 1 && near ? 1.2 : 0);
      L.el.rotation.x = -1.1;
    }
    W.torso.rotation.x = 0.2;
    W.root.position.y = Math.abs(wc) * 0.05;
    // shake a fist when close
    if (near || caught) { W.limbs[-1].sh.rotation.x = -2.6 + Math.sin(this.wPhase * 2) * 0.3; }

    const D = this.dog;
    this.dogPhase += dt * clamp(1.6 + speed * 0.1, 2, 4) * Math.PI * 2;
    const dp = this.dogPhase;
    D.legs.forEach((leg, i) => {
      const off = i === 0 || i === 3 ? 0 : Math.PI;
      leg.up.rotation.x = Math.sin(dp + off) * 0.7;
      leg.lo.rotation.x = -0.4 - Math.max(0, Math.cos(dp + off)) * 0.8;
    });
    D.body.position.y = 0.55 + Math.abs(Math.sin(dp)) * 0.04;
    D.head.rotation.y = Math.sin(dp * 0.5) * 0.15;
    D.tail.rotation.z = Math.sin(dp * 1.5) * 0.4;
  }
}
