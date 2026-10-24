// Keyboard, swipes, taps, long-press, gamepad, and the phone's orientation and
// motion sensors. Everything becomes a queued action that the game reads once
// per frame: 'left' 'right' 'jump' 'roll' 'pause' 'tap' 'longpress' 'recenter' 'confirm'.
import { INPUT } from './config.js';

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'jump', KeyW: 'jump', Space: 'jump',
  ArrowDown: 'roll', KeyS: 'roll',
  KeyP: 'pause', Escape: 'pause',
  Enter: 'confirm',
};

// Standard gamepad mapping
const PAD_BUTTONS = { 0: 'jump', 1: 'roll', 2: 'roll', 3: 'jump', 12: 'jump', 13: 'roll', 14: 'left', 15: 'right', 9: 'pause', 8: 'recenter', 10: 'recenter' };

export class Input {
  constructor(target) {
    this.target = target;
    this.queue = [];
    this.out = [];
    this.vr = false;           // long-press only works in VR
    this.enabled = true;
    this.lastSource = 'keyboard';
    this.touch = null;         // active pointer gesture
    this.padPrev = new Map();  // gamepad index -> { buttons: [], ax: 0 }
    this.padSeen = false;
    // sensors
    this.orient = { alpha: 0, beta: 90, gamma: 0, valid: false, t: 0, count: 0 };
    this.screenAngle = 0;
    this.motionCount = 0;
    this.lastMotionT = 0;
    this.onMotion = null;      // (event, now) => void, set by the game in phone VR
    this.sensorsOn = false;

    this._onKey = this._onKey.bind(this);
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onOrient = this._onOrient.bind(this);
    this._onDeviceMotion = this._onDeviceMotion.bind(this);
    this._onScreen = this._onScreen.bind(this);

    window.addEventListener('keydown', this._onKey);
    target.addEventListener('pointerdown', this._onDown, { passive: false });
    window.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
    window.addEventListener('gamepadconnected', () => { this.padSeen = true; });
    this._onScreen();
    if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener('change', this._onScreen);
    window.addEventListener('orientationchange', this._onScreen);
  }

  push(a, source) {
    if (!this.enabled) return;
    this.queue.push(a);
    if (source) this.lastSource = source;
  }

  // Look at queued actions without taking them.
  peek() { return this.queue; }

  // Actions since the last call (the returned array is reused).
  take() {
    const out = this.out;
    out.length = 0;
    for (let i = 0; i < this.queue.length; i++) out.push(this.queue[i]);
    this.queue.length = 0;
    return out;
  }

  // ------------------------------------------------------------ keyboard
  _onKey(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    const a = KEYMAP[e.code];
    if (!a) return;
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    if (e.repeat && a !== 'pause') return;
    this.push(a, 'keyboard');
  }

  // ------------------------------------------------------------ touch / swipe
  swipeThreshold() {
    const short = Math.min(window.innerWidth, window.innerHeight);
    return Math.max(INPUT.swipeMinPx, short * INPUT.swipeFrac);
  }

