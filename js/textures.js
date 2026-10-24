// Procedural textures: canvas + noise/fbm, turned into colour, normal and ORM
// (R = ambient occlusion, G = roughness, B = metalness) maps. No image files.
// Everything tiles (periodic noise) and is at most 1024 px, with mipmaps.
import * as THREE from 'three';
import { makeRng, PLATFORM } from './config.js';

// ------------------------------------------------------------------ canvas helpers
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
const ctx2d = (c) => c.getContext('2d', { willReadFrequently: true });

let ANISO = 8;
export function setAnisotropy(maxAniso) {
  ANISO = Math.min(maxAniso, PLATFORM.mobile ? 8 : 16);
}

function tex(c, { color = false, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = ANISO;
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ noise
function hash(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Periodic value-noise fbm over a w x h field. `cells` = lattice cells across the
// first octave (the texture tiles because every octave wraps).
export function fbm(w, h, cells, octaves, seed, gain = 0.5) {
  const out = new Float32Array(w * h);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const cx = cells << o, cy = Math.max(1, Math.round((cells * h) / w)) << o;
    const lat = new Float32Array(cx * cy);
    for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) lat[i + j * cx] = hash(i, j, seed + o * 101);
    const sx = cx / w, sy = cy / h;
    for (let y = 0; y < h; y++) {
      const fy = y * sy;
      const j0 = Math.floor(fy);
      let ty = fy - j0; ty = ty * ty * (3 - 2 * ty);
      const r0 = (j0 % cy) * cx, r1 = ((j0 + 1) % cy) * cx;
      for (let x = 0; x < w; x++) {
        const fx = x * sx;
        const i0 = Math.floor(fx);
        let tx = fx - i0; tx = tx * tx * (3 - 2 * tx);
        const a = i0 % cx, b = (i0 + 1) % cx;
        const top = lat[r0 + a] + (lat[r0 + b] - lat[r0 + a]) * tx;
        const bot = lat[r1 + a] + (lat[r1 + b] - lat[r1 + a]) * tx;
        out[x + y * w] += (top + (bot - top) * ty) * amp;
      }
    }
    total += amp;
    amp *= gain;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// Periodic Worley (cellular) noise: F1, F2 distances (in cell units) and the cell id.
function worley(w, h, cells, seed, jitter = 0.85) {
  const cy = Math.max(1, Math.round((cells * h) / w));
  const px = new Float32Array(cells * cy), py = new Float32Array(cells * cy);
  for (let j = 0; j < cy; j++) for (let i = 0; i < cells; i++) {
    px[i + j * cells] = i + 0.5 + (hash(i, j, seed) - 0.5) * jitter;
    py[i + j * cells] = j + 0.5 + (hash(i, j, seed + 7) - 0.5) * jitter;
  }
  const F1 = new Float32Array(w * h), F2 = new Float32Array(w * h), id = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y / h) * cy;
    const cj = Math.floor(fy);
    for (let x = 0; x < w; x++) {
      const fx = (x / w) * cells;
      const ci = Math.floor(fx);
      let d1 = 9, d2 = 9, best = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = ci + di, jj = cj + dj;
        const wi = ((ii % cells) + cells) % cells, wj = ((jj % cy) + cy) % cy;
        const k = wi + wj * cells;
        const dx = px[k] + (ii - wi) - fx, dy = py[k] + (jj - wj) - fy;
        const d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; best = k; } else if (d < d2) d2 = d;
      }
      const o = x + y * w;
      F1[o] = Math.sqrt(d1); F2[o] = Math.sqrt(d2); id[o] = best;
    }
  }
  return { F1, F2, id };
}

