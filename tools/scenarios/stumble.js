// Stumble rules: hitting a hurdle stumbles you and brings the chasers close;
// a second stumble within 7 s ends the run ("caught").
const { game } = window.__game;
game.test.autopilot = true; game.test.invincible = false; game.test.seed = 11;
game.setMode('screen'); game.startRun();
const body = game.body;
body.requestJump = () => false; // never jump: run into hurdles
const log = [];
game.on('stumble', (why) => log.push({ ev: 'stumble', why, t: +game.run.t.toFixed(2), gap: +game.run.chaseGap.toFixed(1) }));
game.on('die', (r) => log.push({ ev: 'die', kind: r.deathKind, reason: r.reason, t: +r.t.toFixed(2) }));
let minGap = 99, shot = false;
const t0 = performance.now();
while (game.state !== 'over' && performance.now() - t0 < 60000) {
  await drive.frames(1);
  if (game.run) minGap = Math.min(minGap, game.run.chaseGap);
  if (!shot && game.run && game.run.stumbleT > 0.8 && game.run.stumbleT < 1 && game.run.chaseHold > 0) { shot = true; await drive.shot('m2-stumble-chasers'); }
}
return { log, minGap: +minGap.toFixed(2), state: game.state, reason: game.run && game.run.reason };
