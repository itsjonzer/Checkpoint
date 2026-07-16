'use strict';

/* ============================================================
   Checkpoint server — serves the app and stores the shared data
   snapshot. No dependencies; requires only Node.js (18+).

     node server.js

   Environment variables:
     PORT              port to listen on          (default 8787)
     CHECKPOINT_TOKEN  optional passcode; when set, API calls must
                       send "Authorization: Bearer <token>". Users
                       are prompted for it by the app on first use.

   Data is stored in checkpoint-data.json next to this file.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.CHECKPOINT_TOKEN || '';
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'checkpoint-data.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function authorized(req) {
  if (!TOKEN) return true;
  return req.headers.authorization === 'Bearer ' + TOKEN;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, headers));
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  /* ---------- Data API ---------- */
  if (url.pathname === '/api/data') {
    if (!authorized(req)) return send(res, 401, 'unauthorized');

    if (req.method === 'GET') {
      fs.readFile(DATA_FILE, (err, buf) => {
        if (err) return send(res, 404, '');
        send(res, 200, buf, { 'Content-Type': 'application/json; charset=utf-8' });
      });
      return;
    }

    if (req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 5e6) req.destroy(); // snapshots are small; reject runaways
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data || !Array.isArray(data.tasks)) throw new Error('bad payload');
          // atomic write: temp file + rename, so a crash never corrupts data
          const tmp = DATA_FILE + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
          fs.renameSync(tmp, DATA_FILE);
          send(res, 200, JSON.stringify({ ok: true, savedAt: data.savedAt || Date.now() }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        } catch (e) {
          send(res, 400, 'invalid Checkpoint payload');
        }
      });
      return;
    }

    return send(res, 405, '');
  }

  /* ---------- Static files ---------- */
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, '');

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(ROOT, pathname));

  // no path traversal, and never serve the data file or server internals
  const base = path.basename(file).toLowerCase();
  if (!file.startsWith(ROOT) || base.startsWith('checkpoint-data') || base === 'server.js') {
    return send(res, 403, 'forbidden');
  }

  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Checkpoint server running at http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(TOKEN ? 'Passcode protection: ON' : 'Passcode protection: off (set CHECKPOINT_TOKEN to enable)');
});
