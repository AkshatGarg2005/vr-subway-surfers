// Instanced pools draw only used slots: capacity vs drawn (mesh.count) vs live items.
const { game, world } = window.__game;
game.test.autopilot = true; game.test.invincible = true; game.test.seed = 5;
await drive.tap('#btnPlay');
await drive.sleep(Number(args.seconds || 25) * 1000);
const rows = world.poolList.map((p) => ({ name: p.mesh.name, capacity: p.capacity, drawn: p.mesh.count, live: p.live, tris: (p.mesh.geometry.index ? p.mesh.geometry.index.count : p.mesh.geometry.attributes.position.count) / 3 }));
const tot = rows.reduce((a, r) => ({ cap: a.cap + r.capacity * r.tris, drawn: a.drawn + r.drawn * r.tris, live: a.live + r.live * r.tris }), { cap: 0, drawn: 0, live: 0 });
return {
  pools: rows.filter((r) => r.capacity >= 24).map((r) => `${r.name.padEnd(12)} cap ${String(r.capacity).padStart(4)}  drawn ${String(r.drawn).padStart(4)}  live ${String(r.live).padStart(4)}`),
  triangles: { ifAllSlotsDrawn: tot.cap, drawn: tot.drawn, live: tot.live },
};