// Height field -> tangent-space normal map canvas (wraps at the edges).
function normalFromHeight(hf, w, h, strength) {
  const c = canvas(w, h);
  const g = ctx2d(c);
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w, yp = ((y + 1) % h) * w, yc = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w, xp = (x + 1) % w;
      const dx = (hf[yc + xp] - hf[yc + xm]) * strength;
      const dy = (hf[yp + x] - hf[ym + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (yc + x) * 4;
      d[o] = (-dx * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (dy * inv * 0.5 + 0.5) * 255; // canvas y runs down, texture v runs up
      d[o + 2] = (inv * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Read a canvas back as a height field (luminance 0..1).
function heightFromCanvas(c) {
  const { width: w, height: h } = c;
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  const hf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) hf[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
  return hf;
}

function imageFrom(w, h, fn) {
  const c = canvas(w, h);
  const g = ctx2d(c);
  const img = g.createImageData(w, h);
  const d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (x + y * w) * 4;
    fn(x, y, x + y * w, d, o);
    d[o + 3] = d[o + 3] || 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;

// ------------------------------------------------------------------ materials' textures
function ballast(S) {
  const w = S, h = S;
  const { F1, F2, id } = worley(w, h, 44, 11);
  const n = fbm(w, h, 8, 4, 3);
  const fine = fbm(w, h, 64, 2, 5);
  const hf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const edge = clamp01((F2[i] - F1[i]) * 3.2);
    hf[i] = Math.sqrt(edge) * 0.8 + fine[i] * 0.2;
  }
  const map = imageFrom(w, h, (x, y, i, d, o) => {
    const r = hash(id[i], 1, 9), r2 = hash(id[i], 2, 9);
    const edge = clamp01((F2[i] - F1[i]) * 3.2);
    let base = mix(0.38, 0.66, r) * (0.75 + 0.25 * fine[i]);
    const warm = r2 * 0.12 + n[i] * 0.1;           // brown/rusty stones here and there
    const crev = mix(0.35, 1, Math.sqrt(edge));
    d[o] = clamp01((base + warm * 0.9) * crev) * 255;
    d[o + 1] = clamp01((base + warm * 0.45) * crev) * 255;
    d[o + 2] = clamp01((base - warm * 0.1) * crev * 0.95) * 255;
  });
  const orm = imageFrom(w, h, (x, y, i, d, o) => {
    const edge = clamp01((F2[i] - F1[i]) * 3.2);
    d[o] = mix(0.45, 1, Math.sqrt(edge)) * 255;   // AO in the gaps
    d[o + 1] = mix(0.97, 0.78, fine[i]) * 255;     // rough stone
    d[o + 2] = 0;
  });
  return { map: tex(map, { color: true }), normalMap: tex(normalFromHeight(hf, w, h, 5)), orm: tex(orm) };
}

function ground(S) {
  const w = S, h = S;
  const n = fbm(w, h, 4, 5, 21);
  const m = fbm(w, h, 16, 3, 22);
  const { F1, F2, id } = worley(w, h, 48, 23, 0.95);
  const hf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) hf[i] = m[i] * 0.4 + clamp01((F2[i] - F1[i]) * 4) * 0.35 * (n[i] > 0.45 ? 1 : 0.3);
  const map = imageFrom(w, h, (x, y, i, d, o) => {
    const grav = clamp01((n[i] - 0.4) * 4);
    const pebble = hash(id[i], 3, 1);
    const dirt = [0.46, 0.39, 0.31], gray = [0.52 + pebble * 0.18, 0.5 + pebble * 0.16, 0.47 + pebble * 0.14];
    const weeds = clamp01((m[i] - 0.66) * 6) * (1 - grav);
    for (let k = 0; k < 3; k++) {
      let v = mix(dirt[k], gray[k], grav) * (0.8 + 0.3 * m[i]);
      v = mix(v, [0.36, 0.42, 0.2][k], weeds * 0.8);
      d[o + k] = clamp01(v) * 255;
    }
  });
  const orm = imageFrom(w, h, (x, y, i, d, o) => { d[o] = (0.75 + hf[i] * 0.25) * 255; d[o + 1] = 0.95 * 255; d[o + 2] = 0; });
  return { map: tex(map, { color: true }), normalMap: tex(normalFromHeight(hf, w, h, 3)), orm: tex(orm) };
}

function concrete(S, seed = 31, tone = [0.72, 0.7, 0.66], seams = 0) {
  const w = S, h = S;
  const n = fbm(w, h, 4, 5, seed);
  const f = fbm(w, h, 32, 3, seed + 1);
  const hf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) hf[i] = f[i] * 0.6 + n[i] * 0.4;
  const map = imageFrom(w, h, (x, y, i, d, o) => {
    const stain = clamp01((n[i] - 0.55) * 3) * 0.25;
    const pit = f[i] < 0.22 ? 0.12 : 0;
    for (let k = 0; k < 3; k++) d[o + k] = clamp01(tone[k] * (0.86 + 0.22 * f[i]) - stain - pit) * 255;
  });
  if (seams) {
    const g = ctx2d(map);
    g.fillStyle = 'rgba(40,36,32,0.55)';
    for (let k = 0; k < seams; k++) g.fillRect(Math.round((k * w) / seams), 0, 2, h);
  }
  const orm = imageFrom(w, h, (x, y, i, d, o) => { d[o] = (0.8 + 0.2 * f[i]) * 255; d[o + 1] = (0.86 + 0.1 * n[i]) * 255; d[o + 2] = 0; });
  return { map: tex(map, { color: true }), normalMap: tex(normalFromHeight(hf, w, h, 2.2)), orm: tex(orm) };
}

// ------------------------------------------------------------------ graffiti
const PALETTES = [
  ['#ff3b7f', '#ffd23d', '#2fe0c8', '#7a4dff'],
  ['#ff7a1a', '#39a0ff', '#fff3d6', '#1fc46b'],
  ['#c6ff3d', '#ff4fd8', '#3dd3ff', '#ffb02e'],
  ['#ff5a36', '#ffe066', '#5b8cff', '#22e0a0'],
];
const OUTLINE = '#1a1526';

function blobShape(g, rng, x, y, r, fill, fill2) {
  const n = rng.int(4, 7);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    pts.push([x + Math.cos(a) * r * rng.range(0.45, 0.9) * 1.6, y + Math.sin(a) * r * rng.range(0.4, 0.8), r * rng.range(0.45, 0.75)]);
  }
  const draw = (pad) => { g.beginPath(); for (const [px, py, pr] of pts) { g.moveTo(px + pr + pad, py); g.arc(px, py, pr + pad, 0, Math.PI * 2); } };
  g.fillStyle = OUTLINE; draw(r * 0.16); g.fill();
  g.fillStyle = '#fff'; draw(r * 0.08); g.fill();
  const grd = g.createLinearGradient(x, y - r, x, y + r);
  grd.addColorStop(0, fill); grd.addColorStop(1, fill2);
  g.fillStyle = grd; draw(0); g.fill();
  // highlights
  g.fillStyle = 'rgba(255,255,255,0.75)';
  for (const [px, py, pr] of pts) { g.beginPath(); g.ellipse(px - pr * 0.35, py - pr * 0.45, pr * 0.22, pr * 0.1, -0.5, 0, Math.PI * 2); g.fill(); }
  // drips
  g.fillStyle = fill2;
  for (let k = 0; k < rng.int(2, 5); k++) {
    const p = rng.pick(pts);
    const dx = p[0] + rng.range(-p[2], p[2]) * 0.6, len = rng.range(10, 40);
    g.fillRect(dx, p[1] + p[2] * 0.6, 3, len);
    g.beginPath(); g.arc(dx + 1.5, p[1] + p[2] * 0.6 + len, 3, 0, Math.PI * 2); g.fill();
  }
}

function swoosh(g, rng, x, y, len, col) {
  const pts = [[x, y]];
  for (let i = 1; i <= 3; i++) pts.push([x + (len * i) / 3, y + rng.range(-40, 40)]);
  const path = () => { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); g.bezierCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1]); };
  g.lineCap = 'round';
  g.strokeStyle = OUTLINE; g.lineWidth = 26; path(); g.stroke();
  g.strokeStyle = col; g.lineWidth = 16; path(); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 4; path(); g.stroke();
  // arrowhead
  const [ex, ey] = pts[3];
  const ang = Math.atan2(pts[3][1] - pts[2][1], pts[3][0] - pts[2][0]);
  g.beginPath();
  g.moveTo(ex + Math.cos(ang) * 30, ey + Math.sin(ang) * 30);
  g.lineTo(ex + Math.cos(ang + 2.4) * 26, ey + Math.sin(ang + 2.4) * 26);
  g.lineTo(ex + Math.cos(ang - 2.4) * 26, ey + Math.sin(ang - 2.4) * 26);
  g.closePath();
  g.fillStyle = col; g.fill(); g.lineWidth = 5; g.strokeStyle = OUTLINE; g.stroke();
}

