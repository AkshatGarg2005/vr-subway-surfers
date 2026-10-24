// Autopilot run: frame timing, quality changes, deaths.
//   --arg seconds=60  --arg invincible=false  --arg shots=1
const G = window.__game;
const { game, view, renderer } = G;
const secs = Number(args.seconds || 60);
game.test.autopilot = true;
game.test.invincible = args.invincible !== 'false';
if (args.seed) game.test.seed = Number(args.seed);
game.setMode('screen');
game.startRun();
const times = [];
let runs = 1, deaths = [], maxDist = 0, coins = 0;
let last = performance.now();
const t0 = last;
let shotAt = 10000;
await new Promise((resolve) => {
  const tick = async () => {
    const now = performance.now();
    times.push(now - last);
    last = now;
    if (game.state === 'over') {
      deaths.push({ t: +((now - t0) / 1000).toFixed(1), dist: Math.floor(game.run.s), reason: game.run.reason });
      maxDist = Math.max(maxDist, game.run.s); coins += game.run.coins;
      game.startRun(); runs++;
    }
    if (args.shots && now - t0 > shotAt) { shotAt += 15000; drive.shot('autopilot-' + Math.round((now - t0) / 1000) + 's'); }
    if (now - t0 < secs * 1000) requestAnimationFrame(tick); else resolve();
  };
  requestAnimationFrame(tick);
});
if (game.run) { maxDist = Math.max(maxDist, game.run.s); coins += game.run.coins; }
times.shift();
const sorted = [...times].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const total = times.reduce((a, b) => a + b, 0);
renderer.info.autoReset = true;
return {
  seconds: secs, frames: times.length,
  avgFps: +(1000 * times.length / total).toFixed(1),
  p50ms: +pct(0.5).toFixed(2), p95ms: +pct(0.95).toFixed(2), p99ms: +pct(0.99).toFixed(2), maxMs: +sorted[sorted.length - 1].toFixed(1),
  over25ms: times.filter((t) => t > 25).length, over50ms: times.filter((t) => t > 50).length,
  runs, deaths: deaths.slice(0, 20), maxDist: Math.floor(maxDist), coins,
  dpr: view.dpr, drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
  quality: view.qualityLog || [],
  speed: game.run ? +game.run.speed.toFixed(2) : 0,
};
