// Autopilot survival on fixed seeds (deaths allowed), and how long a restart takes.
//   --arg mode=screen|xr --arg seeds=1,2,3 --arg seconds=60
const G = window.__game;
const { game, view, renderer, xr, hud } = G;
const mode = args.mode || 'screen';
game.test.autopilot = true; game.test.invincible = false;
if (mode === 'xr') {
  renderer.xr.updateCamera = (cam) => { cam.position.set(0, 1.7, 0); cam.quaternion.identity(); cam.updateMatrixWorld(); };
  xr.session = { inputSources: [], end: async () => {}, addEventListener() {} };
  xr.active = true; view.setMode('xr'); game.setMode('xr'); game.vr = xr; hud.show(true); xr.gest.reset();
} else { view.setMode('screen'); game.setMode('screen'); }
const out = [];
for (const seed of String(args.seeds || '1,2,3').split(',').map(Number)) {
  game.test.seed = seed;
  const a = performance.now();
  game.startRun();
  const restartMs = +(performance.now() - a).toFixed(1);
  let worst = 0, last = performance.now();
  const t0 = performance.now();
  while (performance.now() - t0 < Number(args.seconds || 60) * 1000 && game.state !== 'over' && game.state !== 'dying') {
    await drive.frames(1);
    const now = performance.now(); worst = Math.max(worst, now - last); last = now;
  }
  out.push({ seed, restartMs, died: game.state !== 'running' && game.state !== 'countdown', at: Math.floor(game.body.s), reason: game.run.reason || '', worstFrame: +worst.toFixed(1) });
}
return { mode, results: out };
