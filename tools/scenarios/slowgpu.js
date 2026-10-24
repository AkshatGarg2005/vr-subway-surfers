// Simulated slow GPU: each frame busy-waits in proportion to the pixel count,
// plus extra while bloom is on. The automatic quality must settle within ~10 s
// without bouncing. --arg mode=cardboard|screen --arg msPerMpx=24 --arg bloomMs=5 --arg seconds=60
const G = window.__game;
const { game, view } = G;
const mode = args.mode || 'cardboard';
game.test.autopilot = true; game.test.invincible = true; game.test.seed = 7;
view.slowGPU = { msPerMpx: Number(args.msPerMpx || 24), bloomMs: Number(args.bloomMs || 5) };
let stop = () => {};
if (mode === 'cardboard') { stop = drive.fakeSensors(); await drive.tap('#btnCardboard'); }
else await drive.tap('#btnPlay');
const t0 = performance.now();
const secs = Number(args.seconds || 60);
const times = [];
let last = performance.now();
while (performance.now() - t0 < secs * 1000) {
  await drive.frames(1);
  const now = performance.now();
  times.push([now - t0, now - last]); last = now;
}
stop();
const log = view.qualityLog.slice();
const changes = log.length;
const settledAt = changes ? log.filter((e) => e.change !== 'pixel ratio up')[log.filter((e) => e.change !== 'pixel ratio up').length - 1].t : 0;
const ups = log.filter((e) => e.change === 'pixel ratio up').length;
// frame stats in the last 15 s
const tail = times.filter(([t]) => t > (secs - 15) * 1000).map(([, d]) => d).sort((a, b) => a - b);
return {
  mode, slowGPU: view.slowGPU, startDpr: mode === 'cardboard' ? 1.5 : Math.min(2, window.devicePixelRatio),
  log, lastStepDownAt: settledAt, stepsUp: ups,
  final: { dpr: view.q.dpr, bloom: view.q.bloom, shafts: view.q.shafts },
  last15s: { fps: +(1000 * tail.length / tail.reduce((a, b) => a + b, 0)).toFixed(1), p50: +tail[Math.floor(tail.length / 2)].toFixed(1), p95: +tail[Math.floor(tail.length * 0.95)].toFixed(1) },
};
