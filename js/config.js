// Constants, tuning tables, platform detection and small helpers.
// This module must stay free of three.js and of DOM access at load time,
// because the Node test tools (tools/*.mjs) import it too.

export const TITLE = 'Metro Rush';

// ---------------------------------------------------------------- track
export const LANES = [-2.2, 0, 2.2];          // x of the three lanes (left, middle, right)
export const LANE_W = 2.2;
export const CHUNK_LEN = 40;                  // m per recycled track chunk
export const CHUNKS_AHEAD = 6;
export const CHUNKS_BEHIND = 1;
export const REBASE_EVERY = 600;              // floating origin shift (multiple of CHUNK_LEN)

// ---------------------------------------------------------------- body
export const BODY = {
  standH: 1.8,
  rollH: 0.85,
  halfW: 0.35,       // player half width (x)
  halfD: 0.3,        // player half depth (along the track)
  eyeH: 1.62,        // first-person eye height when standing
  rollEyeH: 0.82,
  fastFallVy: -17,
  stepUp: 0.25,      // highest ledge the feet snap onto
  coyote: 0.08,      // s after leaving a ledge when a jump still works
  jumpBuffer: 0.12,  // s a jump pressed just before landing is kept
};

// Per-mode physics. 'screen' = desktop and phone; 'vr' = phone VR and WebXR.
export const MODES = {
  screen: {
    name: 'screen',
    v0: 11, v1: 24, tau: 110,
    gravity: 40, jumpV: 12.6,               // peak ~2 m, 0.63 s in the air
    laneTime: 0.18, rollTime: 0.75,
    hintReady: 1.0, hintNow: 0.34,
    // planning values for the pattern generator (how fast a person reacts and moves)
    planReact: 0.35, planLane: 0.18,
    trainK: [0.45, 0.8],                    // moving train speed as a fraction of yours
    trainTrigger: 3.6,                      // s before the meeting point a parked train starts rolling
  },
  vr: {
    name: 'vr',
    v0: 3, v1: 5, tau: 110,
    gravity: 28, jumpV: 10.5,               // same ~2 m peak, 0.75 s in the air
    laneTime: 0.18, rollTime: 0.75,
    hintReady: 1.5, hintNow: 0.6,
    // Real body moves (step, jump, crouch) take longer than a key press.
    planReact: 1.0, planLane: 0.6,
    trainK: [0.35, 0.6],
    trainTrigger: 6,
  },
};

// VR speed presets (m/s, start -> top). 'normal' was tested comfortable in a phone headset.
export const VR_SPEEDS = {
  gentle: [2.5, 4],
  normal: [3, 5],
  brisk: [4, 6.5],
  fast: [5, 8],
};

export const SNEAKER_HEIGHT = 1.6;            // jump height multiplier with super sneakers

export function modeConfig(kind, vrSpeed = 'normal') {
  const base = MODES[kind === 'screen' ? 'screen' : 'vr'];
  if (base.name !== 'vr') return { ...base };
  const [v0, v1] = VR_SPEEDS[vrSpeed] || VR_SPEEDS.normal;
  return { ...base, v0, v1 };
}

export function speedAt(cfg, t) {
  return cfg.v0 + (cfg.v1 - cfg.v0) * (1 - Math.exp(-t / cfg.tau));
}

export function airTime(cfg, sneakers = false) {
  const v = cfg.jumpV * (sneakers ? Math.sqrt(SNEAKER_HEIGHT) : 1);
  return (2 * v) / cfg.gravity;
}

// ---------------------------------------------------------------- obstacles
// Collision volumes. x is measured from the lane centre; s runs along the track
// (front face first); y from the ground.
export const OBST = {
  hurdle: { halfW: 1.0, h: 0.6, d: 0.4 },
  barrier: { halfW: 1.0, y0: 1.1, y1: 2.6, d: 0.3 },
  wall: { halfW: 1.0, h: 3.4, d: 0.5 },
  train: { halfW: 1.0, h: 3.2, car: 12, coupler: 0.5 },
  ramp: { halfW: 1.0, len: 8 },
};
export const MARGIN = { x: 0.15, s: 0.06, y: 0.06 };  // forgiveness: volumes shrink by this much
export const ROOF_Y = OBST.train.h;

export function trainLength(cars) {
  return cars * OBST.train.car + (cars - 1) * OBST.train.coupler;
}

