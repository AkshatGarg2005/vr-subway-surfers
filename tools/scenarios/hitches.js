// Long frames during a run: when they happen and what was going on.
const { game, view } = window.__game;
game.test.autopilot = true; game.test.invincible = true; game.test.seed = Number(args.seed || 5);
await drive.tap('#btnPlay');
const secs = Number(args.seconds || 60);
const long = [];
let last = performance.now(), n = 0, worst = 0;
const t0 = last;
while (performance.now() - t0 < secs * 1000) {
  await drive.frames(1);
  const now = performance.now(), d = now - last; last = now; n++;
  worst = Math.max(worst, d);
  if (d > 25) long.push({ t: +((now - t0) / 1000).toFixed(2), ms: +d.toFixed(1), s: Math.round(game.body.s), obstacles: game.world.obstacles.length });
}
return { frames: n, worstMs: +worst.toFixed(1), over25: long.length, long: long.slice(0, 15), loadMs: window.__game.loadMs };
