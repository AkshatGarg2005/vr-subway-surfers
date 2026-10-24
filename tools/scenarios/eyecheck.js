// Eye check: over 500+ phone-VR frames, measure how washed out each eye is
// (mean brightness and contrast of each half) and flag frames where one eye
// differs from the other. --arg fault=washR breaks the right eye on purpose.
const G = window.__game;
const { game, view, renderer } = G;
game.test.autopilot = true; game.test.invincible = true; game.test.seed = 7;
const stop = drive.fakeSensors((t) => ({ alpha: 20 * Math.sin(t * 0.4), beta: 0, gamma: -84 + 4 * Math.sin(t * 0.5) }));
await drive.tap('#btnCardboard');
while (game.state !== 'running') await drive.frames(1);
if (args.fault) view.post.fault = args.fault;
const W = 160, H = 40;
const c = document.createElement('canvas'); c.width = W; c.height = H;
const g = c.getContext('2d', { willReadFrequently: true });
const rows = [];
const target = Number(args.frames || 600);
await new Promise((resolve) => {
  view.afterRender = () => {
    g.drawImage(renderer.domElement, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const stat = (x0, x1) => {
      let n = 0, sum = 0, sum2 = 0;
      for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) {
        const o = (x + y * W) * 4;
        const l = (d[o] * 0.2126 + d[o + 1] * 0.7152 + d[o + 2] * 0.0722) / 255;
        sum += l; sum2 += l * l; n++;
      }
      const m = sum / n;
      return [m, Math.sqrt(Math.max(0, sum2 / n - m * m))];
    };
    // skip the divider columns
    rows.push([stat(2, W / 2 - 2), stat(W / 2 + 2, W - 2)]);
    if (rows.length >= target) { view.afterRender = null; resolve(); }
  };
});
stop();
view.post.fault = null;
let flagged = 0, maxDiff = 0, maxRatio = 1, sum = [0, 0, 0, 0];
for (const [[mL, cL], [mR, cR]] of rows) {
  const diff = Math.abs(mL - mR);
  const ratio = Math.max(cL, cR) / Math.max(1e-3, Math.min(cL, cR));
  maxDiff = Math.max(maxDiff, diff); maxRatio = Math.max(maxRatio, ratio);
  if (diff > 0.06 || ratio > 1.25) flagged++;
  sum[0] += mL; sum[1] += mR; sum[2] += cL; sum[3] += cR;
}
const n = rows.length;
return {
  frames: n, flaggedFrames: flagged, verdict: flagged === 0 ? 'both eyes match' : 'BROKEN EYE',
  meanBrightness: { left: +(sum[0] / n).toFixed(3), right: +(sum[1] / n).toFixed(3) },
  meanContrast: { left: +(sum[2] / n).toFixed(3), right: +(sum[3] / n).toFixed(3) },
  maxBrightnessDiff: +maxDiff.toFixed(3), maxContrastRatio: +maxRatio.toFixed(3),
};
