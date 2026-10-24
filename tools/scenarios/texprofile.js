// Times each procedural texture.
const { buildTextures } = await import('/js/textures.js');
const { TRAIN } = await import('/js/builders.js');
const times = [];
let last = performance.now();
await buildTextures(TRAIN.profileAcc, (f, label) => { const now = performance.now(); times.push([label, Math.round(now - last)]); last = now; });
return { total: times.reduce((a, b) => a + b[1], 0), times, loadMs: window.__game.loadMs };
