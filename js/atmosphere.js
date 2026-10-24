// Sky, sky-tinted fog, city skyline, sun + shadows, and the environment map.
import * as THREE from 'three';
import { RENDER, makeRng } from './config.js';
import { InstancePool } from './pool.js';

// Toward the sun: low, ahead and to the right (late afternoon).
export const SUN_DIR = new THREE.Vector3(0.62, 0.27, -0.74).normalize();
const S = SUN_DIR;

// Shared sky colour function (linear HDR). Used by the sky dome, by the fog
// (so distant things fade into the sky behind them) and by the environment map.
export const SKY_GLSL = /* glsl */ `
  const vec3 SKY_SUN = vec3(${S.x.toFixed(5)}, ${S.y.toFixed(5)}, ${S.z.toFixed(5)});
  vec3 skyGradient(vec3 dir) {
    float y = dir.y;
    float h = max(y, 0.0);
    float sd = max(dot(dir, SKY_SUN), 0.0);
    vec3 horizon = vec3(0.92, 0.66, 0.47);
    vec3 mid = vec3(0.52, 0.58, 0.72);
    vec3 zenith = vec3(0.14, 0.29, 0.62);
    vec3 col = mix(horizon, mid, smoothstep(0.0, 0.22, h));
    col = mix(col, zenith, smoothstep(0.18, 0.85, h));
    // warm glow around the low sun
    col += vec3(1.0, 0.5, 0.2) * pow(sd, 6.0) * 0.42 * (1.0 - smoothstep(0.0, 0.6, h));
    col += vec3(1.0, 0.72, 0.45) * pow(sd, 64.0) * 1.3;
    // below the horizon: dusty ground haze
    col = mix(col, vec3(0.5, 0.42, 0.36), smoothstep(0.0, -0.12, y));
    return col;
  }
  vec3 skyFogColor(vec3 dir) {
    return skyGradient(vec3(dir.x, max(dir.y, 0.015), dir.z)) * 0.86;
  }
`;

// Fog: exponential-squared, thinner with height, coloured by the sky in the
// direction you look. Installed into three's shader chunks before any material compiles.
let fogInstalled = false;
export function installSkyFog() {
  if (fogInstalled) return;
  fogInstalled = true;
  const C = THREE.ShaderChunk;
  C.fog_pars_vertex = `#ifdef USE_FOG
    varying float vFogDepth;
    varying vec3 vFogViewPos;
  #endif`;
  C.fog_vertex = `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    vFogViewPos = mvPosition.xyz;
  #endif`;
  C.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vFogViewPos;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif
    ${SKY_GLSL}
  #endif`;
  C.fog_fragment = `#ifdef USE_FOG
    vec3 fogW = (vec4(vFogViewPos, 0.0) * viewMatrix).xyz;   // view -> world (rotation only)
    float fogDist = length(fogW);
    vec3 fogDir = fogW / max(fogDist, 1e-4);
    float fogY = cameraPosition.y + fogW.y;
    #ifdef FOG_EXP2
      float fogD = fogDensity * exp(-max(fogY, 0.0) * 0.014);
      float fogFactor = 1.0 - exp(-fogD * fogD * fogDist * fogDist);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    gl_FragColor.rgb = mix(gl_FragColor.rgb, skyFogColor(fogDir) * fogColor, fogFactor);
  #endif`;
}

function skyMaterial(withSunDisk, clouds) {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, sunDisk: { value: withSunDisk ? 1 : 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // always at the far plane
      }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform float sunDisk;
      varying vec3 vDir;
      ${SKY_GLSL}
      float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec3 dir = normalize(vDir);
        vec3 col = skyGradient(dir);
        float sd = max(dot(dir, SKY_SUN), 0.0);
        ${clouds ? `
        if (dir.y > 0.0) {
          vec2 uv = dir.xz / (dir.y + 0.12) * 1.6 + vec2(time * 0.004, time * 0.002);
          float n = vnoise(uv) * 0.55 + vnoise(uv * 2.3) * 0.3 + vnoise(uv * 5.1) * 0.15;
          float cov = smoothstep(0.52, 0.78, n) * smoothstep(0.02, 0.2, dir.y) * (1.0 - smoothstep(0.55, 0.9, dir.y));
          vec3 lit = mix(vec3(0.82, 0.7, 0.66), vec3(1.45, 0.98, 0.6), pow(sd, 3.0));
          col = mix(col, lit, cov * 0.75);
        }` : ''}
        col += vec3(1.0, 0.86, 0.62) * smoothstep(0.99935, 0.99965, sd) * 40.0 * sunDisk;
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
  });
}

// Skyline facade material: window grid tiled by each instance's size.
function facadeMaterial(map) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 0.85, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0.0 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      #ifdef USE_INSTANCING
        float bsx = length(instanceMatrix[0].xyz), bsy = length(instanceMatrix[1].xyz), bsz = length(instanceMatrix[2].xyz);
        float bu = abs(normal.x) > 0.5 ? bsz : bsx;
        vMapUv *= vec2(bu / 12.0, bsy / 24.0);
      #endif`);
  };
  m.customProgramCacheKey = () => 'facade';
  return m;
}

