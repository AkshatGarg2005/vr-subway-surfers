#!/usr/bin/env node
// Metro Rush dev server. No dependencies.
//   HTTP  on :8080 (desktop)
//   HTTPS on :8443 (phones: motion sensors are only given to secure pages)
// On first run it creates a self-signed certificate with openssl whose
// subjectAltName covers localhost, 127.0.0.1 and every LAN IPv4 address.
//
// Options: --port N  --https-port N  --no-https  --quiet
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = __dirname;
const CERT_DIR = path.join(ROOT, '.cert');
const args = process.argv.slice(2);
const argVal = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const HTTP_PORT = Number(argVal('--port', process.env.PORT || 8080));
const HTTPS_PORT = Number(argVal('--https-port', process.env.HTTPS_PORT || 8443));
const NO_HTTPS = args.includes('--no-https');
const QUIET = args.includes('--quiet');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function lanIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      const v4 = ni.family === 'IPv4' || ni.family === 4;
      if (v4 && !ni.internal) out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

// Make (or re-make, when the LAN addresses changed) the self-signed certificate.
function ensureCert() {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const metaFile = path.join(CERT_DIR, 'ips.json');
  const ips = lanIPv4();
  let covered = [];
  try { covered = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { /* first run */ }
  const fresh = fs.existsSync(keyFile) && fs.existsSync(certFile) && ips.every((ip) => covered.includes(ip));
  if (fresh) return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const alt = ['DNS.1 = localhost', 'IP.1 = 127.0.0.1', ...ips.map((ip, i) => `IP.${i + 2} = ${ip}`)];
  // A config file works with both OpenSSL and the LibreSSL that ships with macOS.
  const conf = [
    '[req]', 'distinguished_name = dn', 'x509_extensions = v3', 'prompt = no',
    '[dn]', 'CN = Metro Rush local dev',
    '[v3]', 'basicConstraints = critical, CA:FALSE', 'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth', 'subjectAltName = @alt',
    '[alt]', ...alt, '',
  ].join('\n');
  const confFile = path.join(CERT_DIR, 'openssl.cnf');
  fs.writeFileSync(confFile, conf);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-keyout', keyFile, '-out', certFile, '-config', confFile,
  ], { stdio: 'ignore' });
  fs.chmodSync(keyFile, 0o600); // the private key is for this user only
  fs.writeFileSync(metaFile, JSON.stringify(ips));
  if (!QUIET) console.log(`Created a self-signed certificate for localhost, 127.0.0.1${ips.length ? ', ' + ips.join(', ') : ''}`);
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

function handler(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (urlPath.includes('\0')) { res.writeHead(400).end('Bad request'); return; }
  if (urlPath.endsWith('/')) urlPath += 'index.html';

  const file = path.resolve(ROOT, '.' + path.posix.normalize(urlPath));
  const rel = path.relative(ROOT, file);
  // Block traversal outside the folder, any dot-file or dot-folder (the certificate
  // lives in .cert/) and node_modules.
  const parts = rel.split(path.sep);
  if (rel.startsWith('..') || path.isAbsolute(rel) || parts.some((p) => p.startsWith('.')) || parts[0] === 'node_modules') {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer(handler).listen(HTTP_PORT, () => {
  if (!QUIET) console.log(`Metro Rush on http://localhost:${HTTP_PORT}  (desktop)`);
});

if (!NO_HTTPS) {
  let creds = null;
  try {
    creds = ensureCert();
  } catch (e) {
    console.warn('Could not create a certificate with openssl, so HTTPS is off:', e.message);
  }
  if (creds) {
    https.createServer(creds, handler).listen(HTTPS_PORT, () => {
      if (QUIET) return;
      console.log(`             https://localhost:${HTTPS_PORT}`);
      const ips = lanIPv4();
      if (ips.length) {
        console.log('\nOn your phone (same Wi-Fi), open:');
        for (const ip of ips) console.log(`   https://${ip}:${HTTPS_PORT}`);
        console.log('The certificate is self-signed: accept the browser warning once ("Advanced" > "Proceed").');
      } else {
        console.log('No LAN address found: connect to Wi-Fi to play on a phone.');
      }
    });
  }
}
