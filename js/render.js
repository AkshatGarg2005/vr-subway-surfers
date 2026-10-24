// Rendering: post-processing, phone-VR stereo, sun projection.
//
// Normal screen:  scene -> half-float HDR target -> bloom -> grade (tone map,
//                 split-toning, vignette, grain, flash) + sun shafts, lens flare
//                 and speed blur -> screen.
// Phone VR:       each eye renders into its own target, gets bloom + grade, and
//                 is copied into its half of the screen. The shadow map is drawn
//                 once per frame (before the first eye). Screen-space lens effects
//                 are off: each eye would see them differently.
// WebXR:          renderer.xr draws directly, no post-processing.
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RENDER, PLATFORM, clamp } from './config.js';
import { SUN_DIR } from './atmosphere.js';

const QUAD_VS = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Bright sky near the sun, at quarter resolution: the source for shafts and the flare's occlusion test.
const MASK_FS = /* glsl */ `
  uniform sampler2D tScene; uniform vec2 sunUV; uniform float aspect;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    vec2 d = (vUv - sunUV) * vec2(aspect, 1.0);
    float fall = exp(-dot(d, d) * 7.0);
    gl_FragColor = vec4(c * smoothstep(1.4, 4.0, l) * fall, 1.0);
  }`;

// Radial blur toward the sun: god rays.
const RADIAL_FS = /* glsl */ `
  uniform sampler2D tMask; uniform vec2 sunUV;
  varying vec2 vUv;
  void main() {
    vec2 delta = (vUv - sunUV) * (0.85 / 36.0);
    vec2 uv = vUv;
    vec3 acc = vec3(0.0);
    float w = 1.0;
    for (int i = 0; i < 36; i++) { acc += texture2D(tMask, uv).rgb * w; w *= 0.955; uv -= delta; }
    gl_FragColor = vec4(acc * (1.0 / 14.0), 1.0);
  }`;

const GRADE_FS = /* glsl */ `
  uniform sampler2D tScene, tShafts, tMask;
  uniform vec2 sunUV, res;
  uniform float aspect, sunVis, shafts, flare, speedBlur, flash, vignette, grain, time, comfort, exposure;
  uniform vec3 flashColor;
  varying vec2 vUv;
  float h12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  vec3 aces(vec3 x) {   // ACES-style filmic curve (Narkowicz fit)
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  float disc(vec2 p, vec2 c, float r, float soft) { return 1.0 - smoothstep(r - soft, r, length((p - c) * vec2(aspect, 1.0))); }
  void main() {
    vec2 uv = vUv;
    vec3 col = texture2D(tScene, uv).rgb;
    if (speedBlur > 0.0) {
      // blur streaks outward from the vanishing point, strongest at the edges
      vec2 dir = uv - vec2(0.5, 0.55);
      float k = speedBlur * smoothstep(0.18, 0.75, length(dir * vec2(aspect, 1.0)));
      if (k > 0.001) {
        vec3 acc = col;
        for (int i = 1; i < 6; i++) acc += texture2D(tScene, uv - dir * k * float(i) * 0.011).rgb;
        col = acc / 6.0;
      }
    }
    if (shafts > 0.0) col += texture2D(tShafts, uv).rgb * shafts * sunVis * vec3(1.0, 0.82, 0.6);
    if (flare > 0.0 && sunVis > 0.0) {
      // occlusion: is the sun itself visible (not behind a train)?
      float occ = clamp(dot(texture2D(tMask, sunUV).rgb, vec3(0.33)) * 0.6, 0.0, 1.0);
      float f = flare * sunVis * occ;
      vec2 axis = vec2(0.5) - sunUV;
      vec3 fl = vec3(0.0);
      fl += vec3(1.0, 0.6, 0.3) * disc(uv, sunUV + axis * 0.55, 0.035, 0.03) * 0.25;
      fl += vec3(0.4, 0.9, 0.6) * disc(uv, sunUV + axis * 0.95, 0.06, 0.05) * 0.12;
      fl += vec3(0.5, 0.6, 1.0) * disc(uv, sunUV + axis * 1.35, 0.025, 0.02) * 0.25;
      fl += vec3(1.0, 0.4, 0.7) * disc(uv, sunUV + axis * 1.7, 0.1, 0.09) * 0.07;
      float ring = length((uv - (sunUV + axis * 2.0)) * vec2(aspect, 1.0));
      fl += vec3(0.6, 0.8, 1.0) * smoothstep(0.02, 0.0, abs(ring - 0.28)) * 0.05;
      // horizontal streak through the sun
      vec2 sd = (uv - sunUV) * vec2(aspect, 1.0);
      fl += vec3(1.0, 0.8, 0.6) * exp(-abs(sd.y) * 260.0) * exp(-abs(sd.x) * 3.5) * 0.35;
      col += fl * f;
    }
    col *= exposure;
    col = aces(col);
    // split-toning: cool shadows, warm highlights; a little more saturation
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(vec3(0.93, 0.99, 1.07), vec3(1.05, 1.0, 0.93), smoothstep(0.1, 0.75, l));
    col = clamp(mix(vec3(l), col, 1.1), 0.0, 1.0);
    vec2 q = (uv - 0.5) * vec2(aspect, 1.0);
    col *= 1.0 - dot(q, q) * vignette;
    if (comfort > 0.0) {
      // comfort vignette: narrows the view during lane changes and climbs
      float r = length((uv - 0.5) * vec2(aspect, 1.0) * 1.15);
      col *= 1.0 - smoothstep(0.62 - comfort * 0.3, 0.75 - comfort * 0.3, r) * min(1.0, comfort * 1.6);
    }
    col = mix(col, flashColor, flash);
    col = toSRGB(col);
    col += (h12(uv * res + fract(time) * 91.7) - 0.5) * grain;
    gl_FragColor = vec4(col, 1.0);
  }`;

