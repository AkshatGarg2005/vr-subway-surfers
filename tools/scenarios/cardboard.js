// Phone VR run (use with --mobile): stereo cost per frame, draw calls and
// triangles per eye, frame timing, and a CPU profile of where JavaScript goes.
//   --arg seconds=40 --arg profile=1
const G = window.__game;
const { game, view, renderer } = G;
game.test.autopilot = true; game.test.invincible = true; game.test.seed = Number(args.seed || 7);
// A synthetic head: landscape phone looking down the track, gently looking around.
const stop = drive.fakeSensors((t) => ({ alpha: 25 * Math.sin(t * 0.37), beta: 3 * Math.sin(t * 0.6), gamma: -84 + 5 * Math.sin(t * 0.5) }));
await drive.tap('#btnCardboard');
while (game.state !== 'running') await drive.frames(1);
const secs = Number(args.seconds || 40);
const times = [];
const per = { total: [], eyeL: [], eyeR: [], trisL: [], trisR: [], totalTris: [] };
let last = performance.now();
const t0 = last;
let shot = false, prof = null;
if (args.profile) await drive.profileStart();
while (performance.now() - t0 < secs * 1000) {
  await drive.frames(1);
  const now = performance.now();
  times.push(now - last); last = now;
  const e = view.post.eyeStats;
  per.total.push(view.stats.calls); per.totalTris.push(view.stats.triangles);
  per.eyeL.push(e[0].calls); per.eyeR.push(e[1].calls);
  per.trisL.push(e[0].triangles); per.trisR.push(e[1].triangles);
  if (!shot && now - t0 > 8000) { shot = true; await drive.shot('cardboard'); }
}
if (args.profile) prof = await drive.profileStop();
stop();
times.shift();
const s = [...times].sort((a, b) => a - b);
const pct = (p) => +s[Math.floor(p * (s.length - 1))].toFixed(1);
const max = (a) => Math.max(...a), avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
return {
  dpr: view.q.dpr, canvas: [renderer.domElement.width, renderer.domElement.height],
  avgFps: +(1000 * times.length / times.reduce((a, b) => a + b, 0)).toFixed(1), p50ms: pct(0.5), p95ms: pct(0.95),
  over25ms: times.filter((x) => x > 25).length, over50ms: times.filter((x) => x > 50).length,
  drawCalls: { perStereoFrameMax: max(per.total), perStereoFrameAvg: avg(per.total), leftEyeWithShadowsMax: max(per.eyeL), rightEyeMax: max(per.eyeR), rightEyeAvg: avg(per.eyeR) },
  triangles: { perStereoFrameMax: max(per.totalTris), perStereoFrameAvg: avg(per.totalTris), leftEyeWithShadowsMax: max(per.trisL), rightEyeMax: max(per.trisR) },
  quality: view.qualityLog,
  profile: prof,
};