function burst(g, rng, x, y, r, col) {
  const n = rng.int(6, 10);
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2;
    const rr = i % 2 ? r * 0.45 : r;
    i ? g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fillStyle = col; g.fill();
  g.lineWidth = 5; g.strokeStyle = OUTLINE; g.stroke();
}

function shards(g, rng, x, y, r, cols) {
  // angular interlocking shapes (abstract, not letters)
  for (let k = 0; k < rng.int(3, 5); k++) {
    const cx = x + rng.range(-r, r), cy = y + rng.range(-r * 0.4, r * 0.4);
    g.beginPath();
    const n = rng.int(3, 5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const rr = r * rng.range(0.25, 0.6);
      i ? g.lineTo(cx + Math.cos(a) * rr * 1.5, cy + Math.sin(a) * rr) : g.moveTo(cx + Math.cos(a) * rr * 1.5, cy + Math.sin(a) * rr);
    }
    g.closePath();
    g.fillStyle = rng.pick(cols); g.fill();
    g.lineWidth = 6; g.strokeStyle = OUTLINE; g.stroke();
  }
}

function splatter(g, rng, x, y, r, col) {
  g.fillStyle = col;
  for (let i = 0; i < 40; i++) {
    const a = rng.range(0, Math.PI * 2), d = Math.pow(rng(), 2) * r;
    g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rng.range(1, 5), 0, Math.PI * 2); g.fill();
  }
}

