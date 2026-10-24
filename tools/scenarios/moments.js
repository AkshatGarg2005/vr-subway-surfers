// Screenshots of key gameplay moments (autopilot, invincible, fixed seed).
//   --arg prefix=m2  --arg seconds=90  --arg mode=screen|cardboard
const { game, view } = window.__game;
const prefix = args.prefix || 'moment';
game.test.autopilot = true;
game.test.invincible = true;
game.test.seed = Number(args.seed || 11);
game.settings.camera = args.camera || 'chase';
game.setMode('screen');
game.startRun();
const want = { hint: false, roof: false, moving: false, coins: false, power: false, stumble: false };
const out = [];
const t0 = performance.now();
const secs = Number(args.seconds || 90);
while (performance.now() - t0 < secs * 1000 && Object.values(want).some((v) => !v)) {
  await drive.frames(1);
  const b = game.body, r = game.run;
  let tag = null;
  if (!want.hint && game.hint.phase === 'now' && game.hint.kind) tag = 'hint';
  else if (!want.roof && b.y > 3 && b.grounded) tag = 'roof';
  else if (!want.moving && game.world.obstacles.some((o) => o.moving && o.s0 !== undefined && Math.abs(o.lane - b.lane) <= 1 && (o.moving.sMeet - b.s) < 25 && (o.moving.sMeet - b.s) > 8)) tag = 'moving';
  else if (!want.power && (r.power.magnet > 0 || r.power.sneakers > 0 || r.power.double > 0 || r.power.shield)) tag = 'power';
  else if (!want.coins && r.coins > 30 && game.world.coins.some((c) => c.s - b.s > 2 && c.s - b.s < 12 && c.lane === b.lane)) tag = 'coins';
  if (tag) {
    want[tag] = true;
    await drive.shot(`${prefix}-${tag}`);
    out.push({ tag, t: +((performance.now() - t0) / 1000).toFixed(1), s: Math.round(b.s), y: +b.y.toFixed(2) });
  }
}
return { got: out, missing: Object.keys(want).filter((k) => !want[k]) };
