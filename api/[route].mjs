// Single Vercel function for every /api/<route> (see lib/routes.mjs). One function
// keeps the deployment small and shares warm instances (and their caches) across routes.
import { handle, cacheHeader } from '../lib/routes.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const route = url.pathname.replace(/^\/api\//, '').split('/')[0];
  const out = await handle({ route, query: url.searchParams, headers: req.headers });
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cacheHeader(out.cache));
  res.status(out.status).send(JSON.stringify(out.body));
}
