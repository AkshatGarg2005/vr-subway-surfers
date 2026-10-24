// In-world VR HUD: canvas-textured panels attached to the camera rig (not the
// head), so they stay in the running direction instead of being glued to your
// face. They sit above the horizon so they never cover the track. A panel's
// canvas is only redrawn when its text changes.
import * as THREE from 'three';

const FONT_D = "'Bungee', 'Impact', 'Arial Black', sans-serif";
const FONT_T = "'Rubik', system-ui, sans-serif";
const INK = '#1c1233', PAPER = '#fff7ea', YEL = '#ffd23d', ORANGE = '#ff7a1a', PINK = '#ff3b7f', TEAL = '#2fe0c8';

class Panel {
  constructor(parent, wM, hM, pxW, pxH, dist, elevDeg, order = 20) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW; this.canvas.height = pxH;
    this.g = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = true;
    this.tex.minFilter = THREE.LinearMipmapLinearFilter;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false, color: 0xd8d8d8 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(wM, hM), this.mat);
    this.mesh.renderOrder = order;
    this.mesh.frustumCulled = false;
    const e = (elevDeg * Math.PI) / 180;
    this.mesh.position.set(0, Math.sin(e) * dist, -Math.cos(e) * dist);
    this.mesh.lookAt(0, 0, 0);
    this.mesh.visible = false;
    parent.add(this.mesh);
    this.key = null;
  }

  // Redraws only if `key` changed.
  draw(key, fn) {
    if (key === this.key) return;
    this.key = key;
    const g = this.g;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    fn(g, this.canvas.width, this.canvas.height);
    this.tex.needsUpdate = true;
  }

  set visible(v) { this.mesh.visible = v; }
  get visible() { return this.mesh.visible; }
}

function pill(g, x, y, w, h, r, fill, stroke = INK, lw = 6) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fillStyle = fill; g.fill();
  if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); }
}

