// Local dev server: static files from public/ + the same API as the Vercel functions.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, getResults, getNews, getTweets, publicConfig } from './lib/feeds.mjs';
import { getArticle } from './lib/article.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || config.port || 8787);

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.geojson': 'application/geo+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function serveStatic(res, baseDir, rel, cacheControl) {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cacheControl });
    res.end(data);
  } catch { json(res, 404, { error: 'not found' }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/api/config') return json(res, 200, publicConfig());
    if (p === '/api/results') return json(res, 200, await getResults());
    if (p === '/api/news') return json(res, 200, await getNews());
    if (p === '/api/article') {
      const target = url.searchParams.get('url');
      if (!target) return json(res, 400, { ok: false, error: 'Missing url' });
      try { return json(res, 200, await getArticle(target)); }
      catch (e) { return json(res, e.status || 502, { ok: false, url: target, error: e.message }); }
    }
    if (p === '/api/tweets') {
      try { return json(res, 200, await getTweets()); }
      catch (e) { return json(res, 200, { ok: false, handle: config.twitter.handle, error: e.message }); }
    }
    return serveStatic(res, path.join(ROOT, 'public'), p === '/' ? 'index.html' : p.slice(1), 'no-cache');
  } catch (e) {
    console.error(e);
    return json(res, 502, { error: e.message });
  }
});
server.listen(PORT, () => {
  console.log(`BC election dashboard → http://localhost:${PORT}`);
  console.log(`Results: ${config.electionsBC.base}/${config.electionsBC.eventPrefix}_Candidate.csv`);
});
