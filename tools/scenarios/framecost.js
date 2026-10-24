// Frozen frame with the sun in view: what each part costs, each part switched
// off on its own. "frame ms" is throughput: 40 frames rendered back to back with
// one GPU sync at the end (the steady-state cost of a frame). "GPU ms" is from
// timer queries (relative only: ANGLE/Metal timer queries read high when idle).
// Use with --uncapped.
const G = window.__game;
const { game, view, renderer, world, atmosphere, chars, scene } = G;
game.test.autopilot = true; game.test.invincible = true; game.test.seed = Number(args.seed || 5);
await drive.tap('#btnPlay');
// run until the sun is well in view and trains are on screen
const t0 = performance.now();
while (performance.now() - t0 < 25000) {
  await drive.frames(1);
  const trains = world.obstacles.filter((o) => o.kind === 'train' && o.s0 - game.body.s < 60 && o.s0 + o.len > game.body.s).length;
  if (view.sunVis > 0.8 && trains >= 2 && performance.now() - t0 > 4000) break;
}
renderer.setAnimationLoop(null); // freeze
await drive.shot('framecost-frame');
const gl = renderer.getContext();
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const N = Number(args.frames || 60);
const tick = () => new Promise((r) => setTimeout(r, 0));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
// GPU time per frame from timer queries (CPU time = submitting the frame).
const px1 = new Uint8Array(4);
const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
async function throughput(renderFn, K = 40) {
  const runs = [];
  for (let r = 0; r < 3; r++) {
    sync();
    const a = performance.now();
    for (let i = 0; i < K; i++) renderFn();
    sync();
    runs.push((performance.now() - a) / K);
    await tick();
  }
  return +Math.min(...runs).toFixed(2);
}
async function timeFrames(renderFn) {
  for (let i = 0; i < 10; i++) { renderFn(); await tick(); } // warm up (shader variants, buffers)
  const frame = await throughput(renderFn);
  for (let attempt = 0; attempt < 3; attempt++) {
    const qs = [], cpu = [];
    for (let i = 0; i < N; i++) {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      const a = performance.now();
      renderFn();
      cpu.push(performance.now() - a);
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      qs.push(q);
      if (i % 3 === 2) await tick();
    }
    while (!gl.getQueryParameter(qs[qs.length - 1], gl.QUERY_RESULT_AVAILABLE)) await tick();
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    const gpu = qs.map((q) => gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    qs.forEach((q) => gl.deleteQuery(q));
    if (!disjoint) return { frame, gpu: +median(gpu).toFixed(2), cpu: +median(cpu).toFixed(2) };
  }
  return { frame, gpu: NaN, cpu: NaN };
}
const measure = () => timeFrames(() => view.render(0));
const P = world.pools;
const group = (names) => world.poolList.filter((p) => names.some((n) => p.mesh.name.startsWith(n))).map((p) => p.mesh);
const toggle = (objs, on) => objs.forEach((o) => (o.visible = on));
const rows = [];
const base = await measure();
rows.push(['everything on (pixel ratio ' + view.q.dpr + ')', base]);
const variant = async (name, off, on) => { off(); const ms = await measure(); on(); rows.push([name, ms]); };
await variant('no sky', () => toggle([atmosphere.sky], false), () => toggle([atmosphere.sky], true));
const track = group(['ballast', 'ground', 'sleeper', 'rail', 'sideSleeper', 'sideRail']);
await variant('no track (ballast, sleepers, rails)', () => toggle(track, false), () => toggle(track, true));
const trains = group(['trainBody', 'trainUnder', 'headlight']);
await variant('no trains', () => toggle(trains, false), () => toggle(trains, true));
const side = group(['wall', 'fence', 'mast', 'wire', 'gantry', 'signal', 'cabinet', 'drum', 'barrel', 'lampPost', 'shed', 'wagon']);
await variant('no trackside props', () => toggle(side, false), () => toggle(side, true));
const sky = atmosphere.skyPools.map((p) => p.mesh);
await variant('no city skyline', () => toggle(sky, false), () => toggle(sky, true));
await variant('no characters', () => toggle([chars.player, chars.wardenG, chars.dog.root], false), () => toggle([chars.player, chars.wardenG, chars.dog.root], true));
await variant('no shadows', () => { atmosphere.sun.castShadow = false; }, () => { atmosphere.sun.castShadow = true; });
await variant('no bloom', () => { view.q.bloom = false; }, () => { view.q.bloom = true; });
await variant('no sun shafts', () => { view.q.shafts = false; }, () => { view.q.shafts = true; });
await variant('no lens flare', () => { view.q.flare = false; }, () => { view.q.flare = true; });
await variant('no speed blur', () => { view._noSpeed = view.fx.speed; view.fx.speed = 0; }, () => { view.fx.speed = view._noSpeed; });
// all post-processing off: render the scene straight to the screen
rows.push(['no post-processing at all', await timeFrames(() => { renderer.shadowMap.needsUpdate = true; renderer.setRenderTarget(null); renderer.render(scene, view.camera); })]);
const dpr0 = view.q.dpr;
for (const d of [1, 1.5, 2]) { view.setQuality({ dpr: d }); rows.push([`pixel ratio ${d}`, await measure()]); }
view.setQuality({ dpr: dpr0 });
renderer.setAnimationLoop(() => {}); // leave it frozen
const fmt = (v) => String(v).padStart(6);
return {
  sunVisible: +view.sunVis.toFixed(2), canvas: [renderer.domElement.width, renderer.domElement.height],
  perFrame: [' frame ms  vs base   GPU ms  CPU ms', ...rows.map(([n, m]) => `${fmt(m.frame)}   ${n === rows[0][0] ? '      ' : ((m.frame - base.frame >= 0 ? '+' : '') + (m.frame - base.frame).toFixed(2)).padStart(6)}   ${fmt(m.gpu)}  ${fmt(m.cpu)}   ${n}`)],
};