  _onDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.cancelable) e.preventDefault();
    this.touch = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), fired: false, moved: 0, long: false, type: e.pointerType };
  }

  _onMove(e) {
    const t = this.touch;
    if (!t || e.pointerId !== t.id) return;
    const dx = e.clientX - t.x, dy = e.clientY - t.y;
    t.moved = Math.max(t.moved, Math.hypot(dx, dy));
    if (t.fired || t.long) return;
    const th = this.swipeThreshold();
    if (Math.abs(dx) < th && Math.abs(dy) < th) return;
    // Fire as soon as the threshold is crossed, not on release: feels instant.
    t.fired = true;
    if (Math.abs(dx) > Math.abs(dy)) this.push(dx < 0 ? 'left' : 'right', 'touch');
    else this.push(dy < 0 ? 'jump' : 'roll', 'touch');
  }

  _onUp(e) {
    const t = this.touch;
    if (!t || e.pointerId !== t.id) return;
    this.touch = null;
    if (t.fired || t.long) return;
    if (performance.now() - t.t < INPUT.tapMs && t.moved < INPUT.tapPx) this.push('tap', t.type === 'mouse' ? 'mouse' : 'touch');
  }

  // ------------------------------------------------------------ per-frame polling
  poll() {
    // Long-press (VR only, so slow swipes on a normal screen are never swallowed).
    const t = this.touch;
    if (this.vr && t && !t.fired && !t.long && t.moved < INPUT.tapPx && performance.now() - t.t > INPUT.longPressMs) {
      t.long = true;
      this.push('longpress', 'touch');
    }
    this._pollPads();
  }

  _pollPads() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      this.padSeen = true;
      let st = this.padPrev.get(p.index);
      if (!st) { st = { buttons: new Array(p.buttons.length).fill(true), ax: 0, ay: 0 }; this.padPrev.set(p.index, st); }
      for (let b = 0; b < p.buttons.length; b++) {
        const down = p.buttons[b].pressed || p.buttons[b].value > 0.5;
        if (down && !st.buttons[b] && PAD_BUTTONS[b]) this.push(PAD_BUTTONS[b], 'gamepad');
        st.buttons[b] = down;
      }
      // Left stick: edge-detected with hysteresis.
      const ax = p.axes[0] || 0, ay = p.axes[1] || 0;
      if (st.ax === 0) {
        if (ax < -0.6) { st.ax = -1; this.push('left', 'gamepad'); }
        else if (ax > 0.6) { st.ax = 1; this.push('right', 'gamepad'); }
      } else if (Math.abs(ax) < 0.3) st.ax = 0;
      if (st.ay === 0) {
        if (ay < -0.75) { st.ay = -1; this.push('jump', 'gamepad'); }
        else if (ay > 0.75) { st.ay = 1; this.push('roll', 'gamepad'); }
      } else if (Math.abs(ay) < 0.3) st.ay = 0;
    }
  }

  // ------------------------------------------------------------ sensors
  _onScreen() {
    const so = screen.orientation;
    this.screenAngle = so && typeof so.angle === 'number' ? so.angle : (typeof window.orientation === 'number' ? window.orientation : 0);
  }

  // Must be called from inside a tap handler (iOS asks for permission there).
  // Both requests are made together so the user sees one prompt flow.
  requestSensors() {
    const reqs = [];
    const DOE = window.DeviceOrientationEvent, DME = window.DeviceMotionEvent;
    if (DOE && typeof DOE.requestPermission === 'function') reqs.push(DOE.requestPermission().catch(() => 'denied'));
    if (DME && typeof DME.requestPermission === 'function') reqs.push(DME.requestPermission().catch(() => 'denied'));
    this.startSensors();
    return Promise.all(reqs).then((r) => r.every((x) => x === 'granted'));
  }

  startSensors() {
    if (this.sensorsOn) return;
    this.sensorsOn = true;
    window.addEventListener('deviceorientation', this._onOrient);
    window.addEventListener('devicemotion', this._onDeviceMotion);
  }

  stopSensors() {
    if (!this.sensorsOn) return;
    this.sensorsOn = false;
    window.removeEventListener('deviceorientation', this._onOrient);
    window.removeEventListener('devicemotion', this._onDeviceMotion);
  }

  _onOrient(e) {
    if (e.alpha == null && e.beta == null) return;
    const o = this.orient;
    o.alpha = e.alpha || 0; o.beta = e.beta || 0; o.gamma = e.gamma || 0;
    o.valid = true;
    o.t = performance.now();
    o.count++;
  }

  _onDeviceMotion(e) {
    const now = performance.now();
    this.motionCount++;
    this.lastMotionT = now;
    if (this.onMotion) this.onMotion(e, now);
  }
}
