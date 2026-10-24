// Procedural models, all built from primitives and merged so that each model
// is one geometry (one draw call per instanced pool). Parts are coloured with a
// vertex 'color' attribute, which multiplies the material colour/texture.
//
// Conventions: a model's "front" (the side the player meets first) faces +Z.
// Track models are centred on x = 0 (the lane centre) and stand on y = 0.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OBST, ROOF_Y } from './config.js';

// ------------------------------------------------------------------ helpers
const _c = new THREE.Color();

export function tint(geo, color) {
  _c.set(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = _c.r; arr[i * 3 + 1] = _c.g; arr[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// Remap a geometry's uv into a sub-rectangle of an atlas.
export function uvRect(geo, u0, v0, u1, v1) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  return geo;
}

// Scale uvs so a texture repeats every `metres` (for tiling materials).
export function uvScale(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geo;
}

export function box(w, h, d, x = 0, y = 0, z = 0, color = 0xffffff) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return tint(g, color);
}

// Box rotated about its own centre (Euler XYZ), then moved into place.
export function boxR(w, h, d, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return tint(g, color);
}

export function cyl(rt, rb, h, seg, x = 0, y = 0, z = 0, color = 0xffffff, axis = 'y') {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return tint(g, color);
}

export function merge(parts) {
  // mergeGeometries needs identical attribute sets: make sure each part has uv + color.
  for (const g of parts) {
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.color) tint(g, 0xffffff);
    if (!g.index) {
      const idx = [];
      for (let i = 0; i < g.attributes.position.count; i++) idx.push(i);
      g.setIndex(idx);
    }
  }
  const out = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  out.computeBoundingSphere();
  return out;
}

// ------------------------------------------------------------------ track
export const TRACK = {
  sleeperTop: 0.12,
  railTop: 0.26,
  gauge: 1.435,
  sleeperGap: 0.8,
  wallX: 5.4,
};

export function sleeperGeometry() {
  // Concrete sleeper with chamfered top: a box minus its hidden bottom is good enough.
  const g = box(2.5, 0.14, 0.26, 0, 0.05, 0, 0xffffff);
  return merge([g]);
}

export function railGeometry(len) {
  // One rail (head + web + foot) running `len` metres along Z.
  const head = box(0.075, 0.05, len, 0, 0.235, 0, 0xffffff);
  const web = box(0.025, 0.07, len, 0, 0.175, 0, 0xc8c8c8);
  const foot = box(0.13, 0.02, len, 0, 0.13, 0, 0xb0b0b0);
  return merge([head, web, foot]);
}

export function planeGeometry(w, len, repeatU, repeatV) {
  const g = new THREE.PlaneGeometry(w, len);
  g.rotateX(-Math.PI / 2);
  uvScale(g, repeatU, repeatV);
  return merge([tint(g, 0xffffff)]);
}

// Concrete wall panel along Z. The two long faces map to one horizontal strip of
// the graffiti atlas: u along the length, v in [v0, v1] up the height.
export function wallPanelGeometry(len, h, v0, v1) {
  const g = new THREE.BoxGeometry(0.35, h, len);
  g.translate(0, h / 2, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const face = Math.floor(i / 4); // BoxGeometry faces: +x, -x, +y, -y, +z, -z
    const u = uv.getX(i), v = uv.getY(i);
    if (face === 0 || face === 1) uv.setXY(i, u, v0 + v * (v1 - v0));
    else uv.setXY(i, 0.002 + u * 0.01, v0 + 0.01 + v * 0.02); // ends/top: a plain concrete corner
  }
  const cap = box(0.45, 0.12, len, 0, h + 0.06, 0, 0xb9b2a6);
  uvRect(cap, 0.0, v0 + 0.01, 0.01, v0 + 0.03);
  return merge([tint(g, 0xffffff), cap]);
}

export function fencePostGeometry(h) {
  return merge([
    cyl(0.04, 0.04, h, 6, 0, h / 2, 0, 0x8a8f94),
    cyl(0.06, 0.06, 0.06, 6, 0, h, 0, 0x6c7176),
  ]);
}