function text(g, s, x, y, size, color, font = FONT_D, align = 'center', outline = INK) {
  g.font = `${size}px ${font}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  if (outline) { g.lineWidth = size * 0.16; g.strokeStyle = outline; g.lineJoin = 'round'; g.strokeText(s, x, y); }
  g.fillStyle = color;
  g.fillText(s, x, y);
}

export class Hud3D {
  constructor(rig, camera) {
    this.group = new THREE.Group();
    this.group.name = 'hud3d';
    this.group.visible = false;
    rig.add(this.group);
    // Panels are fairly close (1.6-2.2 m) so they're in front of anything you'd
    // normally see: a panel drawn over a nearer train would give your eyes two
    // conflicting depths. Sizes keep the same apparent size at that distance.
    this.score = new Panel(this.group, 0.94, 0.235, 768, 192, 2.0, 21);
    this.flash = new Panel(this.group, 0.54, 0.18, 512, 170, 1.8, 12, 21);
    this.message = new Panel(this.group, 1.16, 0.58, 900, 450, 2.2, 6, 22);
    this.hint = new Panel(this.group, 0.46, 0.13, 640, 180, 1.6, 2.5, 21);
    this.flashT = 0;
    // Ring of dots for the look-up recenter gesture: follows the gaze.
    this.ring = new THREE.Group();
    this.ring.position.set(0, 0, -1.4);
    this.ring.visible = false;
    this.dots = [];
    const dg = new THREE.CircleGeometry(0.018, 12);
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ color: 0x777777, depthTest: false, transparent: true, fog: false, toneMapped: false }));
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      m.position.set(Math.cos(a) * 0.11, -Math.sin(a) * 0.11, 0);
      m.renderOrder = 30;
      this.ring.add(m);
      this.dots.push(m);
    }
    camera.add(this.ring);
    // Canvas text uses the web fonts: redraw every panel once they have loaded.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { for (const p of [this.score, this.flash, this.message, this.hint]) p.key = null; });
    }
  }

  setEyeY(y) { this.group.position.set(0, y, 0); this.group.quaternion.identity(); }
  show(on) { this.group.visible = on; if (!on) this.ring.visible = false; }

  update(dt, game) {
    const r = game.run;
    // score / coins / multiplier
    if (r && (game.state === 'running' || game.state === 'countdown' || game.state === 'paused')) {
      const score = Math.floor(r.score), mult = r.mult * (r.power.double > 0 ? 2 : 1);
      const pw = (r.power.magnet > 0 ? 'M' : '') + (r.power.double > 0 ? 'D' : '') + (r.power.sneakers > 0 ? 'S' : '') + (r.power.shield ? 'B' : '');
      this.score.visible = true;
      this.score.draw(`${score}|${r.coins}|${mult}|${pw}`, (g, w, h) => {
        pill(g, 8, 8, w - 16, h - 16, 40, 'rgba(28,18,51,0.62)', 'rgba(255,247,234,0.35)', 4);
        text(g, score.toLocaleString(), 40, h * 0.5, 84, PAPER, FONT_D, 'left');
        g.font = `64px ${FONT_D}`;
        const sw = Math.min(g.measureText(score.toLocaleString()).width, 360);
        pill(g, 60 + sw, h * 0.5 - 34, 108, 68, 18, YEL, INK, 5);
        text(g, '×' + mult, 114 + sw, h * 0.52, 44, INK, FONT_D, 'center', null);
        // coins
        g.beginPath(); g.arc(w - 210, h * 0.5, 30, 0, Math.PI * 2);
        g.fillStyle = '#ffc83a'; g.fill(); g.lineWidth = 6; g.strokeStyle = INK; g.stroke();
        text(g, String(r.coins), w - 165, h * 0.52, 64, PAPER, FONT_D, 'left');
        if (pw) {
          const cols = { M: '#ff3b5c', D: '#39d7ff', S: '#7cff4f', B: '#ffc23d' };
          [...pw].forEach((k, i) => { g.beginPath(); g.arc(w - 300 - i * 36, 40, 13, 0, Math.PI * 2); g.fillStyle = cols[k]; g.fill(); });
        }
      });
    } else this.score.visible = false;

    // flash: a real move was detected
    if (this.flashT > 0) { this.flashT -= dt; this.flash.visible = this.flashT > 0; }

    // hint
    const h = game.hint;
    const showHint = game.state === 'running' && game.settings.hints && h.kind && h.phase !== 'done';
    this.hint.visible = !!showHint;
    if (showHint) {
      const label = { jump: '▲ JUMP', roll: '▼ ROLL', left: '◀ STEP LEFT', right: 'STEP RIGHT ▶' }[h.kind];
      this.hint.draw(label + h.phase, (g, w, hh) => {
        const now = h.phase === 'now';
        pill(g, 12, 12, w - 24, hh - 24, 50, now ? YEL : 'rgba(255,247,234,0.5)', INK, 8);
        text(g, label, w / 2, hh / 2 + 4, 78, INK, FONT_D, 'center', null);
      });
      this.hint.mat.opacity = h.phase === 'now' ? 1 : 0.55;
    }
  }

  // "▲ JUMP", "▼ ROLL", "◀ STEP", "STEP ▶"
  moveFlash(kind) {
    const label = { jump: '▲ JUMP', roll: '▼ ROLL', left: '◀ STEP', right: 'STEP ▶' }[kind];
    if (!label) return;
    this.flashT = 0.7;
    this.flash.visible = true;
    this.flash.draw(label, (g, w, h) => {
      pill(g, 10, 10, w - 20, h - 20, 44, TEAL, INK, 7);
      text(g, label, w / 2, h / 2 + 4, 74, INK, FONT_D, 'center', null);
    });
  }

  // Calibration, countdown, game over...
  showMessage(title, lines = [], accent = ORANGE) {
    const key = title + '|' + lines.join('|');
    this.message.visible = true;
    this.message.draw(key, (g, w, h) => {
      pill(g, 14, 14, w - 28, h - 28, 46, 'rgba(255,247,234,0.94)', INK, 10);
      g.fillStyle = accent; g.fillRect(14, 14, 18, h - 28);
      text(g, title, w / 2, lines.length ? 120 : h / 2, title.length > 14 ? 72 : 96, INK, FONT_D, 'center', null);
      lines.forEach((l, i) => text(g, l, w / 2, 220 + i * 62, 46, INK, FONT_T, 'center', null));
    });
  }

  hideMessage() { this.message.visible = false; this.message.key = null; }

  // Look-up recenter progress (0..1); null hides the ring.
  setRing(p) {
    this.ring.visible = p != null;
    if (p == null) return;
    const n = Math.round(p * 12);
    this.dots.forEach((d, i) => d.material.color.set(i < n ? 0xffd23d : 0x6c6c6c));
  }
}
