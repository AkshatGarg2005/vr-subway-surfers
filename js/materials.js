// Shared materials. Created once at load (never during a run).
// `tex` comes from js/textures.js; any missing map just falls back to a colour.
import * as THREE from 'three';

export const LIVERIES = 4;

function std(opts) {
  return new THREE.MeshStandardMaterial({ vertexColors: true, ...opts });
}

// With an ORM map, roughness/metalness come entirely from the map (factors 1).
function maps(t, colorSpace = true) {
  if (!t) return {};
  const o = {};
  if (t.map) { o.map = t.map; if (colorSpace) t.map.colorSpace = THREE.SRGBColorSpace; }
  if (t.normalMap) o.normalMap = t.normalMap;
  if (t.orm) { o.aoMap = t.orm; o.roughnessMap = t.orm; o.metalnessMap = t.orm; o.roughness = 1; o.metalness = 1; o.aoMapIntensity = 1; }
  return o;
}

export function createMaterials(tex = {}) {
  const m = {};
  m.ballast = std({ color: 0x9a8f80, roughness: 1, metalness: 0, ...maps(tex.ballast) });
  m.ground = std({ color: 0x8c8274, roughness: 0.95, ...maps(tex.ground) });
  m.sleeper = std({ color: 0xa8a197, roughness: 0.9, ...maps(tex.sleeper) });
  m.rail = std({ color: 0x9a9ea3, roughness: 0.38, metalness: 1 });
  m.walls = [];
  for (let i = 0; i < 1; i++) m.walls.push(std({ color: 0xffffff, roughness: 0.9, ...maps(tex.graffiti) }));
  m.fence = std({ color: 0xb8bec4, roughness: 0.5, metalness: 0.6, alphaTest: 0.5, side: THREE.DoubleSide, ...maps(tex.fence) });
  m.metal = std({ color: 0xffffff, roughness: 0.55, metalness: 0.7 });
  m.paint = std({ color: 0xffffff, roughness: 0.6, metalness: 0.1 });
  m.concrete = std({ color: 0xffffff, roughness: 0.92, ...maps(tex.concrete) });
  m.wire = new THREE.MeshStandardMaterial({ color: 0x222426, roughness: 0.6, metalness: 0.5 });
  m.wagon = std({ color: 0xffffff, roughness: 0.75, metalness: 0.2, ...maps(tex.wagon) });

  m.hurdle = std({ color: 0xffffff, roughness: 0.5, metalness: 0.1 });
  m.barrier = std({ color: 0xffffff, roughness: 0.45, metalness: 0.15 });
  m.wallOb = std({ color: 0xffffff, roughness: 0.85, ...maps(tex.blastwall) });
  m.ramp = std({ color: 0xffffff, roughness: 0.55, metalness: 0.45, ...maps(tex.ramp) });

  m.trainBody = [];
  const fallback = [0x2f7de0, 0xe8442f, 0x2fb36a, 0xf2b100];
  for (let i = 0; i < LIVERIES; i++) {
    const t = tex.liveries && tex.liveries[i];
    m.trainBody.push(std({ color: t ? 0xffffff : fallback[i], roughness: 0.45, metalness: 0.35, ...maps(t) }));
  }
  m.trainUnder = std({ color: 0xffffff, roughness: 0.7, metalness: 0.6 });
  // Emissive-only lamps: values above 1 feed the bloom pass.
  m.headlight = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.92, 0.75).multiplyScalar(6), toneMapped: false });
  m.lampRed = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.12, 0.08).multiplyScalar(4), toneMapped: false });
  m.signal = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });

  m.coin = new THREE.MeshStandardMaterial({
    color: 0xffc83a, roughness: 0.22, metalness: 1, emissive: 0x6a3a00, emissiveIntensity: 0.6,
    ...(tex.coin ? { normalMap: tex.coin.normalMap } : {}),
  });
  // Power-ups glow: unlit vertex colours pushed above 1 so the bloom picks them up.
  m.power = new THREE.MeshBasicMaterial({ vertexColors: true, color: new THREE.Color(1.6, 1.6, 1.6) });
  m.blob = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false, ...(tex.blob ? { alphaMap: tex.blob } : {}) });
  m.halo = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, ...(tex.blob ? { alphaMap: tex.blob } : {}) });
  return m;
}