function rt(w, h, samples = 0, depth = true) {
  const t = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthBuffer: depth, stencilBuffer: false });
  t.texture.generateMipmaps = false;
  return t;
}

class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.samples = 0;
    this.eyes = [rt(4, 4), rt(4, 4)];   // [0] is also the normal-screen target
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), RENDER.bloom.strength, RENDER.bloom.radius, RENDER.bloom.threshold);
    this.maskRT = rt(4, 4, 0, false);
    this.shaftRT = rt(4, 4, 0, false);
    this.maskQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, sunUV: { value: new THREE.Vector2() }, aspect: { value: 1 } },
      vertexShader: QUAD_VS, fragmentShader: MASK_FS, depthTest: false, depthWrite: false,
    }));
    this.radialQuad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tMask: { value: this.maskRT.texture }, sunUV: { value: new THREE.Vector2() } },
      vertexShader: QUAD_VS, fragmentShader: RADIAL_FS, depthTest: false, depthWrite: false,
    }));
    this.grade = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tShafts: { value: this.shaftRT.texture }, tMask: { value: this.maskRT.texture },
        sunUV: { value: new THREE.Vector2(0.5, 0.5) }, res: { value: new THREE.Vector2(1, 1) },
        aspect: { value: 1 }, sunVis: { value: 0 }, shafts: { value: 0 }, flare: { value: 0 }, speedBlur: { value: 0 },
        flash: { value: 0 }, flashColor: { value: new THREE.Color(1, 0.96, 0.9) },
        vignette: { value: 0.32 }, grain: { value: 0.022 }, time: { value: 0 }, comfort: { value: 0 }, exposure: { value: 1.0 },
      },
      vertexShader: QUAD_VS, fragmentShader: GRADE_FS, depthTest: false, depthWrite: false,
    });
    this.gradeQuad = new FullScreenQuad(this.grade);
    this.w = 4; this.h = 4;
    this.eyeStats = [{ calls: 0, triangles: 0 }, { calls: 0, triangles: 0 }];
    this.fault = null; // test hook: 'washR' washes out the right eye (proves the eye check works)
  }

  // Pixel size of one view (the whole screen, or one eye).
  setSize(w, h, samples) {
    w = Math.max(4, Math.round(w)); h = Math.max(4, Math.round(h));
    if (samples !== this.samples) {
      // The sample count is fixed when a target is created: make new ones.
      this.samples = samples;
      for (const e of this.eyes) e.dispose();
      this.eyes = [rt(w, h, samples), rt(w, h, samples)];
    }
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    for (const e of this.eyes) e.setSize(w, h);
    this.bloom.setSize(w, h);
    this.maskRT.setSize(Math.max(4, w >> 2), Math.max(4, h >> 2));
    this.shaftRT.setSize(Math.max(4, w >> 2), Math.max(4, h >> 2));
    this.grade.uniforms.res.value.set(w, h);
    this.grade.uniforms.aspect.value = w / h;
    this.maskQuad.material.uniforms.aspect.value = w / h;
  }

  // Render one view: scene -> target -> post -> screen viewport (x, y, w, h in CSS px).
  view(scene, camera, eye, o, vp) {
    const r = this.renderer;
    const target = this.eyes[eye];
    r.setRenderTarget(target);
    r.clear();
    const c0 = r.info.render.calls, t0 = r.info.render.triangles;
    r.render(scene, camera);
    // per-eye scene cost (the left eye also includes the once-per-frame shadow map)
    const st = this.eyeStats[eye];
    st.calls = r.info.render.calls - c0;
    st.triangles = r.info.render.triangles - t0;
    if (o.bloom) this.bloom.render(r, null, target, 0, false);
    const lensFx = o.shafts || o.flare;
    if (lensFx && o.sunVis > 0.001) {
      const mq = this.maskQuad.material.uniforms;
      mq.tScene.value = target.texture;
      mq.sunUV.value.copy(o.sunUV);
      r.setRenderTarget(this.maskRT);
      this.maskQuad.render(r);
      if (o.shafts) {
        this.radialQuad.material.uniforms.sunUV.value.copy(o.sunUV);
        r.setRenderTarget(this.shaftRT);
        this.radialQuad.render(r);
      }
    }
    const u = this.grade.uniforms;
    u.tScene.value = target.texture;
    u.sunUV.value.copy(o.sunUV);
    u.sunVis.value = lensFx ? o.sunVis : 0;
    u.shafts.value = o.shafts ? 0.32 : 0;
    u.flare.value = o.flare ? 1 : 0;
    u.speedBlur.value = o.speedBlur;
    u.flash.value = this.fault === 'washR' && eye === 1 ? Math.max(o.flash, 0.45) : o.flash;
    u.comfort.value = o.comfort;
    u.time.value = o.time;
    u.grain.value = o.grain;
    u.vignette.value = o.vignette;
    r.setRenderTarget(null);
    r.setViewport(vp[0], vp[1], vp[2], vp[3]);
    r.setScissor(vp[0], vp[1], vp[2], vp[3]);
    r.setScissorTest(true);
    this.gradeQuad.render(r);
    r.setScissorTest(false);
  }
}