function graffitiPiece(g, rng, x, y, scale, pal) {
  const kind = rng.int(0, 4);
  if (kind === 0) {
    for (let k = 0; k < 3; k++) blobShape(g, rng, x + (k - 1) * 70 * scale, y + rng.range(-10, 10), 46 * scale, pal[k], pal[(k + 1) % pal.length]);
  } else if (kind === 1) {
    swoosh(g, rng, x - 120 * scale, y, 240 * scale, pal[0]);
    burst(g, rng, x + 30 * scale, y - 10, 38 * scale, pal[1]);
  } else if (kind === 2) {
    shards(g, rng, x, y, 90 * scale, pal);
    splatter(g, rng, x + 60, y + 20, 60, pal[3]);
  } else if (kind === 3) {
    blobShape(g, rng, x, y, 60 * scale, pal[2], pal[0]);
    swoosh(g, rng, x - 140 * scale, y + 40, 280 * scale, pal[1]);
  } else {
    burst(g, rng, x - 50, y, 50 * scale, pal[0]);
    burst(g, rng, x + 40, y + 10, 34 * scale, pal[2]);
    splatter(g, rng, x, y, 90, pal[1]);
  }
}

// Atlas: four 10 m x 2.6 m wall strips stacked vertically (1024 x 256 each).
function graffitiWalls(W) {
  const w = W, sh = W / 4, h = W;
  const base = concrete(256, 41, [0.7, 0.68, 0.64]);
  const c = canvas(w, h);
  const g = ctx2d(c);
  const n = fbm(w / 4, h / 4, 8, 4, 43);
  // concrete base (tile a noisy grey and add panel seams every 2.5 m)
  const bimg = base.map.image;
  for (let y = 0; y < h; y += 256) for (let x = 0; x < w; x += 256) g.drawImage(bimg, x, y);
  const hcan = canvas(w, h);
  const hg = ctx2d(hcan);
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, w, h);
  for (let s = 0; s < 4; s++) {
    const y0 = s * sh;
    const rng = makeRng(1000 + s * 77);
    const pal = PALETTES[s];
    // grime at the bottom and top
    let grd = g.createLinearGradient(0, y0 + sh, 0, y0 + sh * 0.55);
    grd.addColorStop(0, 'rgba(60,45,30,0.55)'); grd.addColorStop(1, 'rgba(60,45,30,0)');
    g.fillStyle = grd; g.fillRect(0, y0, w, sh);
    // seams
    for (let k = 1; k < 4; k++) {
      const x = Math.round((k * w) / 4);
      g.fillStyle = 'rgba(30,26,22,0.6)'; g.fillRect(x - 1, y0, 3, sh);
      hg.fillStyle = '#404040'; hg.fillRect(x - 2, y0, 4, sh);
    }
    hg.fillStyle = '#5a5a5a'; hg.fillRect(0, y0 + 8, w, 3); // top lip
    // graffiti pieces (skip the first 16 px: the wall ends sample there)
    const pieces = rng.int(3, 5);
    for (let k = 0; k < pieces; k++) {
      const x = 90 + ((k + rng.range(0.1, 0.6)) * (w - 160)) / pieces;
      const y = y0 + sh * rng.range(0.42, 0.62);
      g.save();
      g.beginPath(); g.rect(16, y0 + 14, w - 16, sh - 20); g.clip();
      graffitiPiece(g, rng, x, y, rng.range(0.85, 1.2), pal);
      g.restore();
    }
    // weathering: fade the paint where the noise says so
    g.globalCompositeOperation = 'source-atop';
    for (let y = 0; y < sh / 4; y++) for (let x = 0; x < w / 4; x++) {
      const v = n[x + (y + (s * sh) / 4) * (w / 4)];
      if (v < 0.42) { g.fillStyle = `rgba(160,152,140,${((0.42 - v) * 1.6).toFixed(2)})`; g.fillRect(x * 4, y0 + y * 4, 4, 4); }
    }
    g.globalCompositeOperation = 'source-over';
  }
  const hf = heightFromCanvas(hcan);
  const fineN = fbm(w, h, 64, 2, 47);
  for (let i = 0; i < hf.length; i++) hf[i] += fineN[i] * 0.08;
  const orm = imageFrom(w, h, (x, y, i, d, o) => { d[o] = 240; d[o + 1] = 215 + fineN[i] * 30; d[o + 2] = 0; });
  return { map: tex(c, { color: true }), normalMap: tex(normalFromHeight(hf, w, h, 2.5)), orm: tex(orm) };
}

// ------------------------------------------------------------------ fence
function fence() {
  const S = 128;
  const c = canvas(S, S);
  const g = ctx2d(c);
  g.clearRect(0, 0, S, S);
  g.strokeStyle = 'rgba(205,210,214,1)';
  g.lineWidth = 9;
  // diamond chain-link (tiles every 1 m: two diamonds per tile)
  for (let k = -2; k <= 2; k++) {
    g.beginPath(); g.moveTo(k * S / 2, 0); g.lineTo(k * S / 2 + S, S); g.stroke();
    g.beginPath(); g.moveTo(k * S / 2 + S, 0); g.lineTo(k * S / 2, S); g.stroke();
  }
  return { map: tex(c, { color: true }) };
}

