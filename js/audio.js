// WebAudio music and sound effects, all synthesised (no audio files).
//
// The AudioContext is created while the game loads (it starts suspended, which
// is allowed without a user gesture) and only resumed on the first tap: making a
// new AudioContext takes ~200 ms, which froze the start of a run when it was
// done on the Play tap.
const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class Audio {
  constructor() {
    this.enabled = true;
    this.paused = false;
    this.speedK = 0;
    this.ctx = null;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC({ latencyHint: 'interactive' });
    } catch { this.ctx = null; }
    if (!this.ctx) return;
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0.8;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 4;
    comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(comp).connect(c.destination);
    this.music = c.createGain();
    this.music.gain.value = 0.0;
    this.music.connect(this.master);
    this.sfx = c.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    // reverb from a generated impulse (decaying stereo noise)
    this.verb = c.createConvolver();
    this.verb.buffer = this._impulse(2.2, 2.6);
    this.verbIn = c.createGain();
    this.verbIn.gain.value = 0.32;
    this.verbIn.connect(this.verb).connect(this.master);
    this.noiseBuf = this._noise(1.5);
    this._seq = { next: 0, step: 0, bar: 0, timer: null };
    this._drone = null;
  }

  _impulse(seconds, decay) {
    const c = this.ctx, len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  _noise(seconds) {
    const c = this.ctx, len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Call from a user gesture (first tap / key).
  resume() {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    if (!this._seq.timer) this._startMusic();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(on ? 0.8 : 0, this.ctx.currentTime, 0.05);
  }

  setPaused(p) {
    this.paused = p;
    if (!this.ctx) return;
    this.music.gain.setTargetAtTime(p ? 0.0 : this._musicLevel(), this.ctx.currentTime, 0.15);
  }

  _musicLevel() { return this.inRun ? 0.42 : 0.26; }

  setInRun(on) {
    this.inRun = on;
    if (!this.ctx) return;
    this.music.gain.setTargetAtTime(this.paused ? 0 : this._musicLevel(), this.ctx.currentTime, 0.4);
  }

  // Tempo follows speed (0..1 within the mode's range).
  setSpeed(speed, cfg) {
    this.speedK = Math.max(0, Math.min(1, (speed - cfg.v0) / Math.max(0.1, cfg.v1 - cfg.v0)));
  }

  // ------------------------------------------------------------ music
  _startMusic() {
    const c = this.ctx;
    this._seq.next = c.currentTime + 0.1;
    this._seq.timer = setInterval(() => this._schedule(), 25);
    this._startDrone();
    this.music.gain.setTargetAtTime(this._musicLevel(), c.currentTime, 0.8);
  }

  _startDrone() {
    const c = this.ctx;
    const out = c.createGain();
    out.gain.value = 0.06;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.7;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = c.createGain();
    lfoAmt.gain.value = 160;
    lfo.connect(lfoAmt).connect(lp.frequency);
    for (const [f, det] of [[NOTE(33), -7], [NOTE(33), 6], [NOTE(40), 3]]) {
      const o = c.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(lp); o.start();
    }
    lp.connect(out).connect(this.music);
    out.connect(this.verbIn);
    lfo.start();
    this._drone = { out, lp };
  }

  _schedule() {
    const c = this.ctx;
    if (!c || c.state !== 'running') return;
    const sq = this._seq;
    const bpm = 98 + this.speedK * 34;
    const step = 60 / bpm / 4; // sixteenths
    // after a pause the clock ran on: skip ahead rather than burst
    if (sq.next < c.currentTime - 0.2) sq.next = c.currentTime + 0.05;
    while (sq.next < c.currentTime + 0.12) {
      if (!this.paused) this._step(sq.step, sq.next, step);
      sq.next += step * (sq.step % 2 ? 0.92 : 1.08); // light swing
      sq.step = (sq.step + 1) % 64;
    }
  }

  _step(i, t, step) {
    const b = i % 16;
    const bar = Math.floor(i / 16);
    const busy = this.inRun;
    // drums
    if (b === 0 || b === 8 || (busy && b === 10 && bar % 2)) this._kick(t);
    if (b === 4 || b === 12) this._snare(t, busy ? 0.5 : 0.3);
    if (busy && b === 15 && bar === 3) this._snare(t, 0.25);
    if (b % 2 === 0 || (busy && this.speedK > 0.4)) this._hat(t, b % 4 === 2 ? 0.16 : 0.08, b === 14 && bar % 2 ? 0.12 : 0.035);
    // bass: a four-bar loop (original), roots A F C G
    const roots = [45, 41, 36, 43];
    const pat = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0];
    if (pat[b]) this._bass(t, NOTE(roots[bar] + (b === 11 ? 7 : b === 13 ? 12 : 0)), step * 1.6);
    // sparse lead arpeggio when running fast
    if (busy && this.speedK > 0.25 && (b === 2 || b === 6 || b === 10 || b === 14)) {
      const chord = [[69, 72, 76], [65, 69, 72], [60, 64, 67], [67, 71, 74]][bar];
      this._pluck(t, NOTE(chord[(b >> 2) % 3] + 12), 0.05);
    }
  }

  _env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _kick(t) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this._env(g, t, 0.003, 0.9, 0.3);
    o.connect(g).connect(this.music);
    o.start(t); o.stop(t + 0.4);
  }

  _noiseHit(t, dest, type, freq, q, a, peak, d, rate = 1) {
    const c = this.ctx, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf;
    s.playbackRate.value = rate;
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    this._env(g, t, a, peak, d);
    s.connect(f).connect(g).connect(dest);
    s.start(t, Math.random() * 0.5); s.stop(t + a + d + 0.05);
    return { f, g };
  }

  _snare(t, v) {
    this._noiseHit(t, this.music, 'bandpass', 1900, 0.8, 0.002, v, 0.16);
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(140, t + 0.08);
    this._env(g, t, 0.002, v * 0.5, 0.1);
    o.connect(g).connect(this.music); o.start(t); o.stop(t + 0.15);
    const send = c.createGain(); send.gain.value = 0.5; g.connect(send).connect(this.verbIn);
  }

  _hat(t, v, d) { this._noiseHit(t, this.music, 'highpass', 7500, 0.7, 0.001, v, d); }

  _bass(t, f, d) {
    const c = this.ctx, o = c.createOscillator(), lp = c.createBiquadFilter(), g = c.createGain();
    o.type = 'sawtooth'; o.frequency.value = f;
    lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(900 + this.speedK * 700, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + d);
    this._env(g, t, 0.005, 0.32, d);
    o.connect(lp).connect(g).connect(this.music);
    o.start(t); o.stop(t + d + 0.05);
  }

  _pluck(t, f, v) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'square'; o.frequency.value = f;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    this._env(g, t, 0.003, v, 0.18);
    o.connect(lp).connect(g);
    g.connect(this.music); g.connect(this.verbIn);
    o.start(t); o.stop(t + 0.25);
  }

  // ------------------------------------------------------------ effects
  _tone(type, f0, f1, dur, vol, { at = 0, pan = 0, verb = 0.15, attack = 0.004 } = {}) {
    const c = this.ctx, t = c.currentTime + at;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    this._env(g, t, attack, vol, dur);
    let node = o.connect(g);
    if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; node = node.connect(p); }
    node.connect(this.sfx);
    if (verb) { const s = c.createGain(); s.gain.value = verb; node.connect(s).connect(this.verbIn); }
    o.start(t); o.stop(t + attack + dur + 0.05);
  }

  _whoosh(f0, f1, dur, vol, pan = 0) {
    const c = this.ctx, t = c.currentTime;
    const { f } = this._noiseHit(t, this.sfx, 'bandpass', f0, 1.4, 0.02, vol, dur);
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    if (pan && c.createStereoPanner) { /* noise already routed; panning a whoosh is a nicety we skip */ }
  }

  play(name, v = 0) {
    if (!this.ctx || !this.enabled || this.ctx.state !== 'running') return;
    switch (name) {
      case 'coin': {
        const k = Math.pow(2, Math.min(v, 14) / 24); // pitch climbs with the streak
        this._tone('triangle', 1318 * k, 1318 * k, 0.06, 0.16, { verb: 0.2 });
        this._tone('sine', 1975 * k, 1975 * k, 0.12, 0.13, { at: 0.045, verb: 0.25 });
        break;
      }
      case 'jump':
        this._tone('square', 260, 620, 0.13, 0.07, { verb: 0.05 });
        this._whoosh(700, 2400, 0.18, 0.18);
        break;
      case 'roll':
        this._whoosh(2000, 300, 0.28, 0.22);
        this._tone('sine', 180, 90, 0.18, 0.12, { verb: 0 });
        break;
      case 'land':
        this._tone('sine', 120, 48, 0.12, 0.35 * (0.4 + 0.6 * v), { verb: 0 });
        this._noiseHit(this.ctx.currentTime, this.sfx, 'lowpass', 900, 0.7, 0.002, 0.15 * v, 0.08);
        break;
      case 'swish':
        this._whoosh(v < 0 ? 1600 : 2200, v < 0 ? 600 : 900, 0.14, 0.13);
        break;
      case 'stumble':
        this._tone('sine', 140, 60, 0.22, 0.4, { verb: 0.1 });
        this._tone('sawtooth', 300, 120, 0.3, 0.08, { at: 0.04 });
        this._noiseHit(this.ctx.currentTime, this.sfx, 'lowpass', 600, 1, 0.003, 0.3, 0.2);
        break;
      case 'crash': {
        const t = this.ctx.currentTime;
        this._noiseHit(t, this.sfx, 'lowpass', 2200, 0.8, 0.002, 0.7, 0.7);
        this._tone('sine', 110, 35, 0.6, 0.6, { verb: 0.3 });
        for (const f of [523, 741, 1187]) this._tone('triangle', f, f * 0.97, 0.5, 0.08, { verb: 0.4 });
        break;
      }
      case 'power':
        [0, 4, 7, 12, 16].forEach((n, i) => this._tone('square', NOTE(72 + n), NOTE(72 + n), 0.09, 0.07, { at: i * 0.055, verb: 0.3 }));
        break;
      case 'shield':
        this._whoosh(400, 3000, 0.3, 0.25);
        this._tone('triangle', 880, 1760, 0.25, 0.12, { verb: 0.4 });
        break;
      case 'hint':
        this._tone('sine', 1560, 1560, 0.035, 0.13, { verb: 0.05, attack: 0.002 });
        break;
      case 'recenter':
        this._tone('sine', NOTE(79), NOTE(79), 0.3, 0.12, { verb: 0.5 });
        this._tone('sine', NOTE(84), NOTE(84), 0.4, 0.1, { at: 0.12, verb: 0.5 });
        break;
      case 'beep':
        this._tone('square', 880, 880, 0.08, 0.08, { verb: 0.1 });
        break;
      case 'go':
        this._tone('square', 1320, 1320, 0.25, 0.1, { verb: 0.2 });
        break;
      case 'over':
        [7, 4, 0, -5].forEach((n, i) => this._tone('triangle', NOTE(67 + n), NOTE(67 + n), 0.16, 0.12, { at: i * 0.12, verb: 0.35 }));
        break;
      case 'move': // a real body move was detected (VR)
        this._tone('sine', 990, 990, 0.04, 0.08, { verb: 0 });
        break;
    }
  }
}
