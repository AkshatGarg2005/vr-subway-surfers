// Pooled particles: coin sparkles, landing dust and sparks. Two point clouds
// (additive glow and soft dust); each draws only its used range, and nothing
// is allocated while running.
import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  varying float vAlpha;
  varying vec3 vTint;
  uniform float scale;
  void main() {
    vAlpha = alpha;
    vTint = tint;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / max(0.1, -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }`;

const FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vTint;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float d = dot(p, p);
    if (d > 1.0) discard;
    float a = vAlpha * (1.0 - d) * (1.0 - d);
    gl_FragColor = vec4(vTint * a, a);
  }`;

class Cloud {
  constructor(n, additive) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.tint = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.alpha = new Float32Array(n);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.high = -1;
    this.low = 0;
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aAlpha = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.BufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('size', this.aSize);
    g.setAttribute('alpha', this.aAlpha);
    g.setAttribute('tint', this.aTint);
    g.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { scale: { value: 600 } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.CustomBlending,
      // premultiplied "over" for the soft dust
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  spawn(x, y, z, vx, vy, vz, life, size, r, g, b, grav, drag) {
    let i = this.low;
    while (i < this.n && this.life[i] > 0) i++;
    if (i >= this.n) return;
    this.low = i + 1;
    if (i > this.high) this.high = i;
    const o = i * 3;
    this.pos[o] = x; this.pos[o + 1] = y; this.pos[o + 2] = z;
    this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
    this.tint[o] = r; this.tint[o + 1] = g; this.tint[o + 2] = b;
    this.life[i] = life; this.max[i] = life;
    this.size0[i] = size; this.size[i] = size;
    this.grav[i] = grav; this.drag[i] = drag;
    this.alpha[i] = 1;
  }

  update(dt) {
    let high = -1;
    for (let i = 0; i <= this.high; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.life[i] = 0; this.alpha[i] = 0; this.size[i] = 0;
        if (i < this.low) this.low = i;
        continue;
      }
      high = i;
      const o = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[o] *= dr; this.vel[o + 2] *= dr;
      this.vel[o + 1] = this.vel[o + 1] * dr - this.grav[i] * dt;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 1] += this.vel[o + 1] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
      const t = this.life[i] / this.max[i];
      this.alpha[i] = t < 0.7 ? t / 0.7 : 1;
      this.size[i] = this.size0[i] * (0.6 + 0.4 * t);
    }
    this.high = high;
    const count = high + 1;
    this.points.geometry.setDrawRange(0, count);
    if (count > 0) {
      for (const a of [this.aPos, this.aSize, this.aAlpha, this.aTint]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, count * a.itemSize);
        a.needsUpdate = true;
      }
    }
  }

  shiftZ(dz) { for (let i = 0; i <= this.high; i++) this.pos[i * 3 + 2] += dz; }
  clear() { this.life.fill(0); this.alpha.fill(0); this.size.fill(0); this.high = -1; this.low = 0; this.points.geometry.setDrawRange(0, 0); }
}

export class Particles {
  constructor(scene) {
    this.glow = new Cloud(400, true);
    this.soft = new Cloud(300, false);
    scene.add(this.glow.points, this.soft.points);
    this.r = Math.random;
  }

  // Point size scale = pixels per metre at 1 m distance for the current target.
  setScale(pixelHeight, fovDeg) {
    const s = pixelHeight / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.glow.material.uniforms.scale.value = s;
    this.soft.material.uniforms.scale.value = s;
  }

  sparkle(x, y, z, n = 8) {
    const r = this.r;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, u = r() * 2 - 1, sp = 1.2 + r() * 2.2;
      const k = Math.sqrt(1 - u * u);
      this.glow.spawn(x, y, z, Math.cos(a) * k * sp, u * sp + 1, Math.sin(a) * k * sp, 0.35 + r() * 0.3, 0.09 + r() * 0.07, 3.2, 2.4, 0.9, 2, 3);
    }
  }

  sparks(x, y, z, n = 12) {
    const r = this.r;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, sp = 3 + r() * 5;
      this.glow.spawn(x, y, z, Math.cos(a) * sp, 1 + r() * 4, Math.sin(a) * sp * 0.5 + 2, 0.3 + r() * 0.35, 0.05 + r() * 0.05, 4, 2.2, 0.8, 14, 1.5);
    }
  }

  dust(x, y, z, n = 8) {
    const r = this.r;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, sp = 0.6 + r() * 1.4;
      this.soft.spawn(x + Math.cos(a) * 0.3, y + 0.08, z + Math.sin(a) * 0.3, Math.cos(a) * sp, 0.3 + r() * 0.7, Math.sin(a) * sp + 1.5, 0.5 + r() * 0.4, 0.35 + r() * 0.3, 0.55, 0.5, 0.44, -0.4, 2.5);
    }
  }

  update(dt) {
    this.glow.update(dt);
    this.soft.update(dt);
  }

  shiftZ(dz) { this.glow.shiftZ(dz); this.soft.shiftZ(dz); }
  clear() { this.glow.clear(); this.soft.clear(); }
}