// ------------------------------------------------------------------ train liveries
// Atlas 1024 x 512: rows 0..384 = the body wrap (left side, roof, right side),
// rows 384..512 = end faces (front 0..256, back 256..512 across).
const LIVERY_STYLES = [
  { body: '#2f7de0', band: '#ffd23d', band2: '#1b2a4a', roof: '#c9ced4', graffiti: true },
  { body: '#e8442f', band: '#f4f1ea', band2: '#7a1c14', roof: '#bfc4ca', graffiti: false },
  { body: '#e9e3d6', band: '#1fc46b', band2: '#2f3a44', roof: '#c4c8cc', graffiti: true },
  { body: '#f2b100', band: '#2b2f36', band2: '#8a5a00', roof: '#c9ced4', graffiti: false },
];

function livery(index, profileAcc) {
  const W = 1024, H = 512, BODY = 384;
  const st = LIVERY_STYLES[index];
  const rng = makeRng(500 + index * 31);
  const c = canvas(W, H);
  const g = ctx2d(c);
  const hc = canvas(W, H);
  const hg = ctx2d(hc);
  const oc = canvas(W, H);
  const og = ctx2d(oc);
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, W, H);
  // ORM default: painted metal
  og.fillStyle = 'rgb(255,95,140)'; og.fillRect(0, 0, W, H);

  // profile fractions: [0, a] left side, [a, b] roof (incl. corners), [b, 1] right side
  const nP = profileAcc.length;
  const fSideTop = profileAcc[1];              // top of the left side
  const fRoofEnd = profileAcc[nP - 2];         // top of the right side
  const yOf = (f) => BODY * (1 - f);            // canvas y for a profile fraction
  const sideH = Math.round(yOf(0) - yOf(fSideTop)); // pixels for one side

  // Draw one side (up = up) into an offscreen canvas, then place it twice.
  const side = canvas(W, sideH), sg = ctx2d(side);
  const sideHt = canvas(W, sideH), sh = ctx2d(sideHt);
  const sideO = canvas(W, sideH), so = ctx2d(sideO);
  const bodyH = 2.22; // metres of side
  const py = (m) => sideH * (1 - m / bodyH);  // metres above the side's bottom edge -> px
  const px = (m) => (m / 12) * W;              // metres along the car -> px
  sg.fillStyle = st.body; sg.fillRect(0, 0, W, sideH);
  sh.fillStyle = '#808080'; sh.fillRect(0, 0, W, sideH);
  so.fillStyle = 'rgb(255,95,140)'; so.fillRect(0, 0, W, sideH);
  // lower band and pinstripe
  sg.fillStyle = st.band; sg.fillRect(0, py(0.55), W, py(0.25) - py(0.55));
  sg.fillStyle = st.band2; sg.fillRect(0, py(0.62), W, py(0.55) - py(0.62));
  sg.fillStyle = st.band2; sg.fillRect(0, py(2.05), W, py(1.98) - py(2.05));
  // doors at 2.5 m and 9.5 m, windows between
  const doors = [2.1, 9.9];
  for (const dz of doors) {
    const x0 = px(dz - 0.65), x1 = px(dz + 0.65);
    sg.fillStyle = 'rgba(0,0,0,0.12)'; sg.fillRect(x0, py(1.95), x1 - x0, py(0.05) - py(1.95));
    sg.strokeStyle = '#1d2026'; sg.lineWidth = 3; sg.strokeRect(x0, py(1.95), x1 - x0, py(0.05) - py(1.95));
    sg.beginPath(); sg.moveTo((x0 + x1) / 2, py(1.95)); sg.lineTo((x0 + x1) / 2, py(0.05)); sg.stroke();
    // door windows
    for (const xx of [x0 + 6, (x0 + x1) / 2 + 5]) {
      const ww = (x1 - x0) / 2 - 11;
      const gr = sg.createLinearGradient(0, py(1.8), 0, py(1.1));
      gr.addColorStop(0, '#5b7186'); gr.addColorStop(1, '#141c26');
      sg.fillStyle = gr; sg.fillRect(xx, py(1.8), ww, py(1.1) - py(1.8));
      so.fillStyle = 'rgb(255,20,0)'; so.fillRect(xx, py(1.8), ww, py(1.1) - py(1.8));
      sh.fillStyle = '#5a5a5a'; sh.fillRect(xx, py(1.8), ww, py(1.1) - py(1.8));
    }
    sh.strokeStyle = '#3c3c3c'; sh.lineWidth = 4; sh.strokeRect(x0, py(1.95), x1 - x0, py(0.05) - py(1.95));
    so.fillStyle = 'rgb(235,110,120)'; so.fillRect(x0 - 2, py(1.95), x1 - x0 + 4, py(0.05) - py(1.95));
  }
  // window band
  for (let k = 0; k < 6; k++) {
    const z = 3.3 + k * 0.95;
    if (z > 8.9) break;
    const x0 = px(z), x1 = px(z + 0.78);
    const gr = sg.createLinearGradient(0, py(1.92), 0, py(1.15));
    gr.addColorStop(0, '#6f879c'); gr.addColorStop(0.45, '#22303d'); gr.addColorStop(1, '#0f151c');
    sg.fillStyle = gr;
    sg.beginPath(); sg.roundRect(x0, py(1.92), x1 - x0, py(1.15) - py(1.92), 6); sg.fill();
    sg.fillStyle = 'rgba(255,255,255,0.18)';
    sg.beginPath(); sg.moveTo(x0 + 6, py(1.9)); sg.lineTo(x0 + 22, py(1.9)); sg.lineTo(x0 + 6, py(1.4)); sg.fill();
    so.fillStyle = 'rgb(255,18,0)'; so.fillRect(x0, py(1.92), x1 - x0, py(1.15) - py(1.92));
    sh.fillStyle = '#585858'; sh.beginPath(); sh.roundRect(x0 - 2, py(1.94), x1 - x0 + 4, py(1.13) - py(1.94), 7); sh.fill();
  }
  // panel seams
  sh.fillStyle = '#5c5c5c';
  for (const z of [0.15, 1.2, 3.05, 6.0, 8.95, 10.8, 11.85]) sh.fillRect(px(z), 0, 3, sideH);
  sh.fillRect(0, py(0.3), W, 3);
  // abstract graffiti on the lower half (some liveries)
  if (st.graffiti) {
    const pal = PALETTES[(index + 1) % PALETTES.length];
    sg.save();
    sg.beginPath(); sg.rect(px(3.2), py(1.05), px(5.7), py(0.08) - py(1.05)); sg.clip();
    for (let k = 0; k < 2; k++) graffitiPiece(sg, rng, px(4.6 + k * 2.7), py(0.62), 0.42, pal);
    sg.restore();
    so.fillStyle = 'rgba(255,160,40,0.6)'; so.fillRect(px(3.2), py(1.05), px(5.7), py(0.08) - py(1.05));
  }
  // grime: darker toward the bottom, streaks
  const grime = sg.createLinearGradient(0, sideH, 0, py(1.2));
  grime.addColorStop(0, 'rgba(40,30,20,0.55)'); grime.addColorStop(1, 'rgba(40,30,20,0)');
  sg.fillStyle = grime; sg.fillRect(0, 0, W, sideH);
  for (let k = 0; k < 40; k++) {
    sg.fillStyle = `rgba(30,25,20,${rng.range(0.04, 0.12).toFixed(2)})`;
    sg.fillRect(rng.range(0, W), rng.range(0, sideH * 0.4), rng.range(2, 6), rng.range(20, 80));
  }
  so.fillStyle = 'rgba(255,200,40,0.35)'; so.fillRect(0, py(0.4), W, sideH - py(0.4));

  // left side: up = smaller y (natural); right side: flipped vertically
  const leftY = yOf(fSideTop), rightY = yOf(1);
  for (const [cv, gg] of [[side, g], [sideHt, hg], [sideO, og]]) {
    gg.drawImage(cv, 0, leftY, W, sideH);
    gg.save(); gg.translate(0, rightY + sideH); gg.scale(1, -1); gg.drawImage(cv, 0, 0, W, sideH); gg.restore();
  }
  // roof (and rounded corners)
  const r0 = yOf(fRoofEnd), r1 = yOf(fSideTop);
  g.fillStyle = st.roof; g.fillRect(0, r0, W, r1 - r0);
  og.fillStyle = 'rgb(255,150,210)'; og.fillRect(0, r0, W, r1 - r0);
  const mid = (r0 + r1) / 2;
  for (let k = 0; k < 3; k++) {
    const z = 2.5 + k * 3.5;
    g.fillStyle = '#8a9096'; g.fillRect(px(z), mid - 18, px(1.6), 36);
    g.fillStyle = '#5d6369';
    for (let v = 0; v < 6; v++) g.fillRect(px(z) + 6 + v * 20, mid - 14, 10, 28);
    hg.fillStyle = '#c0c0c0'; hg.fillRect(px(z), mid - 18, px(1.6), 36);
    hg.fillStyle = '#707070'; for (let v = 0; v < 6; v++) hg.fillRect(px(z) + 6 + v * 20, mid - 14, 10, 28);
  }
  g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, r0, W, 3); g.fillRect(0, r1 - 3, W, 3);

  // end faces: front (0..256) and back (256..512) in rows 384..512
  for (let e = 0; e < 2; e++) {
    const x0 = e * 256, y0 = BODY, fw = 256, fh = 128;
    const fx = (u) => x0 + u * fw;               // u: 0..1 across the face
    const fy = (m) => y0 + fh * (1 - (m - 0.62) / 2.58); // metres up -> px
    g.fillStyle = st.body; g.fillRect(x0, y0, fw, fh);
    og.fillStyle = 'rgb(255,95,140)'; og.fillRect(x0, y0, fw, fh);
    g.fillStyle = st.band; g.fillRect(x0, fy(1.25), fw, fy(0.85) - fy(1.25));
    // windscreen
    const gr = g.createLinearGradient(0, fy(2.85), 0, fy(1.75));
    gr.addColorStop(0, '#7f97ab'); gr.addColorStop(0.5, '#25323f'); gr.addColorStop(1, '#0d1218');
    g.fillStyle = gr;
    g.beginPath(); g.roundRect(fx(0.12), fy(2.85), fw * 0.76, fy(1.72) - fy(2.85), 10); g.fill();
    og.fillStyle = 'rgb(255,15,0)'; og.fillRect(fx(0.12), fy(2.85), fw * 0.76, fy(1.72) - fy(2.85));
    hg.fillStyle = '#4c4c4c'; hg.beginPath(); hg.roundRect(fx(0.1), fy(2.88), fw * 0.8, fy(1.68) - fy(2.88), 12); hg.fill();
    // blank destination panel (dark, no text)
    g.fillStyle = '#121418'; g.fillRect(fx(0.3), fy(3.05), fw * 0.4, fy(2.9) - fy(3.05));
    // lamps (unlit; the bright ones are a separate mesh on moving trains)
    for (const u of [0.19, 0.81]) {
      g.fillStyle = '#2a2d33'; g.beginPath(); g.arc(fx(u), fy(1.0), 15, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#e8e2cf'; g.beginPath(); g.arc(fx(u), fy(1.0), 10, 0, Math.PI * 2); g.fill();
      og.fillStyle = 'rgb(255,30,60)'; og.beginPath(); og.arc(fx(u), fy(1.0), 15, 0, Math.PI * 2); og.fill();
    }
    // centre gangway door outline
    g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 2; g.strokeRect(fx(0.38), fy(1.65), fw * 0.24, fy(0.66) - fy(1.65));
    const gm = g.createLinearGradient(0, y0 + fh, 0, fy(1.0));
    gm.addColorStop(0, 'rgba(30,20,10,0.5)'); gm.addColorStop(1, 'rgba(30,20,10,0)');
    g.fillStyle = gm; g.fillRect(x0, y0, fw, fh);
  }
  // bumper swatch used by the bumpers' uvs (u 0.9..0.92, v 0.02..0.04)
  g.fillStyle = '#2b2d31'; g.fillRect(W * 0.88, H - H * 0.06, W * 0.06, H * 0.06);

  const hf = heightFromCanvas(hc);
  const fine = fbm(W / 2, H / 2, 32, 2, 600 + index);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hf[x + y * W] += fine[(x >> 1) + (y >> 1) * (W / 2)] * 0.03;
  return { map: tex(c, { color: true, repeat: false }), normalMap: tex(normalFromHeight(hf, W, H, 2.2), { repeat: false }), orm: tex(oc, { repeat: false }) };
}

