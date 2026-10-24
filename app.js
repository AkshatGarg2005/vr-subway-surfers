// Metro Rush — bootstrap and main loop.
import * as THREE from 'three';
import { loadSettings, QUERY, clamp } from './js/config.js';
import { buildTextures, setAnisotropy } from './js/textures.js';
import { createMaterials } from './js/materials.js';
import { trainBodyGeometry, TRAIN } from './js/builders.js';
import { World } from './js/world.js';
import { Input } from './js/input.js';
import { Game } from './js/game.js';
import { View } from './js/render.js';
import { Atmosphere } from './js/atmosphere.js';
import { Characters } from './js/characters.js';
import { Particles } from './js/particles.js';
import { Audio } from './js/audio.js';
import { UI } from './js/ui.js';
import { Hud3D } from './js/hud3d.js';
import { PhoneVR } from './js/vr.js';
import { DebugOverlay } from './js/sensing.js';
import { XRMode } from './js/xr.js';
import { AutoQuality } from './js/quality.js';

const settings = loadSettings();
const canvas = document.getElementById('game');

async function boot() {
  const loadT0 = performance.now();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  // Direct rendering (WebXR) uses these; the post-processing path does its own grade.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  setAnisotropy(renderer.capabilities.getMaxAnisotropy());

  // The AudioContext is made now (suspended) so the first tap doesn't pay for it.
  const audio = new Audio();
  audio.setEnabled(settings.sound);

  const scene = new THREE.Scene();
  const view = new View(renderer, scene);
  view.quality = new AutoQuality(view);
  const atmosphere = new Atmosphere(scene, renderer);

  const loadUI = {
    bar: document.getElementById('loadbar'),
    msg: document.getElementById('loadmsg'),
  };
  const progress = (f, label) => {
    loadUI.bar.style.width = Math.round(f * 85) + '%';
    if (label) loadUI.msg.textContent = 'Painting ' + label.replace(/\d+$/, '').trim() + '…';
  };
  trainBodyGeometry().dispose(); // fills in the train profile the livery painter needs
  const tex = await buildTextures(TRAIN.profileAcc, progress);
  loadUI.msg.textContent = 'Building the rail yard…';
  await new Promise((r) => setTimeout(r, 0));

  const mats = createMaterials(tex);
  atmosphere.buildEnvironment();
  const world = new World(scene, mats);
  atmosphere.buildSkyline(tex, world);
  const input = new Input(canvas);
  const chars = new Characters(scene);
  const particles = new Particles(scene);
  view.particles = particles;
  world.onRebase = (dz) => { particles.shiftZ(dz); atmosphere.shiftZ(dz); };

  const game = new Game({ scene, view, world, input, audio, chars, particles, settings });
  const firstGesture = () => audio.resume();
  window.addEventListener('pointerdown', firstGesture, { passive: true });
  window.addEventListener('keydown', firstGesture);

  const hud = new Hud3D(view.rig, view.camera);
  let phoneVR = null, xr = null;
  const toScreen = () => {
    if (phoneVR && phoneVR.active) phoneVR.exit();
    if (xr && xr.active) xr.exit();
    view.setMode('screen');
    game.setMode('screen');
    game.vr = null;
  };
  const ui = new UI(game, settings, {
    play: () => { audio.resume(); toScreen(); game.startRun(); },
    cardboard: () => {
      audio.resume();
      phoneVR.enter(); // first thing in the tap: iOS only asks for sensor access here
      view.setMode('cardboard');
      game.setMode('cardboard');
      game.vr = phoneVR;
      phoneVR.sensing.motion.enabled = true;
      phoneVR.startRun();
    },
    xr: () => {
      audio.resume();
      if (phoneVR.active) phoneVR.exit();
      xr.enter().then((ok) => { if (!ok) toScreen(); });
    },
    quit: () => { game.quit(); toScreen(); },
    again: () => { if (game.state === 'over') game.startRun(); },
    recenter: () => { if (game.vr) game.vr.recenter(); },
    recalibrate: () => { if (game.mode === 'cardboard') phoneVR.recalibrate(); },
    noSensing: () => phoneVR.playWithoutSensing(),
    sensorRetry: () => phoneVR.retrySensors(),
    settingsChanged: (k) => {
      if (k === 'sound') audio.setEnabled(settings.sound);
      if (k === 'sensitivity') phoneVR.sensing.setSensitivity(settings.sensitivity);
    },
  });
  game.ui = ui;
  phoneVR = new PhoneVR({ game, view, input, hud, audio, ui, settings });
  xr = new XRMode({ renderer, view, game, input, hud, audio, ui, settings });
  xr.onExit = () => { game.quit(); toScreen(); };
  XRMode.supported().then((ok) => ui.showXRButton(ok));
  const debug = QUERY.debug ? new DebugOverlay(document.getElementById('debug'), phoneVR.sensing, view) : null;
  game.on('recenter', () => { if (game.vr) game.vr.recenter(); });
  // VR HUD messages for the moments the normal-screen UI shows as DOM.
  game.on('go', () => hud.hideMessage());
  game.on('resume', () => hud.hideMessage());
  game.on('pause', () => { if (game.isVR) hud.showMessage('Paused', ['Resume on the screen', 'or press the gamepad A button']); });
  game.on('over', (r) => {
    if (!game.isVR) return;
    hud.showMessage(r.newBest ? 'New best!' : 'Busted!', [r.reason || '', `Score ${Math.floor(r.score).toLocaleString()} · ${r.coins} coins`, 'Get ready…'], r.newBest ? '#ff3b7f' : '#ff7a1a');
    setTimeout(() => {
      if (game.state === 'over' && game.isVR) hud.showMessage(r.newBest ? 'New best!' : 'Busted!', [r.reason || '', `Score ${Math.floor(r.score).toLocaleString()} · ${r.coins} coins`, 'Jump to run again']);
    }, 1500);
  });
  game.on('start', () => audio.setInRun(true));
  game.on('over', () => audio.setInRun(false));
  game.on('menu', () => { game.menuWorld = false; audio.setInRun(false); });
  game.on('menuConfirm', () => ui.h.play());
  game.on('stumble', () => chars.stumble());

  window.__game = { game, renderer, view, input, world, scene, atmosphere, settings, audio, chars, particles, tex, hud, phoneVR, xr };

  // Compile every shader before the loading screen goes away: put one instance
  // in every pool (in view and inside the shadow frustum), show everything that
  // is normally hidden, render a full frame (shadows + post) and a direct frame
  // (the WebXR path uses tone-mapped variants), then put it all back.
  game.update(0);
  atmosphere.update(0, view.camera, 0, 0);
  {
    const temps = [];
    const pools = world.poolList.concat(atmosphere.skyPools || []);
    const z = world.z(game.body.s) - 9;
    for (const p of pools) { const i = p.alloc(); if (i >= 0) { p.setTRS(i, 0, 0.3, z); temps.push([p, i]); } }
    world.flush(); atmosphere.flush();
    particles.sparkle(0, 1, z + 3, 4); particles.dust(0, 0, z + 3, 4); particles.update(0.016);
    const vis = [chars.player, chars.wardenG, chars.dog.root].map((o) => [o, o.visible]);
    for (const [o] of vis) o.visible = true;
    hud.show(true);
    for (const panel of [hud.score, hud.flash, hud.message, hud.hint]) panel.visible = true;
    renderer.compile(scene, view.camera);
    view.render(0);
    renderer.setRenderTarget(null);
    renderer.render(scene, view.camera);
    for (const [p, i] of temps) p.free(i);
    world.flush(); atmosphere.flush();
    particles.clear();
    for (const [o, v] of vis) o.visible = v;
    for (const panel of [hud.score, hud.flash, hud.message, hud.hint]) panel.visible = false;
    hud.show(false);
  }
  loadUI.bar.style.width = '100%';

  let last = performance.now();
  const frame = () => {
    const now = performance.now();
    view.quality.sample(now - last);
    const dt = clamp((now - last) / 1000, 0, 1 / 20);
    last = now;
    input.poll();
    if (phoneVR.active) phoneVR.update(dt);
    if (xr.active) xr.update(dt);
    game.update(dt);
    if (game.isVR) hud.update(dt, game);
    atmosphere.update(dt, view.camera, game.body.x, game.body.s);
    atmosphere.flush();
    const r = game.run;
    const running = game.state === 'running';
    view.fx.speed = running && r ? clamp((r.speed - game.cfg.v0) / (game.cfg.v1 - game.cfg.v0), 0, 1) * 0.6 + 0.15 : 0;
    view.fx.flash = r ? r.flash : 0;
    view.render(dt);
    ui.update();
    if (debug) debug.update(dt);
  };
  renderer.setAnimationLoop(frame);

  window.__game.loadMs = Math.round(performance.now() - loadT0);
  ui.showTitle();
  window.__game.ready = true;
  if (QUERY.autostart) ui.h.play();
}

boot().catch((e) => {
  console.error(e);
  const m = document.getElementById('loadmsg');
  if (m) m.textContent = 'Something went wrong: ' + e.message;
});
