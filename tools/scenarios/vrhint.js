// Phone VR: the "Step left / right" cue when a train or tall barrier blocks your lane.
const { game, view } = window.__game;
game.test.autopilot = false; game.test.invincible = true; game.test.seed = Number(args.seed || 4);
const stop = drive.fakeSensors(() => ({ alpha: 0, beta: 0, gamma: -84 }));
await drive.tap('#btnCardboard');
const t0 = performance.now();
let got = null;
while (performance.now() - t0 < 60000) {
  await drive.frames(1);
  const h = game.hint;
  if ((h.kind === 'left' || h.kind === 'right') && h.phase === 'now') { got = { kind: h.kind, tta: +h.tta.toFixed(2), ob: h.ob.kind }; break; }
}
await drive.shot('vr-step-hint');
stop();
return { got, s: Math.round(game.body.s) };