// ------------------------------------------------------------------ misc
function rampTex() {
  const S = 256;
  const hc = canvas(S, S), hg = ctx2d(hc);
  hg.fillStyle = '#7a7a7a'; hg.fillRect(0, 0, S, S);
  // diamond tread plate
  hg.fillStyle = '#b8b8b8';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    hg.save(); hg.translate(x * 32 + (y % 2) * 16 + 16, y * 32 + 16); hg.rotate(y % 2 ? 0.6 : -0.6);
    hg.fillRect(-10, -2.5, 20, 5); hg.restore();
  }
  const n = fbm(S, S, 8, 3, 71);
  const map = imageFrom(S, S, (x, y, i, d, o) => { const v = 0.82 + n[i] * 0.25; d[o] = v * 255; d[o + 1] = v * 250; d[o + 2] = v * 240; });
  const orm = imageFrom(S, S, (x, y, i, d, o) => { d[o] = 255; d[o + 1] = (0.45 + n[i] * 0.3) * 255; d[o + 2] = 120; });
  return { map: tex(map, { color: true }), normalMap: tex(normalFromHeight(heightFromCanvas(hc), S, S, 3)), orm: tex(orm) };
}

function wagonTex() {
  const W = 256, H = 128;
  const hc = canvas(W, H), hg = ctx2d(hc);
  const grd = hg.createLinearGradient(0, 0, 16, 0);
  grd.addColorStop(0, '#606060'); grd.addColorStop(0.5, '#b0b0b0'); grd.addColorStop(1, '#606060');
  hg.fillStyle = grd;
  for (let x = 0; x < W; x += 16) { hg.save(); hg.translate(x, 0); hg.fillRect(0, 0, 16, H); hg.restore(); }
  const n = fbm(W, H, 8, 4, 81);
  const map = imageFrom(W, H, (x, y, i, d, o) => {
    const rust = clamp01((n[i] - 0.5) * 3);
    const v = 0.85 + (x % 16 < 2 ? -0.15 : 0);
    d[o] = clamp01(mix(v, 0.55, rust)) * 255; d[o + 1] = clamp01(mix(v, 0.33, rust)) * 255; d[o + 2] = clamp01(mix(v, 0.2, rust)) * 255;
  });
  const orm = imageFrom(W, H, (x, y, i, d, o) => { d[o] = 255; d[o + 1] = (0.6 + n[i] * 0.35) * 255; d[o + 2] = 90; });
  return { map: tex(map, { color: true }), normalMap: tex(normalFromHeight(heightFromCanvas(hc), W, H, 2)), orm: tex(orm) };
}

