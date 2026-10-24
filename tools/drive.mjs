#!/usr/bin/env node
// Drives the game in the system Chrome over the DevTools Protocol.
// Node 22+ only (built-in fetch and WebSocket), no npm packages.
//
//   node tools/drive.mjs <scenario> [--uncapped] [--mobile] [--headful] [--query "a=1&b"] [--arg k=v ...]
//
// <scenario> is a file in tools/scenarios/ (without .js). It is an async function
// body that runs inside the page with `args` and the helper `drive`:
//   drive.shot(name)        save tools/shots/<name>.png
//   drive.log(...)          print progress in this terminal
//   drive.profileStart()    start the CPU profiler
//   drive.profileStop()     stop it and print where JavaScript time went
//   drive.tap(selector)     a trusted tap (a real user gesture)
//   drive.fakeSensors(fn)   phone orientation + motion events for phone-VR tests
//   drive.sleep(ms), drive.frames(n)
// Whatever the scenario returns is printed as JSON.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const getOpt = (name, def) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : def;
};
const scenarioName = argv.find((a) => !a.startsWith('--') && !argv[argv.indexOf(a) - 1]?.match(/^--(query|arg|port|url|timeout)$/));
if (!scenarioName) {
  console.log('usage: node tools/drive.mjs <scenario> [--uncapped] [--mobile] [--headful] [--query "..."] [--arg k=v]');
  console.log('scenarios:', fs.readdirSync(path.join(HERE, 'scenarios')).map((f) => f.replace(/\.js$/, '')).join(', '));
  process.exit(1);
}
const scenarioFile = path.join(HERE, 'scenarios', scenarioName + '.js');
const scenarioSrc = fs.readFileSync(scenarioFile, 'utf8');
const scenarioArgs = {};
argv.forEach((a, i) => { if (a === '--arg' && argv[i + 1]) { const [k, ...v] = argv[i + 1].split('='); scenarioArgs[k] = v.length ? v.join('=') : true; } });
const MOBILE = flags.has('--mobile');
const UNCAPPED = flags.has('--uncapped');
const HEADFUL = flags.has('--headful');
const HTTP_PORT = Number(getOpt('--port', 8080));
const CDP_PORT = 9300 + Math.floor(Math.random() * 500);
const TIMEOUT = Number(getOpt('--timeout', 900)) * 1000;
const SHOTS = path.join(HERE, 'shots');

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const cands = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  }[process.platform] || [];
  const found = cands.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found: set CHROME=/path/to/chrome');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureServer() {
  const url = `http://127.0.0.1:${HTTP_PORT}/index.html`;
  try { const r = await fetch(url); if (r.ok) return null; } catch { /* not running */ }
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(HTTP_PORT), '--no-https', '--quiet'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try { const r = await fetch(url); if (r.ok) return child; } catch { /* starting */ }
  }
  throw new Error('server did not start');
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message + (msg.error.data ? ': ' + msg.error.data : ''))) : res(msg.result);
      } else if (msg.method) for (const h of this.handlers) h(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(fn) { this.handlers.push(fn); }
}

