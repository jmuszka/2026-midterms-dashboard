// Local dev server: static files from public/ + the same /api routes as the Vercel
// function, plus a background poll loop (the "worker"). Set STORE_FILE to keep
// snapshots and events across restarts, e.g. STORE_FILE=.cache/store.json npm start
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, cacheHeader } from './lib/routes.mjs';
import { runPoll } from './lib/poll.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const out = await handle({ route: url.pathname.slice(5).split('/')[0], query: url.searchParams, headers: req.headers });
    res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheHeader(out.cache) });
    return res.end(JSON.stringify(out.body));
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
});

server.listen(PORT, () => console.log(`US midterms dashboard → http://localhost:${PORT}`));

// background worker: run due tasks every 15 s (each task has its own interval)
if (!process.env.NO_POLL) {
  const tick = () => runPoll().then((s) => {
    const ran = Object.entries(s.tasks).filter(([, v]) => !v.skipped).map(([k, v]) => `${k}${v.ok ? '' : ' FAILED: ' + v.error}`);
    if (ran.length) console.log(`[poll ${new Date().toLocaleTimeString()}] ${ran.join(', ')}`);
  }).catch((e) => console.error('poll loop:', e.message));
  tick(); setInterval(tick, 15000);
}