export class Atmosphere {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    installSkyFog();
    scene.fog = new THREE.FogExp2(0xffffff, 0.0048);
    scene.background = null;

    this.sky = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), skyMaterial(true, true));
    this.sky.frustumCulled = false;
    this.sky.renderOrder = 1000; // drawn after the opaque scene so hidden sky pixels are skipped by the depth test
    this.sky.name = 'sky';
    scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0xa9c2e6, 0x8a6e58, 0.55);
    scene.add(this.hemi);
    const sun = (this.sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.8, 0.6), 3.0));
    sun.castShadow = true;
    const R = RENDER.shadowRange;
    const cam = sun.shadow.camera;
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R;
    cam.near = 1; cam.far = 160;
    sun.shadow.mapSize.set(RENDER.shadowMapSize, RENDER.shadowMapSize);
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.035;
    scene.add(sun, sun.target);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.texel = (2 * R) / RENDER.shadowMapSize;
    // light-space basis (the same one the shadow camera's lookAt builds)
    this.lz = SUN_DIR.clone();
    this.lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), this.lz).normalize();
    this.ly = new THREE.Vector3().crossVectors(this.lz, this.lx);
    this._c = new THREE.Vector3();
    this.time = 0;
  }

  // Environment map: a pre-filtered (PMREM) copy of the sky for reflections and ambient.
  buildEnvironment() {
    const envScene = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), skyMaterial(false, true));
    envScene.add(dome);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(envScene, 0, 0.5, 1000);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.65;
    pmrem.dispose();
    dome.geometry.dispose();
    dome.material.dispose();
  }

  // City skyline: two bands of buildings each side, recycled along the track.
  buildSkyline(tex, world) {
    this.world = world;
    const styles = tex.facades;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    this.blocks = [];
    this.skyPools = styles.map((t, i) => {
      const p = new InstancePool(geo, facadeMaterial(t.map), 64, { name: 'skyline' + i, receiveShadow: false });
      if (t.emissiveMap) { p.mesh.material.emissiveMap = t.emissiveMap; p.mesh.material.emissiveIntensity = 0.8; }
      this.scene.add(p.mesh);
      return p;
    });
    const rng = makeRng(4242);
    const bands = [
      { n: 18, span: 480, x0: 62, x1: 110, h0: 16, h1: 52, w0: 14, w1: 28 },
      { n: 16, span: 1000, x0: 160, x1: 320, h0: 50, h1: 150, w0: 22, w1: 50 },
    ];
    for (const b of bands) {
      for (const side of [-1, 1]) {
        for (let i = 0; i < b.n; i++) {
          const style = rng.int(0, styles.length - 1);
          const pool = this.skyPools[style];
          const slot = pool.alloc();
          const blk = {
            pool, slot, span: b.span,
            s: (i / b.n) * b.span - 60 + rng.range(0, b.span / b.n * 0.6),
            x: side * rng.range(b.x0, b.x1), h: rng.range(b.h0, b.h1), w: rng.range(b.w0, b.w1), d: rng.range(b.w0, b.w1),
          };
          this.blocks.push(blk);
          this._placeBlock(blk);
        }
      }
    }
  }

  _placeBlock(b) {
    b.pool.setTRS(b.slot, b.x, -0.5, this.world.z(b.s + b.d / 2), 0, b.w, b.h, b.d);
  }

  // Per frame: sun + shadow frustum follow the player; skyline recycles.
  update(dt, camera, playerX, playerS) {
    this.time += dt;
    this.sky.position.copy(camera.getWorldPosition(this._c));
    this.sky.material.uniforms.time.value = this.time;
    const w = this.world;
    if (w) {
      // Snap the shadow frustum centre to whole shadow-map texels: no shimmering edges.
      const c = this._c.set(playerX * 0.4, 0, w.z(playerS + 14));
      const t = this.texel;
      const cx = Math.round(c.dot(this.lx) / t) * t;
      const cy = Math.round(c.dot(this.ly) / t) * t;
      const cz = c.dot(this.lz);
      c.set(0, 0, 0).addScaledVector(this.lx, cx).addScaledVector(this.ly, cy).addScaledVector(this.lz, cz);
      this.sun.target.position.copy(c);
      this.sun.position.copy(c).addScaledVector(SUN_DIR, 80);
      this.sun.target.updateMatrixWorld();
      for (const b of this.blocks) {
        if (b.s + b.d < playerS - 80) { b.s += b.span; this._placeBlock(b); }
      }
    }
  }

  shiftZ(dz) {
    if (this.skyPools) for (const p of this.skyPools) p.shiftZ(dz);
  }

  flush() { if (this.skyPools) for (const p of this.skyPools) p.flush(); }
}