// ---------------------------------------------------------------- rules
export const RULES = {
  stumbleSlow: 0.55,       // speed multiplier right after a stumble
  stumbleRecover: 1.2,     // s to get back to full speed
  stumbleWindow: 7,        // a second stumble within this many seconds ends the run
  chaseNear: 1.4,          // m behind you after a stumble (the dog; the warden is a step further back)
  chaseFar: 22,            // m behind you normally
  chaseHold: 5,            // s the chasers stay close after a stumble
  multEvery: 750,          // m per multiplier step
  coinScore: 5,
  invulnAfterShield: 1.0,
  deathAnim: 1.4,
  restartDelay: 1.5,       // s before a VR jump can restart from game over
};

export const POWERUPS = {
  magnet: { time: 12, color: 0xff3b5c, label: 'Magnet' },
  double: { time: 15, color: 0x39d7ff, label: '2× Score' },
  sneakers: { time: 20, color: 0x7cff4f, label: 'Sneakers' },
  shield: { time: 0, color: 0xffc23d, label: 'Board' },
};
export const MAGNET_RANGE = 9;

// ---------------------------------------------------------------- input
export const INPUT = {
  swipeMinPx: 26,
  swipeFrac: 0.045,         // of the short screen side
  tapMs: 350,
  tapPx: 20,
  longPressMs: 700,
};

// WebXR head-height gestures
export const XR_GESTURE = {
  laneOffset: 0.25,         // m from calibrated centre
  laneHyst: 0.08,
  jumpVy: 0.9,              // m/s upward head speed
  jumpRise: 0.04,           // m above base
  crouchDrop: 0.28,         // m below base
  rearm: 0.12,
};

// ---------------------------------------------------------------- rendering
export const RENDER = {
  maxDprScreen: 2,
  maxDprCardboard: 1.7,
  startDprCardboard: 1.5,
  msaaBelowDpr: 1.5,
  shadowRange: 24,
  shadowMapSize: 2048,
  fovScreen: 68,
  fovCardboard: 82,
  eyeSep: 0.064,
  bloom: { strength: 0.66, radius: 0.6, threshold: 0.9 },
};

// ---------------------------------------------------------------- platform
const nav = typeof navigator !== 'undefined' ? navigator : null;
const win = typeof window !== 'undefined' ? window : null;
const ua = nav ? nav.userAgent || '' : '';
export const PLATFORM = {
  isIOS: !!nav && (/iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)),
  isAndroid: /Android/i.test(ua),
  touch: !!win && ('ontouchstart' in win || (nav && nav.maxTouchPoints > 0)),
  secure: !!win && win.isSecureContext,
  reducedMotion: !!win && !!win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches,
};
PLATFORM.mobile = PLATFORM.isIOS || PLATFORM.isAndroid || /Mobi/i.test(ua);

// ---------------------------------------------------------------- helpers
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// Frame-rate independent exponential approach.
export const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));

// Small, fast, seedable RNG (mulberry32).
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  return rng;
}

// Mix a seed with an integer (chunk index, etc.) into a new seed.
export function hashSeed(a, b = 0) {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (b + 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 16)) >>> 0;
}

// localStorage, with every access wrapped: private windows and blocked storage throw.
export const store = {
  get(key, def) {
    try {
      const raw = win && win.localStorage.getItem('metrorush.' + key);
      return raw == null ? def : JSON.parse(raw);
    } catch {
      return def;
    }
  },
  set(key, val) {
    try {
      win && win.localStorage.setItem('metrorush.' + key, JSON.stringify(val));
    } catch {
      /* storage unavailable: settings just won't persist */
    }
  },
};

export const DEFAULT_SETTINGS = {
  sound: true,
  hints: true,
  camera: 'chase',        // 'chase' | 'fp'
  sensitivity: 'normal',  // body sensing: 'low' | 'normal' | 'high'
  vrSpeed: 'normal',
  vignette: true,         // comfort vignette in VR
};

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(store.get('settings', {}) || {}) };
  if (!VR_SPEEDS[s.vrSpeed]) s.vrSpeed = 'normal';
  return s;
}
export function saveSettings(s) {
  store.set('settings', s);
}

// Query string flags (?debug, ?seed=, ?test, ...)
export const QUERY = (() => {
  const q = {};
  if (!win) return q;
  for (const [k, v] of new URLSearchParams(win.location.search)) q[k] = v === '' ? true : v;
  return q;
})();
