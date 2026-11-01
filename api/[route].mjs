// Single Vercel function for every /api/<route> (see lib/routes.mjs). One function
// keeps the deployment small and shares warm instances (and their caches) across routes.
import zlib from 'node:zlib';
import { handle, cacheHeader } from '../lib/routes.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // Vercel rewrites /api/x to /api/[route]?route=x; fall back to the path for other hosts
  const route = url.searchParams.get('route') || url.pathname.replace(/^\/api\//, '').split('/')[0];
  const out = await handle({ route, query: url.searchParams, headers: req.headers });
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheHeader(out.cache));
  res.setHeader('vary', 'accept-encoding');
  const json = Buffer.from(JSON.stringify(out.body));
  // Compress big bodies here, not at the CDN: Vercel's 4.5 MB function response limit applies to
  // what the function sends, and the timeline bundle grows through election night (~4.5:1 compression).
  const enc = json.length > 32768 ? (/\bbr\b/.test(req.headers['accept-encoding'] || '') ? 'br' : /\bgzip\b/.test(req.headers['accept-encoding'] || '') ? 'gzip' : null) : null;
  res.status(out.status);
  if (!enc) return res.end(json);
  res.setHeader('content-encoding', enc);
  res.end(enc === 'br' ? zlib.brotliCompressSync(json, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : zlib.gzipSync(json, { level: 6 }));
}