export class View {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(RENDER.fovScreen, 1, 0.1, 900);
    this.rig = new THREE.Group();
    this.rig.name = 'rig';
    this.rig.add(this.camera);
    scene.add(this.rig);
    this.stereo = new THREE.StereoCamera();
    this.stereo.eyeSep = RENDER.eyeSep;
    this.post = new PostFX(renderer);
    this.mode = 'screen';
    this.width = 1; this.height = 1;
    this.native = window.devicePixelRatio || 1;
    // Quality knobs (the automatic quality manager moves these).
    this.q = { dpr: Math.min(this.native, RENDER.maxDprScreen), msaa: true, bloom: true, shafts: true, flare: true };
    this.fx = { speed: 0, flash: 0, comfort: 0, time: 0 };
    this.sunUV = new THREE.Vector2();
    this.sunVis = 0;
    this.particles = null;
    this.onResize = [];
    this.slowGPU = null;  // test hook: { usPerMpx, bloomMs }
    this.qualityLog = [];
    this.stats = { calls: 0, triangles: 0, shadowCalls: 0 };
    this._v = new THREE.Vector3();
    renderer.autoClear = true;
    renderer.shadowMap.autoUpdate = false;
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  // Multisampling only on low-density screens: at Retina or phone density 4x MSAA
  // on a half-float target cost more than the rest of the frame, for no visible gain.
  get msaaSamples() { return this.q.msaa && this.native < RENDER.msaaBelowDpr && this.mode !== 'xr' ? 4 : 0; }

  setMode(mode) {
    this.mode = mode;
    const max = mode === 'cardboard' ? RENDER.maxDprCardboard : RENDER.maxDprScreen;
    const start = mode === 'cardboard' ? Math.min(RENDER.startDprCardboard, this.native) : Math.min(this.native, max);
    this.q = { dpr: start, msaa: true, bloom: true, shafts: mode === 'screen', flare: mode === 'screen' };
    this.camera.fov = mode === 'cardboard' ? RENDER.fovCardboard : RENDER.fovScreen;
    this.resize();
    if (this.quality) this.quality.reset(); // the automatic quality starts over in every mode
  }

  maxDpr() { return Math.min(this.native, this.mode === 'cardboard' ? RENDER.maxDprCardboard : RENDER.maxDprScreen); }

  setQuality(patch) {
    Object.assign(this.q, patch);
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.width = w; this.height = h;
    if (this.mode === 'xr' && this.renderer.xr.isPresenting) return;
    const dpr = this.q.dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    if (this.mode === 'cardboard') {
      this.camera.aspect = w / 2 / h;
      this.post.setSize((w / 2) * dpr, h * dpr, this.msaaSamples);
    } else {
      this.camera.aspect = w / h;
      this.post.setSize(w * dpr, h * dpr, this.msaaSamples);
    }
    this.camera.updateProjectionMatrix();
    for (const fn of this.onResize) fn(w, h, dpr);
  }

