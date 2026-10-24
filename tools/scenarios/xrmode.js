// WebXR mode without a headset: the XR pose source and controllers are stubbed,
// everything else (gestures, rig, HUD, controllers, game) is the real code.
const G = window.__game;
const { game, view, renderer, xr, hud } = G;
game.test.invincible = true; game.test.seed = 3;
const head = { x: 0.1, y: 1.7, z: -0.2, yaw: 0.3 };   // standing a little off-centre, turned 17°
const pad = { buttons: Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] };
renderer.xr.updateCamera = (cam) => { cam.position.set(head.x, head.y, head.z); cam.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0, isVector3: true }, head.yaw); cam.updateMatrixWorld(); };
xr.session = { inputSources: [{ gamepad: pad }], end: async () => {}, addEventListener() {} };
xr.active = true;
view.setMode('xr'); game.setMode('xr'); game.vr = xr; hud.show(true); xr.gest.reset();
game.startRun();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anim = async (dur, fn) => { const t0 = performance.now(); while (performance.now() - t0 < dur) { fn((performance.now() - t0) / dur); await drive.frames(1); } fn(1); };
const out = {};
while (game.state !== 'running') await drive.frames(1);
await sleep(800);
await drive.shot('xr-running');
const b = game.body;
// lean right 0.35 m (relative to the calibrated facing, which is turned 0.3 rad)
const rx = Math.cos(0.3), rz = -Math.sin(0.3);
const base = { x: head.x, z: head.z };
await anim(400, (u) => { const k = 0.35 * u; head.x = base.x + rx * k; head.z = base.z + rz * k; });
await sleep(400); out.laneAfterLeanRight = b.lane;
await anim(400, (u) => { const k = 0.35 * (1 - u); head.x = base.x + rx * k; head.z = base.z + rz * k; });
await sleep(400); out.laneAfterBack = b.lane;
// real jump: head rises 15 cm fast
let jumped = false, rolled = false;
const w = setInterval(() => { if (!b.grounded && b.vy > 0) jumped = true; if (b.rolling) rolled = true; }, 5);
await anim(250, (u) => { head.y = 1.7 + 0.15 * Math.sin(Math.PI * u); });
await sleep(900); out.jumped = jumped;
// crouch 0.4 m
await anim(400, (u) => { head.y = 1.7 - 0.4 * u; });
await sleep(200); out.rolled = rolled;
await anim(500, (u) => { head.y = 1.3 + 0.4 * u; });
await sleep(1200);
// controllers: trigger = jump, thumbstick right = lane
jumped = false;
pad.buttons[0].pressed = true; await drive.frames(3); pad.buttons[0].pressed = false;
await sleep(300); out.triggerJump = jumped;
await sleep(900);
const l0 = b.lane;
pad.axes[2] = 0.9; await drive.frames(3); pad.axes[2] = 0; await drive.frames(3);
await sleep(400); out.stickLane = [l0, b.lane];
clearInterval(w);
// camera: rig maps the calibrated forward down the track
const dir = view.camera.getWorldDirection(view.camera.position.clone());
out.cameraForward = dir.toArray().map((v) => +v.toFixed(2));
out.eyeHeight = +view.camera.getWorldPosition(view.camera.position.clone()).y.toFixed(2);
await drive.shot('xr-later');
return out;