function coinTex() {
  const S = 128;
  const hc = canvas(S, S), g = ctx2d(hc);
  g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
  const grd = g.createRadialGradient(64, 64, 40, 64, 64, 64);
  grd.addColorStop(0, '#808080'); grd.addColorStop(0.7, '#c0c0c0'); grd.addColorStop(0.85, '#606060'); grd.addColorStop(1, '#808080');
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  // raised star
  g.fillStyle = '#d8d8d8';
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i / 10) * Math.PI * 2, r = i % 2 ? 14 : 32;
    i ? g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r) : g.moveTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  g.closePath(); g.fill();
  return { normalMap: tex(normalFromHeight(heightFromCanvas(hc), S, S, 4), { repeat: false }) };
}

function blobTex() {
  const S = 64;
  const c = imageFrom(S, S, (x, y, i, d, o) => {
    const dx = (x + 0.5) / S - 0.5, dy = (y + 0.5) / S - 0.5;
    const r = Math.sqrt(dx * dx + dy * dy) * 2;
    const v = clamp01(1 - r);
    d[o] = d[o + 1] = d[o + 2] = v * v * 255;
  });
  return tex(c, { repeat: false });
}

// Building facades for the skyline: 4 styles, each a tileable 12 m x 24 m patch
// of windows (4 columns x 8 floors), with lit windows in an emissive map.
function facades() {
  const styles = [
    { wall: '#b98a6a', win: '#3a4656', cols: 4, rows: 8 },
    { wall: '#8e9aa6', win: '#2c3a48', cols: 5, rows: 8 },
    { wall: '#c7b9a0', win: '#40464c', cols: 3, rows: 6 },
    { wall: '#6f6a78', win: '#262c36', cols: 4, rows: 8 },
  ];
  const rng = makeRng(901);
  return styles.map((st) => {
    const W = 128, H = 256;
    const c = canvas(W, H), g = ctx2d(c);
    const e = canvas(W, H), eg = ctx2d(e);
    eg.fillStyle = '#000'; eg.fillRect(0, 0, W, H);
    g.fillStyle = st.wall; g.fillRect(0, 0, W, H);
    const cw = W / st.cols, rh = H / st.rows;
    for (let r = 0; r < st.rows; r++) for (let cc = 0; cc < st.cols; cc++) {
      const x = cc * cw + cw * 0.2, y = r * rh + rh * 0.24, ww = cw * 0.6, hh = rh * 0.52;
      const lit = rng() < 0.1;
      g.fillStyle = lit ? '#ffcf8a' : st.win;
      g.fillRect(x, y, ww, hh);
      if (!lit) { g.fillStyle = 'rgba(255,220,180,0.16)'; g.fillRect(x, y, ww, hh * 0.35); }
      else { eg.fillStyle = '#ff9f4a'; eg.fillRect(x, y, ww, hh); }
    }
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let r = 0; r < st.rows; r++) g.fillRect(0, r * rh, W, 2);
    return { map: tex(c, { color: true }), emissiveMap: tex(e, { color: true }) };
  });
}