export function fencePanelGeometry(len, h) {
  const g = new THREE.PlaneGeometry(len, h);
  g.rotateY(Math.PI / 2);
  g.translate(0, h / 2 + 0.1, 0);
  uvScale(g, len / 0.45, h / 0.45); // chain-link diamonds ~22 cm
  const rail = box(0.05, 0.05, len, 0, h + 0.1, 0, 0x8a8f94);
  return merge([tint(g, 0xffffff), rail]);
}

// Catenary mast: an I-beam pole with an arm over the lanes (arm toward -X).
export function mastGeometry() {
  const H = 7.0;
  const parts = [
    box(0.26, H, 0.12, 0, H / 2, 0, 0x7d858c),
    box(0.06, H, 0.3, 0, H / 2, 0, 0x6b737a),
    box(0.5, 0.3, 0.5, 0, 0.15, 0, 0x8e8a82),
    box(4.6, 0.12, 0.12, -2.2, 6.3, 0, 0x7d858c),
    box(3.0, 0.08, 0.08, -1.4, 5.85, 0, 0x6b737a),
  ];
  // insulators / droppers above each lane
  for (const x of [-0.3, -2.5, -4.7]) parts.push(cyl(0.035, 0.035, 0.5, 5, x, 6.0, 0, 0x4a4f54));
  for (const x of [-0.3, -2.5, -4.7]) parts.push(cyl(0.07, 0.07, 0.12, 6, x, 6.18, 0, 0xbfb38f));
  return merge(parts);
}

export function wireGeometry(len) {
  return merge([box(0.025, 0.025, len, 0, 0, 0, 0x2a2c2e)]);
}

// Signal gantry spanning all lanes, with signal heads (lamps are a separate pool).
export function gantryGeometry() {
  const W = 11.6, H = 6.6;
  const col = 0x5d666e;
  const parts = [
    box(0.3, H, 0.3, -W / 2, H / 2, 0, col),
    box(0.3, H, 0.3, W / 2, H / 2, 0, col),
    box(W + 0.4, 0.35, 0.35, 0, H, 0, col),
    box(W + 0.4, 0.12, 0.12, 0, H - 0.5, 0.0, col),
    box(0.7, 0.2, 0.7, -W / 2, 0.1, 0, 0x8e8a82),
    box(0.7, 0.2, 0.7, W / 2, 0.1, 0, 0x8e8a82),
  ];
  for (let i = 0; i < 9; i++) {
    const x = -W / 2 + (i + 0.5) * (W / 9);
    parts.push(boxR(0.06, 0.6, 0.06, x, H - 0.25, 0, col, 0, 0, i % 2 ? 0.6 : -0.6));
  }
  for (const x of [-2.2, 0, 2.2]) {
    parts.push(box(0.42, 1.0, 0.28, x, H - 0.85, 0.12, 0x1d1f22));
    parts.push(box(0.5, 0.06, 0.34, x, H - 0.33, 0.12, 0x1d1f22));
  }
  return merge(parts);
}

export function signalLampGeometry() {
  // Two lamp discs per head (top lit / bottom lit chosen by colour per instance)
  const parts = [];
  for (const x of [-2.2, 0, 2.2]) parts.push(cyl(0.11, 0.11, 0.04, 10, x, 6.6 - 0.62, 0.28, 0xffffff, 'z'));
  return merge(parts);
}

// Trackside props, all standing at the origin.
export function cabinetGeometry() {
  return merge([
    box(0.9, 1.3, 0.6, 0, 0.65, 0, 0x9aa49a),
    box(0.95, 0.06, 0.65, 0, 1.33, 0, 0x7f877f),
    box(0.02, 0.9, 0.3, 0.46, 0.7, 0.12, 0x6d756d),
    box(0.3, 0.2, 0.02, 0, 1.0, 0.31, 0xffd23d),
  ]);
}

export function drumGeometry() {
  const g = cyl(0.55, 0.55, 0.5, 14, 0, 0.55, 0, 0x8a6a45, 'x');
  return merge([g, cyl(0.25, 0.25, 0.52, 10, 0, 0.55, 0, 0x5a4530, 'x')]);
}

