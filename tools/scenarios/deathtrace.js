// What the autopilot saw in the 3 s before it crashed (debugging aid).
//   --arg mode=screen|xr --arg seed=4
const G = window.__game;
const { game, view, renderer, xr, hud } = G;
const mode = args.mode || 'screen';
game.test.autopilot = true; game.test.invincible = false; game.test.seed = Number(args.seed || 4);
if (mode === 'xr') {
  renderer.xr.updateCamera = (cam) => { cam.position.set(0, 1.7, 0); cam.quaternion.identity(); cam.updateMatrixWorld(); };
  xr.session = { inputSources: [], end: async () => {}, addEventListener() {} };
  xr.active = true; view.setMode('xr'); game.setMode('xr'); game.vr = xr; hud.show(true); xr.gest.reset();
}
game.startRun();
const hist = [];
let hitOb = null;
game.on('die', () => {});
const orig = game._crash.bind(game);
game._crash = (ob) => { hitOb = ob; orig(ob); };
const t0 = performance.now();
while (performance.now() - t0 < 90000 && game.state !== 'dying' && game.state !== 'over') {
  await drive.frames(1);
  const b = game.body;
  hist.push({ t: +game.run.t.toFixed(2), s: +b.s.toFixed(1), lane: b.lane, x: +b.x.toFixed(2), y: +b.y.toFixed(2), v: +game.run.speed.toFixed(2) });
  if (hist.length > 240) hist.shift();
}
const b = game.body;
const near = game.world.obstacles.filter((o) => { const s0 = o.moving ? Math.min(o.moving.sStart, o.moving.sMeet + o.moving.k * (o.moving.sMeet - b.s)) : o.s0; return s0 < b.s + 40 && s0 + o.len > b.s - 30; })
  .map((o) => `${o.kind}${o.moving ? '(moving k ' + o.moving.k.toFixed(2) + ' meet ' + o.moving.sMeet.toFixed(1) + ')' : ''}${o.ramp ? '(ramp)' : ''} lane ${o.lane} s0 ${o.s0.toFixed(1)} len ${o.len.toFixed(1)}`);
const changes = [];
for (let i = 1; i < hist.length; i++) if (hist[i].lane !== hist[i - 1].lane) changes.push(`${hist[i].t}s s=${hist[i].s} lane ${hist[i - 1].lane}->${hist[i].lane}`);
return { died: game.state, s: +b.s.toFixed(1), lane: b.lane, hit: hitOb && `${hitOb.kind} lane ${hitOb.lane} s0 ${hitOb.s0.toFixed(1)}${hitOb.moving ? ' moving meet ' + hitOb.moving.sMeet.toFixed(1) : ''}${hitOb.ramp ? ' ramp' : ''}`, laneChanges: changes, near, last: hist.slice(-6) };
