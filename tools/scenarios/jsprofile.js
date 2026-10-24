// JavaScript time per frame during a normal-screen run (CPU profiler).
const { game } = window.__game;
game.test.autopilot = true; game.test.invincible = true; game.test.seed = 5;
await drive.tap('#btnPlay');
await drive.sleep(3000);
let frames = 0, run = true;
const count = () => { frames++; if (run) requestAnimationFrame(count); };
requestAnimationFrame(count);
await drive.profileStart();
await drive.sleep(Number(args.seconds || 20) * 1000);
const prof = await drive.profileStop();
run = false;
// self time by category from the summary
const parse = (rows) => rows.map((r) => { const m = r.trim().match(/^(\d+) ms\s+[\d.]+%\s+(.*)$/); return m ? [m[2], Number(m[1])] : null; }).filter(Boolean);
const files = parse(prof.byFile);
const idle = (files.find(([f]) => f === '(idle)') || [0, 0])[1];
const program = (files.find(([f]) => f === '(program)') || [0, 0])[1];
const js = files.filter(([f]) => f !== '(idle)' && f !== '(program)').reduce((a, [, ms]) => a + ms, 0);
return { frames, seconds: prof.totalMs / 1000, jsMsPerFrame: +(js / frames).toFixed(2), browserNativeMsPerFrame: +(program / frames).toFixed(2), idlePct: +(100 * idle / prof.totalMs).toFixed(1), byFile: prof.byFile, top: prof.topFunctions.slice(0, 12) };