export function barrelGeometry() {
  return merge([
    cyl(0.3, 0.3, 0.9, 12, 0, 0.45, 0, 0x2f6fb5),
    cyl(0.31, 0.31, 0.05, 12, 0, 0.3, 0, 0x234f80),
    cyl(0.31, 0.31, 0.05, 12, 0, 0.62, 0, 0x234f80),
  ]);
}

export function lampPostGeometry() {
  return merge([
    cyl(0.07, 0.09, 6, 8, 0, 3, 0, 0x50565c),
    box(1.2, 0.08, 0.08, -0.55, 5.9, 0, 0x50565c),
    box(0.5, 0.12, 0.25, -1.1, 5.82, 0, 0x3b3f44),
  ]);
}

export function shedGeometry() {
  return merge([
    box(3.2, 2.6, 2.4, 0, 1.3, 0, 0xc9b79a),
    box(3.5, 0.15, 2.7, 0, 2.68, 0, 0x6f5d4c),
    box(0.9, 1.9, 0.04, 0.6, 0.95, 1.22, 0x6b4f3a),
    box(0.8, 0.5, 0.04, -0.8, 1.6, 1.22, 0x2a3642),
  ]);
}

// A freight wagon parked on the outer sidings (low detail: it's scenery).
export function wagonGeometry() {
  const body = box(2.6, 2.4, 13, 0, 1.9, 0, 0xffffff);
  uvScale(body, 6, 1);
  return merge([
    body,
    box(2.0, 0.5, 11, 0, 0.45, 0, 0x2b2b2b),
    box(2.7, 0.08, 13.2, 0, 3.12, 0, 0xd8d8d8),
  ]);
}

// ------------------------------------------------------------------ obstacles
// Low hurdle: striped board on two legs. 0.6 m tall, fits the 0.4 m collision depth.
export function hurdleGeometry() {
  const parts = [];
  const n = 8, W = 1.9;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + (i + 0.5) * (W / n);
    const col = i % 2 ? 0xffffff : 0xe8242f;
    parts.push(box(W / n, 0.24, 0.08, x, 0.47, 0, col));
    parts.push(box(W / n, 0.1, 0.07, x, 0.17, 0, i % 2 ? 0xe8242f : 0xffffff));
  }
  for (const sx of [-1, 1]) {
    parts.push(box(0.08, 0.6, 0.08, sx * 0.9, 0.3, 0, 0x9b9fa3));
    parts.push(box(0.1, 0.05, 0.42, sx * 0.9, 0.025, 0, 0x5b5f63));
  }
  parts.push(box(0.14, 0.08, 0.1, -0.9, 0.62, 0, 0xffb020));
  parts.push(box(0.14, 0.08, 0.1, 0.9, 0.62, 0, 0xffb020));
  return merge(parts);
}

// Overhead barrier: posts at the lane edges and a striped board whose bottom edge is at 1.1 m.
export function barrierGeometry() {
  const parts = [];
  const y0 = OBST.barrier.y0, y1 = 2.45, W = 1.96;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const x = -W / 2 + (i + 0.5) * (W / n);
    parts.push(box(W / n, 0.42, 0.12, x, y0 + 0.21, 0, i % 2 ? 0x16181b : 0xffc21a));
  }
  parts.push(box(W, 0.9, 0.1, 0, y0 + 0.42 + 0.45, -0.01, 0x2f7de0));
  parts.push(box(W, 0.06, 0.14, 0, y1, 0, 0xd9dde0));
  for (const sx of [-1, 1]) {
    parts.push(box(0.1, 2.6, 0.1, sx * 1.03, 1.3, 0, 0xc4c8cc));
    parts.push(box(0.3, 0.06, 0.4, sx * 1.03, 0.03, 0, 0x5b5f63));
  }
  return merge(parts);
}

