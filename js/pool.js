// Instanced pools that draw only the slots in use.
// mesh.count = highest used slot + 1, and new items take the lowest free slot,
// so a 600-slot pool with 50 items in play costs the GPU ~50 instances, not 600.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();

export const allPools = [];

export class InstancePool {
  constructor(geometry, material, capacity, { name = '', castShadow = false, receiveShadow = true, colors = false } = {}) {
    this.capacity = capacity;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = name;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // instances span the whole track; bounds would be stale anyway
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = receiveShadow;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colors) {
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    this.arr = this.mesh.instanceMatrix.array;
    this.used = new Uint8Array(capacity);
    this.high = -1;
    this.lowFree = 0;
    this.live = 0;
    this.dirty = false;
    this.colorDirty = false;
    this.overflowed = false;
    allPools.push(this);
  }

  alloc() {
    let i = this.lowFree;
    const used = this.used;
    while (i < this.capacity && used[i]) i++;
    if (i >= this.capacity) {
      if (!this.overflowed) { this.overflowed = true; console.warn(`Pool "${this.mesh.name}" is full (${this.capacity})`); }
      return -1;
    }
    used[i] = 1;
    this.lowFree = i + 1;
    this.live++;
    if (i > this.high) { this.high = i; this.mesh.count = i + 1; }
    return i;
  }

  free(i) {
    if (i < 0 || !this.used[i]) return;
    this.used[i] = 0;
    this.live--;
    // Hide the slot (zero scale) in case it stays below the highest used slot.
    const a = this.arr, o = i * 16;
    for (let k = 0; k < 16; k++) a[o + k] = 0;
    if (i < this.lowFree) this.lowFree = i;
    if (i === this.high) {
      let h = i - 1;
      while (h >= 0 && !this.used[h]) h--;
      this.high = h;
      this.mesh.count = h + 1;
    }
    this.dirty = true;
  }

  clear() {
    this.used.fill(0);
    this.arr.fill(0);
    this.high = -1;
    this.lowFree = 0;
    this.live = 0;
    this.mesh.count = 0;
    this.dirty = true;
  }

  // Translation + rotation about Y + scale, written straight into the buffer.
  setTRS(i, x, y, z, ry = 0, sx = 1, sy = 1, sz = 1) {
    if (i < 0) return;
    const a = this.arr, o = i * 16;
    const c = Math.cos(ry), s = Math.sin(ry);
    a[o] = c * sx; a[o + 1] = 0; a[o + 2] = -s * sx; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = sy; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = s * sz; a[o + 9] = 0; a[o + 10] = c * sz; a[o + 11] = 0;
    a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
    this.dirty = true;
  }

  // General rotation (Euler XYZ).
  setTRSE(i, x, y, z, rx, ry, rz, sx = 1, sy = 1, sz = 1) {
    if (i < 0) return;
    _q.setFromEuler(_e.set(rx, ry, rz));
    _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
    _m.toArray(this.arr, i * 16);
    this.dirty = true;
  }

  setPos(i, x, y, z) {
    if (i < 0) return;
    const o = i * 16;
    this.arr[o + 12] = x; this.arr[o + 13] = y; this.arr[o + 14] = z;
    this.dirty = true;
  }

  setColor(i, r, g, b) {
    if (i < 0 || !this.mesh.instanceColor) return;
    const c = this.mesh.instanceColor.array;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    this.colorDirty = true;
  }

  // Floating origin: move every used instance along z.
  shiftZ(dz) {
    const a = this.arr;
    for (let i = 0; i <= this.high; i++) if (this.used[i]) a[i * 16 + 14] += dz;
    this.dirty = true;
  }

  flush() {
    if (this.dirty) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(0, Math.max(1, this.high + 1) * 16);
      im.needsUpdate = true;
      this.dirty = false;
    }
    if (this.colorDirty) {
      const ic = this.mesh.instanceColor;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, Math.max(1, this.high + 1) * 3);
      ic.needsUpdate = true;
      this.colorDirty = false;
    }
  }
}

export function flushPools() {
  for (let i = 0; i < allPools.length; i++) allPools[i].flush();
}
