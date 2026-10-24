// Play for a while in one mode (autopilot, real deaths and restarts) and report.
// The driver prints every console error/warning. --arg mode=screen|cardboard|xr --arg seconds=180
const G = window.__game;
const { game, view, renderer, xr, hud } = G;
const mode = args.mode || 'screen';
game.test.autopilot = true; game.test.invincible = false;
let stop = () => {};
if (mode === 'cardboard') { stop = drive.fakeSensors((t) => ({ alpha: 15 * Math.sin(t * 0.3), beta: 0, gamma: -86 + 3 * Math.sin(t * 0.4) })); await drive.tap('#btnCardboard'); }
else if (mode === 'xr') {
  const head = { x: 0, y: 1.7, z: 0 };
  renderer.xr.updateCamera = (cam) => { cam.position.set(head.x + 0.01 * Math.sin(performance.now() / 700), head.y, head.z); cam.quaternion.identity(); cam.updateMatrixWorld(); };
  xr.session = { inputSources: [], end: async () => {}, addEventListener() {} };
  xr.active = true; view.setMode('xr'); game.setMode('xr'); game.vr = xr; hud.show(true); xr.gest.reset();
  game.startRun();
} else await drive.tap('#btnPlay');
const secs = Number(args.seconds || 180);
const t0 = performance.now();
let runs = 1, deaths = [], frames = 0, worst = 0, last = performance.now(), maxDist = 0, coins = 0;
while (performance.now() - t0 < secs * 1000) {
  await drive.frames(1);
  const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++;
  if (game.state === 'over' && game.run.overT > 0.6) {
    deaths.push(`${Math.floor(game.run.s)} m: ${game.run.reason}`);
    maxDist = Math.max(maxDist, game.run.s); coins += game.run.coins;
    game.startRun(); runs++;
  }
}
stop();
if (game.run) { maxDist = Math.max(maxDist, game.run.s); coins += game.run.coins; }
return { mode, seconds: secs, frames, avgFps: +(frames / secs).toFixed(1), worstFrameMs: +worst.toFixed(1), runs, deaths: deaths.slice(0, 12), maxDist: Math.floor(maxDist), coins, quality: view.qualityLog };
