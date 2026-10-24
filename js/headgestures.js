// WebXR body gestures from the tracked head position (pure JS, no three.js,
// so tools/xr-sim.mjs can test it).
//
//   Lanes:  head position sideways from the calibrated centre (step or lean):
//           beyond ±0.25 m picks the side lane, 0.08 m hysteresis back.
//   Jump:   head rising faster than 0.9 m/s and higher than base + 0.04 m.
//   Crouch: head below base − 0.28 m.
// Both re-arm with hysteresis. The base height is re-learned slowly while the
// head is still, and frozen during the countdown.
import { XR_GESTURE } from './config.js';

export class HeadGestures {
  constructor() {
    this.cfg = XR_GESTURE;
    this.reset();
  }

  reset() {
    this.base = null;         // standing head height (m)
    this.cx = 0; this.cz = 0; // calibrated centre
    this.rx = 1; this.rz = 0; // calibrated right direction (horizontal)
    this.zone = 1;            // 0 left, 1 middle, 2 right
    this.lat = 0;
    this.y = 0; this.vy = 0; this.prevY = null;
    this.jumpArmed = true; this.crouchArmed = true;
    this.frozen = false;
    this.stillT = 0;
    this.lastJumpT = -9;
  }

  // Calibrate: current head position is the centre, `yaw` the forward direction.
  recenter(x, y, z, yaw) {
    this.cx = x; this.cz = z;
    // right of forward (-sin yaw, 0, -cos yaw) is (cos yaw, 0, -sin yaw)
    this.rx = Math.cos(yaw); this.rz = -Math.sin(yaw);
    this.base = y;
    this.zone = 1;
    this.jumpArmed = true; this.crouchArmed = true;
  }

  freeze(on) { this.frozen = on; }

  // Head position in the reference space; t in seconds. Returns an event or null.
  update(x, y, z, t, dt) {
    if (this.base == null) { this.recenter(x, y, z, 0); this.prevY = y; return null; }
    const c = this.cfg;
    // vertical speed, lightly smoothed (poses arrive at 72-120 Hz)
    if (this.prevY != null && dt > 0) {
      const v = (y - this.prevY) / dt;
      this.vy += (v - this.vy) * Math.min(1, dt / 0.03);
    }
    this.prevY = y;
    this.y = y;
    let ev = null;
    const rise = y - this.base;

    // jump
    if (this.jumpArmed && this.vy > c.jumpVy && rise > c.jumpRise) {
      ev = 'jump';
      this.jumpArmed = false;
      this.lastJumpT = t;
    } else if (!this.jumpArmed && rise < c.jumpRise * 0.5 && this.vy < 0.3) this.jumpArmed = true;

    // crouch
    if (!ev && this.crouchArmed && rise < -c.crouchDrop) {
      ev = 'crouch';
      this.crouchArmed = false;
    } else if (!this.crouchArmed && rise > -c.crouchDrop + c.rearm) this.crouchArmed = true;

    // lanes from where the head is (step or lean), with hysteresis
    const lat = (x - this.cx) * this.rx + (z - this.cz) * this.rz;
    this.lat = lat;
    const on = c.laneOffset, off = c.laneOffset - c.laneHyst;
    let zone = this.zone;
    if (zone === 1) { if (lat > on) zone = 2; else if (lat < -on) zone = 0; }
    else if (zone === 2) { if (lat < -on) zone = 0; else if (lat < off) zone = 1; }
    else if (zone === 0) { if (lat > on) zone = 2; else if (lat > -off) zone = 1; }
    if (!ev && zone !== this.zone) {
      ev = zone > this.zone ? 'right' : 'left';
      if (Math.abs(zone - this.zone) === 2) ev += '2';
      this.zone = zone;
    }

    // re-learn the standing height slowly while the head is still
    const still = Math.abs(this.vy) < 0.06 && Math.abs(rise) < 0.12;
    this.stillT = still ? this.stillT + dt : 0;
    if (!this.frozen && this.stillT > 0.5) this.base += (y - this.base) * (1 - Math.exp(-dt / 3));
    return ev;
  }
}
