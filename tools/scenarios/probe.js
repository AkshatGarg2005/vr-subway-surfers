// Ad-hoc probe: evaluates args.expr after a short autopilot run.
const G = window.__game;
const { game } = G;
game.test.autopilot = true; game.test.invincible = true; game.test.seed = 11;
game.setMode('screen'); game.startRun();
await drive.sleep(Number(args.wait || 3000));
return eval(args.expr || '0');
