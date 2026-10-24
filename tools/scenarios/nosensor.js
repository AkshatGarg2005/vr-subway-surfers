// No motion data: after ~2.5 s the help panel explains how to fix it and offers
// to play without body sensing.
const { game } = window.__game;
try { localStorage.removeItem('metrorush.calibration'); } catch {}
const id = setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: 0, gamma: -90 })), 16);
await drive.tap('#btnCardboard');
const panel = document.getElementById('sensorHelp');
const t0 = performance.now();
while (!panel.classList.contains('show') && performance.now() - t0 < 6000) await drive.sleep(50);
const shownAfter = +((performance.now() - t0) / 1000).toFixed(2);
await drive.shot('nosensor');
const stateWhileShown = game.state;
await drive.tap('#btnNoSensing');
const t1 = performance.now();
while (game.state !== 'running' && performance.now() - t1 < 6000) await drive.sleep(50);
clearInterval(id);
return { shownAfter, stateWhileShown, panelHidden: !panel.classList.contains('show'), stateAfter: game.state };
