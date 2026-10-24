// End-to-end body sensing in the browser: synthetic deviceorientation and
// devicemotion events (device axes, landscape phone in a headset) drive the
// calibration flow, then a jump, a crouch and side-steps during a run.
//   --arg flip=1   flips the accelerometer signs (iOS-style convention)
const THREE = await import('three');
const G = window.__game;
const { game, phoneVR } = G;
try { localStorage.removeItem('metrorush.calibration'); } catch {}
game.test.invincible = true; game.test.seed = 3;
const sign = args.flip ? -1 : 1;
const DEG = Math.PI / 180;
const pose = { alpha: 0, beta: 0, gamma: -90 };
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const Q = new THREE.Quaternion(), Qi = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3();
let world = { x: 0, y: 0, z: 0 };     // world linear acceleration (y up, z = runner's right after recentering)
let t = 0;
const feed = () => {
  t += 1 / 60;
  window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', pose));
  e.set(pose.beta * DEG, pose.alpha * DEG, -pose.gamma * DEG, 'YXZ');
  Q.setFromEuler(e).multiply(q1); Qi.copy(Q).invert();
  const n = () => (Math.random() - 0.5) * 0.08;
  v.set(world.x + n(), world.y + 9.81 + n(), world.z + n()).applyQuaternion(Qi).multiplyScalar(sign);
  const aig = { x: v.x, y: v.y, z: v.z };
  v.set(world.x, world.y, world.z).applyQuaternion(Qi).multiplyScalar(sign);
  window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: v.x, y: v.y, z: v.z }, accelerationIncludingGravity: aig, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }));
};
const timer = setInterval(feed, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// motion helpers: set world accel over time with a profile function
async function profile(dur, fn) { const t0 = performance.now(); while (performance.now() - t0 < dur * 1000) { const tau = (performance.now() - t0) / 1000; world = fn(tau); await sleep(4); } world = { x: 0, y: 0, z: 0 }; }
const jump = (flight = 0.25) => profile(0.3 + 0.2 + flight + 0.15, (tau) => {
  const v0 = 9.81 * flight / 2;
  if (tau < 0.3) return { x: 0, y: -1.2 * Math.PI / 0.3 * Math.sin(2 * Math.PI * tau / 0.3) * 0.4, z: 0 };
  if (tau < 0.5) return { x: 0, y: v0 * Math.PI / 0.4 * Math.sin(Math.PI * (tau - 0.3) / 0.2), z: 0 };
  if (tau < 0.5 + flight) return { x: 0, y: -9.81, z: 0 };
  return { x: 0, y: v0 * Math.PI / 0.3 * Math.sin(Math.PI * (tau - 0.5 - flight) / 0.15), z: 0 };
});
const crouch = async () => {
  await profile(0.8, (tau) => ({ x: 0, y: -2 * 0.4 / 0.8 * Math.PI / 0.8 * Math.sin(2 * Math.PI * tau / 0.8), z: 0 }));
  await sleep(700);
  await profile(0.9, (tau) => ({ x: 0, y: (tau < 0.4 ? 3 * Math.sin(Math.PI * tau / 0.4) : -2.2 * Math.sin(Math.PI * (tau - 0.4) / 0.5)), z: 0 }));
};
const step = (D, T = 0.35) => profile(T, (tau) => { const u = tau / T; return { x: 0, y: 0, z: (D / (T * T)) * (60 * u - 180 * u * u + 120 * u ** 3) }; });
const out = { flip: !!args.flip };
const msg = () => G.hud.message.key;

await drive.tap('#btnCardboard');
await sleep(400);
out.state0 = game.state;
out.msg0 = msg();
await sleep(2600);                                 // stand still
out.afterStill = msg();
await jump(0.25); await sleep(600);
out.afterJump = msg();
await sleep(800);
await crouch(); await sleep(400);
out.afterCrouch = msg();
await sleep(800);
await step(0.3); await sleep(900); await step(-0.3); await sleep(1500);
out.calibration = JSON.parse(localStorage.getItem('metrorush.calibration') || 'null');
out.sign = phoneVR.sensing.sign;
const t0 = performance.now();
while (game.state !== 'running' && performance.now() - t0 < 8000) await sleep(50);
out.stateAfterCal = game.state;
await sleep(1500);
// --- in the run
const b = game.body;
let jumped = false, rolled = false;
const watch = setInterval(() => { if (!b.grounded && b.vy > 0) jumped = true; if (b.rolling) rolled = true; }, 10);
await jump(0.2); await sleep(500);
out.runJump = jumped;
await sleep(1200);
await crouch(); await sleep(300);
out.runRoll = rolled;
await sleep(1500);
const lane0 = b.lane;
await step(0.3); await sleep(700);
out.laneAfterRight = [lane0, b.lane];
await sleep(600);
await step(-0.3); await sleep(700);
out.laneAfterLeft = b.lane;
// head turn of 60° at 200°/s with the phone ahead of the neck: lanes must not change
const laneBefore = b.lane;
await profile(0.6, (tau) => { pose.alpha = 60 * Math.sin(Math.PI * tau / 0.6) ** 2; return { x: 0, y: 0, z: 0 }; });
pose.alpha = 0;
await sleep(600);
out.laneAfterHeadTurn = [laneBefore, b.lane];
clearInterval(watch); clearInterval(timer);
out.motionCount = phoneVR.sensing.count;
return out;
