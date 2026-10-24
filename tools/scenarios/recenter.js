// Hands-free recenter: turn the body 40° away from the track, look up past 55°
// for 2 s (ring of dots fills), look back down: the view must line up with the track again.
const G = window.__game;
const { game, phoneVR, hud } = G;
game.test.autopilot = true; game.test.invincible = true; game.test.seed = 7;
let o = { alpha: 0, beta: 0, gamma: -90 };
const stop = drive.fakeSensors(() => o);
await drive.tap('#btnCardboard');
while (game.state !== 'running') await drive.frames(1);
const deg = (r) => +(r * 180 / Math.PI).toFixed(1);
const out = {};
out.startRelYaw = deg(phoneVR.head.relYaw);
o = { alpha: 40, beta: 0, gamma: -90 };          // body turned 40° left
await drive.sleep(800);
out.turnedRelYaw = deg(phoneVR.head.relYaw);
let recentered = 0;
phoneVR.onRecenter = () => recentered++;
o = { alpha: 220, beta: 180, gamma: 30 };        // same body direction, looking up 60°
let maxRing = 0;
const t0 = performance.now();
while (performance.now() - t0 < 2600) { await drive.frames(1); if (hud.ring.visible) maxRing = Math.max(maxRing, hud.dots.filter((d) => d.material.color.r > 0.9).length); }
out.pitchWhileUp = deg(phoneVR.head.pitch);
out.ringDotsFilled = maxRing;
out.recenters = recentered;
o = { alpha: 40, beta: 0, gamma: -90 };           // look back down, still turned
await drive.sleep(500);
out.afterRelYaw = deg(phoneVR.head.relYaw);
// cancel test: look up for 1 s then back down -> no recenter
o = { alpha: 220, beta: 180, gamma: 30 }; await drive.sleep(1000);
o = { alpha: 40, beta: 0, gamma: -90 }; await drive.sleep(400);
out.recentersAfterCancel = recentered;
stop();
return out;
