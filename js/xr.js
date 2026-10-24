// WebXR headset mode (for example Quest): immersive-vr session, controllers,
// lanes from head position (step or lean), real jumps and crouches from head
// height. No post-processing while presenting.
import * as THREE from 'three';
import { BODY, damp, clamp } from './config.js';
import { HeadGestures } from './headgestures.js';

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _f = new THREE.Vector3();

// Controller buttons (xr-standard mapping)
const BTN = { trigger: 0, grip: 1, stick: 3, a: 4, b: 5 };

export class XRMode {
  constructor({ renderer, view, game, input, hud, audio, ui, settings }) {
    Object.assign(this, { renderer, view, game, input, hud, audio, ui, settings });
    this.session = null;
    this.active = false;
    this.gest = new HeadGestures();
    this.yaw0 = 0; this.cx = 0; this.cz = 0;
    this.feet = 0;
    this.pads = new Map();
    this.t = 0;
    this.goRecentered = false;
    this.vignette = this._makeVignette();
    view.camera.add(this.vignette);
  }

  static async supported() {
    try { return !!(navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr'))); } catch { return false; }
  }

  // Comfort vignette for headsets (post-processing is off there): a quad on the
  // head whose clear centre shrinks during lane changes and climbs.
  _makeVignette() {
    const m = new THREE.ShaderMaterial({
      uniforms: { amount: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float amount; varying vec2 vUv;
        void main(){ float r = length(vUv - 0.5) * 2.0; float a = smoothstep(0.62 - amount * 0.3, 0.8 - amount * 0.3, r) * min(1.0, amount * 1.6);
        gl_FragColor = vec4(0.0, 0.0, 0.0, a); }`,
      transparent: true, depthTest: false, depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), m);
    mesh.position.z = -0.3;
    mesh.renderOrder = 999;
    mesh.visible = false;
    mesh.frustumCulled = false;
    return mesh;
  }

  // Called from the "Enter VR" click (a user gesture).
  async enter() {
    if (!navigator.xr) return false;
    let session;
    try {
      session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    } catch (e) {
      console.warn('Could not start VR:', e.message);
      return false;
    }
    // 'local' always works; 'local-floor' (real floor height) when the device has it.
    let type = 'local';
    try { await session.requestReferenceSpace('local-floor'); type = 'local-floor'; } catch { /* local only */ }
    const r = this.renderer;
    r.xr.enabled = true;
    r.xr.setReferenceSpaceType(type);
    if (r.xr.setFoveation) r.xr.setFoveation(1);
    await r.xr.setSession(session);
    this.session = session;
    this.active = true;
    this.refType = type;
    session.addEventListener('end', () => this._ended());
    this.view.setMode('xr');
    this.game.setMode('xr');
    this.game.vr = this;
    this.gest.reset();
    this.hud.show(true);
    this.feet = 0;
    this.game.startRun();
    return true;
  }

  exit() { if (this.session) this.session.end().catch(() => {}); }

  _ended() {
    this.active = false;
    this.session = null;
    this.renderer.xr.enabled = false;
    this.vignette.visible = false;
    this.hud.show(false);
    if (this.onExit) this.onExit();
  }

  // Thumbstick click / countdown: the current head pose becomes "centre, facing the track".
  recenter() {
    const cam = this.view.camera;
    _f.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this.yaw0 = Math.atan2(-_f.x, -_f.z);
    this.cx = cam.position.x; this.cz = cam.position.z;
    this.gest.recenter(cam.position.x, cam.position.y, cam.position.z, this.yaw0);
    this.audio.play('recenter');
  }

  // Per frame, before the game update: head pose -> gestures, controllers -> actions.
  update(dt) {
    if (!this.active) return;
    this.t += dt;
    const r = this.renderer, g = this.game;
    // Pose for this frame (the head pose relative to the rig).
    r.xr.updateCamera(this.view.camera);
    const p = this.view.camera.position;
    const first = this.gest.base == null;
    const ev = this.gest.update(p.x, p.y, p.z, this.t, dt);
    if (first) this.recenter();
    // During the countdown the standing height is held; recenter 0.25 s before "go".
    this.gest.freeze(g.state === 'countdown');
    if (g.state === 'countdown') {
      const n = Math.ceil(g.countdown);
      this.hud.showMessage(n > 0 ? String(n) : 'GO', ['Stand tall · look straight ahead']);
      if (n !== this.lastCount) { this.lastCount = n; this.audio.play(n > 0 ? 'beep' : 'go'); }
      if (!this.goRecentered && g.countdown <= 0.25) { this.goRecentered = true; this.recenter(); }
    } else { this.goRecentered = false; this.lastCount = null; }

    if (ev) this._body(ev);
    this._controllers();
  }

  _body(ev) {
    const g = this.game, inp = this.input;
    if (g.state === 'over') { if (ev === 'jump') inp.push('bodyjump', 'body'); return; }
    if (g.state !== 'running') return;
    if (ev === 'jump') inp.push('jump', 'body');
    else if (ev === 'crouch') inp.push('roll', 'body');
    else if (ev.startsWith('left') || ev.startsWith('right')) {
      const dir = ev.startsWith('left') ? 'left' : 'right';
      inp.push(dir, 'body');
      if (ev.endsWith('2')) inp.push(dir, 'body');
    }
    this.hud.moveFlash(ev.replace('2', ''));
    this.audio.play('move');
  }

  _controllers() {
    const s = this.session;
    if (!s) return;
    for (const src of s.inputSources) {
      const gp = src.gamepad;
      if (!gp) continue;
      let st = this.pads.get(src);
      if (!st) { st = { b: [], ax: 0 }; this.pads.set(src, st); }
      const down = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.6));
      const edge = (i) => { const d = down(i), was = st.b[i]; st.b[i] = d; return d && !was; };
      if (edge(BTN.trigger) || edge(BTN.a)) this.input.push('jump', 'gamepad');
      if (edge(BTN.grip) || edge(BTN.b)) this.input.push('roll', 'gamepad');
      if (edge(BTN.stick)) this.recenter();
      const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
      if (st.ax === 0) {
        if (ax < -0.6) { st.ax = -1; this.input.push('left', 'gamepad'); }
        else if (ax > 0.6) { st.ax = 1; this.input.push('right', 'gamepad'); }
      } else if (Math.abs(ax) < 0.3) st.ax = 0;
    }
  }

  // The rig carries the head: calibrated forward -> down the track, calibrated
  // centre -> the runner's lane, standing eye height -> 1.62 m. The camera rises
  // only 0.55x of a jump (all of a climb), smoothed; no roll, bob or shake.
  updateCamera(dt, game) {
    const b = game.body;
    let feet = b.y;
    if (!b.grounded && b.jumped) feet = b.jumpFromY + (b.y - b.jumpFromY) * 0.55;
    this.feet = damp(this.feet, feet, b.grounded ? 9 : 12, dt);
    const base = this.gest.base != null ? this.gest.base : BODY.eyeH;
    const rig = this.view.rig;
    rig.quaternion.setFromAxisAngle(_up, -this.yaw0);
    _v.set(this.cx, 0, this.cz).applyQuaternion(rig.quaternion);
    rig.position.set(b.x - _v.x, this.feet + BODY.eyeH - base, game.world.z(b.s) - _v.z);
    // HUD panels hang around the standing head position, facing the calibrated
    // forward (which the rig turns down the track)
    this.hud.group.position.set(this.cx, base, this.cz);
    this.hud.group.quaternion.setFromAxisAngle(_up, this.yaw0);
    // comfort vignette
    const vx = Math.abs(b.x - (this._px ?? b.x)) / Math.max(dt, 1e-3);
    const vy = Math.abs(this.feet - (this._py ?? this.feet)) / Math.max(dt, 1e-3);
    this._px = b.x; this._py = this.feet;
    const want = game.settings.vignette && game.state === 'running' ? clamp(vx / 9 + Math.max(0, vy - 0.6) / 3, 0, 1) : 0;
    const u = this.vignette.material.uniforms.amount;
    u.value = damp(u.value, want, want > u.value ? 14 : 4, dt);
    this.vignette.visible = u.value > 0.01;
  }
}