  // Where the sun is on screen for this camera, and how visible (0..1).
  _sun(camera) {
    const v = this._v.copy(SUN_DIR).multiplyScalar(500).add(camera.getWorldPosition(this._v3 || (this._v3 = new THREE.Vector3())));
    v.project(camera);
    // behind the camera?
    camera.getWorldDirection(this._v2 || (this._v2 = new THREE.Vector3()));
    const front = this._v2.dot(SUN_DIR);
    this.sunUV.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
    const edge = Math.max(Math.abs(v.x), Math.abs(v.y));
    this.sunVis = front > 0 ? clamp((1.25 - edge) / 0.35, 0, 1) : 0;
  }

  render(dt) {
    const r = this.renderer;
    this.fx.time += dt;
    const info = r.info;
    info.autoReset = false;
    info.reset();
    r.shadowMap.needsUpdate = true; // once per frame, before the first (or only) eye
    if (this.mode === 'xr') {
      r.render(this.scene, this.camera);
    } else if (this.mode === 'cardboard') {
      this._stereo();
    } else {
      this._screen();
    }
    this.stats.calls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    if (this.slowGPU) this._busy();
    if (this.afterRender) this.afterRender(); // test hook: runs before the frame is presented
  }

  _opts(o) {
    o.bloom = this.q.bloom;
    o.time = this.fx.time;
    o.flash = this.fx.flash;
    o.grain = this.mode === 'cardboard' ? 0.012 : 0.022;
    o.vignette = this.mode === 'cardboard' ? 0.18 : 0.32;
    return o;
  }

  _screen() {
    const cam = this.camera;
    this.rig.updateMatrixWorld();
    this._sun(cam);
    if (this.particles) this.particles.setScale(this.height * this.q.dpr, cam.fov);
    const reduce = PLATFORM.reducedMotion;
    const o = this._opts(this._o || (this._o = { sunUV: this.sunUV }));
    o.sunVis = this.sunVis;
    o.shafts = this.q.shafts;
    o.flare = this.q.flare;
    o.speedBlur = reduce ? 0 : this.fx.speed * 0.9;
    o.comfort = 0;
    const vp = this._vp || (this._vp = [0, 0, 0, 0]);
    vp[2] = this.width; vp[3] = this.height;
    this.post.view(this.scene, cam, 0, o, vp);
  }

  _stereo() {
    const r = this.renderer;
    const cam = this.camera;
    this.rig.updateMatrixWorld();
    this.stereo.update(cam);
    if (this.particles) this.particles.setScale(this.height * this.q.dpr, cam.fov);
    const o = this._opts(this._o || (this._o = { sunUV: this.sunUV }));
    o.sunVis = 0; o.shafts = false; o.flare = false; o.speedBlur = 0;
    o.comfort = this.fx.comfort;
    const hw = this.width / 2;
    const vl = this._vpL || (this._vpL = [0, 0, 0, 0]), vr = this._vpR || (this._vpR = [0, 0, 0, 0]);
    vl[2] = hw; vl[3] = this.height;
    vr[0] = hw; vr[2] = hw; vr[3] = this.height;
    this.post.view(this.scene, this.stereo.cameraL, 0, o, vl);
    r.shadowMap.needsUpdate = false; // shadows were drawn for the left eye; reuse them
    this.post.view(this.scene, this.stereo.cameraR, 1, o, vr);
    // thin black divider between the eyes
    r.setRenderTarget(null);
    r.setScissorTest(true);
    r.setScissor(hw - 1, 0, 2, this.height);
    r.setViewport(0, 0, this.width, this.height);
    r.setClearColor(0x000000, 1);
    r.clear(true, false, false);
    r.setScissorTest(false);
  }

  // Test hook: pretend the GPU is slow (cost grows with pixel count, more with
  // bloom), and finish on a 60 Hz vsync boundary like a real display does.
  _busy() {
    const px = this.width * this.height * this.q.dpr * this.q.dpr;
    const ms = (px / 1e6) * this.slowGPU.msPerMpx + (this.q.bloom ? this.slowGPU.bloomMs : 0);
    const end = performance.now() + ms;
    while (performance.now() < end) { /* busy */ }
    const vs = 1000 / 60;
    const next = Math.ceil((performance.now() - 2) / vs) * vs;
    while (performance.now() < next) { /* wait for vsync */ }
  }
}