// Tall barrier: a heavy blast wall, full height.
export function wallGeometry() {
  const parts = [];
  const H = OBST.wall.h;
  parts.push(box(1.96, H - 0.4, 0.46, 0, (H - 0.4) / 2 + 0.2, 0, 0xc9c2b4));
  parts.push(box(2.0, 0.2, 0.5, 0, 0.1, 0, 0x8d877c));
  parts.push(box(2.0, 0.2, 0.5, 0, H - 0.1, 0, 0x8d877c));
  // chevrons on the face
  for (let i = 0; i < 5; i++) {
    parts.push(boxR(0.22, 1.5, 0.02, -0.72 + i * 0.36, 1.7, 0.24, i % 2 ? 0x15171a : 0xffc21a, 0, 0, 0.5));
  }
  parts.push(box(1.96, 0.25, 0.03, 0, 0.55, 0.245, 0xe8242f));
  parts.push(box(1.96, 0.25, 0.03, 0, H - 0.55, 0.245, 0xe8242f));
  return merge(parts);
}

export function wallLampGeometry() {
  return merge([box(0.3, 0.12, 0.12, -0.7, OBST.wall.h + 0.06, 0.1), box(0.3, 0.12, 0.12, 0.7, OBST.wall.h + 0.06, 0.1)]);
}

// Ramp: steel plank ramp from the ground (front, +Z) up to roof height over 8 m.
export function rampGeometry() {
  const L = OBST.ramp.len, H = ROOF_Y, W = 1.9;
  const parts = [];
  // sloped deck made of planks
  const nPl = 12;
  const ang = Math.atan2(H, L);
  const hyp = Math.hypot(H, L);
  for (let i = 0; i < nPl; i++) {
    const t = (i + 0.5) / nPl;
    const g = box(W, 0.08, hyp / nPl - 0.04, 0, 0, 0, i % 2 ? 0xffc21a : 0xf2b100);
    g.rotateX(ang);
    g.translate(0, H * t, L / 2 - L * t);
    parts.push(g);
  }
  // side stringers
  for (const sx of [-1, 1]) {
    const g = box(0.1, 0.3, hyp, 0, 0, 0, 0x30343a);
    g.rotateX(ang);
    g.translate(sx * (W / 2 + 0.03), H / 2 - 0.1, 0);
    parts.push(g);
  }
  // supports
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const h = H * t;
    for (const sx of [-1, 1]) parts.push(box(0.1, h, 0.1, sx * 0.85, h / 2, L / 2 - L * t, 0x4b5057));
    parts.push(box(1.8, 0.08, 0.08, 0, h * 0.5, L / 2 - L * t, 0x4b5057));
  }
  // side panels (solid triangles so the ramp reads as a block from the side)
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 - 0.02);
    const A = [x, 0, L / 2], B = [x, 0, -L / 2], C = [x, H - 0.12, -L / 2];
    parts.push(tint(triangle(sx > 0 ? [A, B, C] : [A, C, B], [sx, 0, 0]), 0x5a6068));
  }
  return merge(parts);
}

// A single flat triangle with a given normal (winding must match it).
export function triangle(pts, n) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([...n, ...n, ...n], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1], 2));
  g.setIndex([0, 1, 2]);
  return g;
}

// ------------------------------------------------------------------ trains
export const TRAIN = {
  len: OBST.train.car,
  bodyBottom: 0.62,
  w: OBST.train.halfW * 2,
  h: OBST.train.h,
  corner: 0.36,
  // atlas layout (v): end faces in [0, 0.25], body wrap in [0.25, 1]
  vBody0: 0.25,
};