// ------------------------------------------------------------------ all
// Builds every texture. `onProgress(frac, label)` lets the loading screen move.
export async function buildTextures(profileAcc, onProgress = () => {}) {
  const big = PLATFORM.mobile ? 512 : 1024;
  const mid = PLATFORM.mobile ? 256 : 512;
  const steps = [
    ['ballast', () => ballast(mid)],
    ['ground', () => ground(mid)],
    ['sleeper', () => concrete(128, 51, [0.66, 0.64, 0.6])],
    ['concrete', () => concrete(mid, 61, [0.74, 0.72, 0.68])],
    ['blastwall', () => concrete(256, 71, [0.78, 0.75, 0.68])],
    ['graffiti', () => graffitiWalls(big)],
    ['fence', () => fence()],
    ['ramp', () => rampTex()],
    ['wagon', () => wagonTex()],
    ['coin', () => coinTex()],
    ['blob', () => blobTex()],
    ['facades', () => facades()],
  ];
  const out = { liveries: [] };
  const total = steps.length + 4;
  let done = 0;
  const tick = async (label) => {
    onProgress(++done / total, label);
    await new Promise((r) => setTimeout(r, 0)); // let the loading bar paint
  };
  for (const [name, fn] of steps) { out[name] = fn(); await tick(name); }
  for (let i = 0; i < 4; i++) { out.liveries.push(livery(i, profileAcc)); await tick('livery ' + i); }
  return out;
}
