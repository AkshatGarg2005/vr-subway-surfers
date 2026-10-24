// Chasers after a stumble, the death animation and the game-over screen.
const { game } = window.__game;
game.test.autopilot = true; game.test.invincible = false; game.test.seed = 11;
game.setMode('screen'); game.startRun();
game.body.requestJump = () => false; // run into hurdles
let s1 = false, s2 = false;
const t0 = performance.now();
while (game.state !== 'over' && performance.now() - t0 < 60000) {
  await drive.frames(1);
  const r = game.run;
  if (!s1 && game.state === 'running' && r.stumbleT > 1.0 && r.chaseHold > 0) { s1 = true; await drive.shot('m3-chasers'); }
  if (!s2 && game.state === 'dying' && r.deathT > 0.5) { s2 = true; await drive.shot('m3-dying'); }
}
await drive.sleep(600);
await drive.shot('m3-gameover');
return { state: game.state, reason: game.run.reason };