// Summarise a CPU profile: self time per function, top entries.
function summariseProfile(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  const total = (profile.endTime - profile.startTime) / 1000;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const cf = n.callFrame;
    const file = cf.url ? cf.url.split('/').slice(-2).join('/') : '';
    const key = `${cf.functionName || '(anonymous)'} ${file}${cf.lineNumber >= 0 ? ':' + (cf.lineNumber + 1) : ''}`;
    self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
  const byFile = new Map();
  for (const [k, ms] of rows) {
    const f = k.includes('(idle)') ? '(idle)' : k.includes('(program)') ? '(program)' : k.includes('(garbage collector)') ? '(gc)' : (k.split(' ')[1] || '').split(':')[0] || '(native)';
    byFile.set(f, (byFile.get(f) || 0) + ms);
  }
  return {
    totalMs: Math.round(total),
    topFunctions: rows.slice(0, 18).map(([k, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${k}`),
    byFile: [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([f, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${(100 * ms / total).toFixed(1).padStart(5)}%  ${f}`),
  };
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await ensureServer();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrorush-chrome-'));
  const chromeArgs = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader',
    MOBILE ? '--window-size=915,412' : '--window-size=1440,900',
    'about:blank',
  ];
  if (!HEADFUL) chromeArgs.unshift('--headless=new');
  if (UNCAPPED) chromeArgs.unshift('--disable-gpu-vsync', '--disable-frame-rate-limit');
  const chrome = spawn(chromePath(), chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d; if (chromeErr.length > 20000) chromeErr = chromeErr.slice(-10000); });

  const cleanup = () => {
    try { chrome.kill('SIGKILL'); } catch { /* gone */ }
    if (server) try { server.kill(); } catch { /* gone */ }
    setTimeout(() => { try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* busy */ } }, 300);
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  let ver;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch { /* starting */ }
  }
  if (!ver) { cleanup(); throw new Error('Chrome did not start: ' + chromeErr.slice(-800)); }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const cdp = new CDP(ws);
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => cdp.send(m, p, sessionId);

  const consoleMsgs = [];
  let profiling = false;
  cdp.on(async (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value !== undefined ? a.value : a.description || a.type).join(' ');
      if (msg.params.type === 'error' || msg.params.type === 'warning' || msg.params.type === 'warn') consoleMsgs.push(`[${msg.params.type}] ${text}`);
      if (msg.params.type === 'log' && text.startsWith('[drive]')) console.log(text);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      consoleMsgs.push(`[exception] ${d.exception ? d.exception.description : d.text} @${d.url}:${d.lineNumber}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error' || e.level === 'warning') consoleMsgs.push(`[log ${e.level}] ${e.text}${e.url ? ' ' + e.url : ''}`);
    } else if (msg.method === 'Runtime.bindingCalled' && msg.params.name === '__driveCall') {
      const { id, cmd, arg } = JSON.parse(msg.params.payload);
      let result = null;
      try {
        if (cmd === 'shot') {
          const shot = await S('Page.captureScreenshot', { format: 'png' });
          const file = path.join(SHOTS, arg.replace(/[^\w.-]+/g, '_') + '.png');
          fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
          result = path.relative(ROOT, file);
          console.log('[drive] saved', result);
        } else if (cmd === 'profileStart') {
          await S('Profiler.enable');
          await S('Profiler.setSamplingInterval', { interval: 200 });
          await S('Profiler.start');
          profiling = true;
        } else if (cmd === 'profileStop') {
          const { profile } = await S('Profiler.stop');
          profiling = false;
          result = summariseProfile(profile);
        } else if (cmd === 'tap') {
          // A trusted tap/click (counts as a user gesture, unlike element.click()).
          const r = await S('Runtime.evaluate', { expression: `(() => { const b = document.querySelector(${JSON.stringify(arg)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`, returnByValue: true });
          const [x, y] = r.result.value;
          if (MOBILE) {
            await S('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            await S('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          } else {
            await S('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await S('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
          }
          result = [x, y];
        } else if (cmd === 'cpu') {
          await S('Emulation.setCPUThrottlingRate', { rate: Number(arg) || 1 });
        }
      } catch (e) { result = { error: e.message }; }
      await S('Runtime.evaluate', { expression: `window.__drive && window.__drive._resolve(${id}, ${JSON.stringify(result)})` });
    }
  });
  await S('Runtime.enable');
  await S('Log.enable');
  await S('Page.enable');
  await S('Runtime.addBinding', { name: '__driveCall' });

  if (MOBILE) {
    await S('Emulation.setDeviceMetricsOverride', { width: 915, height: 412, deviceScaleFactor: 2.625, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await S('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', platform: 'Android' });
    await S('Emulation.setCPUThrottlingRate', { rate: 4 });
  } else {
    // An M-series MacBook's Retina screen: device pixel ratio 2.
    await S('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  }

  // Helper object injected before any page script runs.
  await S('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      let n = 0; const waits = new Map();
      const call = (cmd, arg) => new Promise((res) => { const id = ++n; waits.set(id, res); window.__driveCall(JSON.stringify({ id, cmd, arg })); });
      window.__drive = {
        _resolve(id, v) { const r = waits.get(id); waits.delete(id); r && r(v); },
        shot: (name) => call('shot', name),
        profileStart: () => call('profileStart'),
        profileStop: () => call('profileStop'),
        cpu: (rate) => call('cpu', rate),
        tap: (sel) => call('tap', sel),
        // Phone sensors for phone-VR tests: orientFn(t) -> { alpha, beta, gamma }
        // (default: landscape, level, looking ahead) and a still accelerometer.
        // Also stores a default calibration so runs start without the calibration flow.
        fakeSensors(orientFn) {
          try { localStorage.setItem('metrorush.calibration', '{}'); } catch {}
          let t = 0;
          const id = setInterval(() => {
            t += 1 / 60;
            const o = orientFn ? orientFn(t) : { alpha: 0, beta: 0, gamma: -90 };
            window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', o));
            window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: 9.81 + (Math.random() - 0.5) * 0.05, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }));
          }, 16);
          return () => clearInterval(id);
        },
        log: (...a) => console.log('[drive]', ...a.map((x) => typeof x === 'string' ? x : JSON.stringify(x))),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        frames: (k) => new Promise((r) => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }),
      };
    })();`,
  });

  const query = getOpt('--query', '');
  const url = `http://127.0.0.1:${HTTP_PORT}/index.html?test${query ? '&' + query : ''}`;
  await S('Page.navigate', { url });
  // wait for the game to boot
  const t0 = Date.now();
  for (;;) {
    const r = await S('Runtime.evaluate', { expression: '!!(window.__game && window.__game.ready)', returnByValue: true });
    if (r.result.value) break;
    if (Date.now() - t0 > 30000) { console.log(consoleMsgs.join('\n')); cleanup(); throw new Error('game did not boot in 30 s'); }
    await sleep(100);
  }
  const bootMs = Date.now() - t0;

  const expr = `(async (args, drive) => { ${scenarioSrc}\n })(${JSON.stringify({ ...scenarioArgs, mobile: MOBILE, uncapped: UNCAPPED, bootMs })}, window.__drive)`;
  let out;
  const timer = setTimeout(() => { console.error('scenario timed out'); cleanup(); process.exit(2); }, TIMEOUT);
  try {
    const r = await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: TIMEOUT });
    if (r.exceptionDetails) out = { error: r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text };
    else out = r.result.value;
  } finally { clearTimeout(timer); }
  if (profiling) await S('Profiler.stop').catch(() => {});

  console.log(JSON.stringify(out, null, 2));
  const ignorable = (m) => /AudioContext was not allowed to start/.test(m) || /The AudioContext was not allowed/.test(m);
  const errs = consoleMsgs.filter((m) => !ignorable(m));
  console.log(`\nconsole errors/warnings: ${errs.length}${errs.length ? '\n  ' + errs.slice(0, 30).join('\n  ') : ''}`);
  ws.close();
  cleanup();
  process.exit(out && out.error ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