function trainProfile() {
  const { w, h, bodyBottom: b, corner: r } = TRAIN;
  const hw = w / 2;
  const pts = []; // [x, y, nx, ny]
  pts.push([-hw, b, -1, 0]);
  pts.push([-hw, h - r, -1, 0]);
  const seg = 5;
  for (let i = 1; i <= seg; i++) {
    const a = Math.PI - (i / seg) * (Math.PI / 2);
    pts.push([-hw + r + r * Math.cos(a), h - r + r * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 - (i / seg) * (Math.PI / 2);
    if (i === 0) { pts.push([hw - r, h, 0, 1]); continue; }
    pts.push([hw - r + r * Math.cos(a), h - r + r * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  pts.push([hw, b, 1, 0]);
  return pts;
}

// Car body: a rounded profile extruded along Z, plus flat end faces.
// uv: body wrap u = along the car (0 = front), v = around the profile in [0.25, 1];
// end faces in the bottom strip of the atlas.
export function trainBodyGeometry() {
  const L = TRAIN.len;
  const prof = trainProfile();
  // arc length around profile
  const acc = [0];
  for (let i = 1; i < prof.length; i++) acc.push(acc[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  const total = acc[acc.length - 1];
  TRAIN.profileLen = total;
  TRAIN.profileAcc = acc.map((a) => a / total);

  const pos = [], nor = [], uv = [], idx = [];
  const nz = 1; // one segment along the length is enough: detail is in the textures
  for (let j = 0; j <= nz; j++) {
    const z = L / 2 - (j / nz) * L;
    for (let i = 0; i < prof.length; i++) {
      const [x, y, nx, ny] = prof[i];
      pos.push(x, y, z); nor.push(nx, ny, 0);
      uv.push(j / nz, TRAIN.vBody0 + (acc[i] / total) * (1 - TRAIN.vBody0));
    }
  }
  const row = prof.length;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < row - 1; i++) {
      const a = j * row + i, b2 = a + 1, c = a + row, d = c + 1;
      idx.push(a, b2, c, b2, d, c);
    }
  }
  const body = new THREE.BufferGeometry();
  body.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  body.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  body.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  body.setIndex(idx);

  const caps = [];
  for (const front of [true, false]) {
    const shape = new THREE.Shape();
    prof.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
    shape.lineTo(prof[0][0], prof[0][1]);
    const g = new THREE.ShapeGeometry(shape);
    const u = g.attributes.uv, p = g.attributes.position;
    for (let i = 0; i < u.count; i++) {
      const x = p.getX(i), y = p.getY(i);
      const uu = (x / TRAIN.w + 0.5) * 0.25 + (front ? 0 : 0.25);
      const vv = ((y - TRAIN.bodyBottom) / (TRAIN.h - TRAIN.bodyBottom)) * 0.25;
      u.setXY(i, uu, vv);
    }
    if (!front) g.rotateY(Math.PI);
    g.translate(0, 0, front ? L / 2 : -L / 2);
    caps.push(g);
  }
  // a little bumper/cowcatcher at both ends under the body
  const bumpers = [box(1.9, 0.3, 0.2, 0, 0.55, L / 2 + 0.02, 0x3a3d42), box(1.9, 0.3, 0.2, 0, 0.55, -L / 2 - 0.02, 0x3a3d42)];
  for (const g of bumpers) uvRect(g, 0.9, 0.02, 0.92, 0.04);
  return merge([tint(body, 0xffffff), tint(caps[0], 0xffffff), tint(caps[1], 0xffffff), ...bumpers]);
}

export function trainUnderGeometry() {
  const L = TRAIN.len;
  const parts = [];
  const dark = 0x2b2d31, mid = 0x44474d;
  for (const bz of [-L / 2 + 2.2, L / 2 - 2.2]) {
    parts.push(box(1.7, 0.22, 2.6, 0, 0.5, bz, mid));
    for (const wx of [-0.72, 0.72]) {
      for (const wz of [-0.85, 0.85]) {
        parts.push(cyl(0.4, 0.4, 0.1, 12, wx, 0.4, bz + wz, 0x55585e, 'x'));
        parts.push(cyl(0.16, 0.16, 0.14, 8, wx * 1.08, 0.4, bz + wz, 0x8a8d92, 'x'));
      }
    }
  }
  parts.push(box(1.6, 0.34, L - 6.4, 0, 0.62, 0, dark));
  parts.push(box(0.3, 0.2, 0.4, 0, 0.62, L / 2 + 0.2, 0x8a8d92));
  parts.push(box(0.3, 0.2, 0.4, 0, 0.62, -L / 2 - 0.2, 0x8a8d92));
  return merge(parts);
}

export function headlightGeometry() {
  const L = TRAIN.len;
  return merge([
    cyl(0.13, 0.13, 0.05, 12, -0.62, 1.0, L / 2 + 0.03, 0xffffff, 'z'),
    cyl(0.13, 0.13, 0.05, 12, 0.62, 1.0, L / 2 + 0.03, 0xffffff, 'z'),
    box(0.5, 0.08, 0.05, 0, 2.95, L / 2 + 0.01, 0xffffff),
  ]);
}

// ------------------------------------------------------------------ pickups
export function coinGeometry() {
  const g = new THREE.CylinderGeometry(0.3, 0.3, 0.07, 22, 1);
  g.rotateX(Math.PI / 2);
  // flat-ish uv on the faces for the embossed star normal map
  const p = g.attributes.position, u = g.attributes.uv;
  for (let i = 0; i < u.count; i++) u.setXY(i, p.getX(i) / 0.6 + 0.5, p.getY(i) / 0.6 + 0.5);
  return merge([tint(g, 0xffffff)]);
}

export function powerupGeometry(kind) {
  const parts = [];
  const ringCol = { magnet: 0xff3b5c, double: 0x39d7ff, sneakers: 0x7cff4f, shield: 0xffc23d }[kind];
  const ring = new THREE.TorusGeometry(0.56, 0.035, 6, 32);
  parts.push(tint(ring, ringCol));
  switch (kind) {
    case 'magnet': {
      const t = new THREE.TorusGeometry(0.28, 0.1, 8, 16, Math.PI);
      t.rotateZ(Math.PI);
      parts.push(tint(t, 0xff3b5c));
      parts.push(box(0.2, 0.22, 0.2, -0.28, 0.1, 0, 0xff3b5c));
      parts.push(box(0.2, 0.22, 0.2, 0.28, 0.1, 0, 0xff3b5c));
      parts.push(box(0.21, 0.12, 0.21, -0.28, 0.27, 0, 0xf2f2f2));
      parts.push(box(0.21, 0.12, 0.21, 0.28, 0.27, 0, 0xf2f2f2));
      break;
    }
    case 'double': {
      const ring = new THREE.TorusGeometry(0.36, 0.06, 8, 24);
      parts.push(tint(ring, 0x39d7ff));
      // "2x" built from bars (no text): a 2 and an x
      parts.push(box(0.22, 0.05, 0.06, -0.1, 0.16, 0, 0xffffff));
      parts.push(box(0.05, 0.12, 0.06, 0.0, 0.09, 0, 0xffffff));
      parts.push(box(0.22, 0.05, 0.06, -0.1, 0.02, 0, 0xffffff));
      parts.push(box(0.05, 0.12, 0.06, -0.2, -0.06, 0, 0xffffff));
      parts.push(box(0.22, 0.05, 0.06, -0.1, -0.14, 0, 0xffffff));
      parts.push(boxR(0.05, 0.22, 0.06, 0.17, -0.04, 0, 0xffffff, 0, 0, 0.7));
      parts.push(boxR(0.05, 0.22, 0.06, 0.17, -0.04, 0, 0xffffff, 0, 0, -0.7));
      break;
    }
    case 'sneakers': {
      parts.push(box(0.5, 0.16, 0.22, 0, -0.08, 0, 0x7cff4f));
      parts.push(box(0.26, 0.18, 0.22, -0.12, 0.08, 0, 0x7cff4f));
      parts.push(box(0.54, 0.06, 0.24, 0.02, -0.17, 0, 0xffffff));
      parts.push(boxR(0.18, 0.05, 0.02, -0.25, 0.05, 0.12, 0xffffff, 0, 0, 0.5));
      parts.push(boxR(0.18, 0.05, 0.02, -0.25, -0.02, 0.12, 0xffffff, 0, 0, 0.5));
      break;
    }
    case 'shield': {
      parts.push(box(0.8, 0.07, 0.26, 0, 0, 0, 0xffc23d));
      parts.push(box(0.6, 0.075, 0.18, 0, 0.002, 0, 0xff6a2a));
      for (const x of [-0.26, 0.26]) for (const z of [-0.09, 0.09]) parts.push(cyl(0.05, 0.05, 0.04, 8, x, -0.06, z, 0x222222, 'z'));
      const ringG = parts.shift();
      const g = merge(parts);
      g.rotateX(-0.9);
      return merge([g, ringG]);
    }
  }
  return merge(parts);
}

// A soft round shadow blob under pickups / chasers (cheap, no shadow map needed).
export function blobGeometry(r = 0.5) {
  const g = new THREE.CircleGeometry(r, 16);
  g.rotateX(-Math.PI / 2);
  return merge([tint(g, 0xffffff)]);
}
