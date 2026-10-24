// Screenshots for reviewing the look: title, and a few moments of a run.
//   --arg prefix=look
const { game, view } = window.__game;
const p = args.prefix || 'look';
await drive.frames(20);
await drive.shot(p + '-title');
game.test.autopilot = true; game.test.invincible = true; game.test.seed = Number(args.seed || 5);
game.settings.camera = args.camera || 'chase';
view.setMode('screen'); game.setMode('screen'); game.startRun();
const shots = (args.at || '3,9,16').split(',').map(Number);
const t0 = performance.now();
for (const t of shots) {
  while (performance.now() - t0 < t * 1000) await drive.frames(1);
  await drive.shot(`${p}-run-${t}s`);
}
return { loadMs: window.__game.loadMs, calls: view.stats.calls, tris: view.stats.triangles, dpr: view.q.dpr, msaa: view.msaaSamples };
