import { getArticle } from '../lib/article.mjs';
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x').searchParams.get('url');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (!url) { res.status(400).send(JSON.stringify({ ok: false, error: 'Missing url' })); return; }
  try {
    const a = await getArticle(url);
    res.setHeader('cache-control', 'public, max-age=300, s-maxage=900, stale-while-revalidate=3600');
    res.status(200).send(JSON.stringify(a));
  } catch (e) {
    res.setHeader('cache-control', 'no-store');
    res.status(e.status || 502).send(JSON.stringify({ ok: false, url, error: e.message }));
  }
}
