// Vercel CDN caches each response for `fresh` seconds and serves stale copies while
// revalidating, so every viewer shares one upstream fetch per window.
export function send(res, body, fresh) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', `public, max-age=0, s-maxage=${fresh}, stale-while-revalidate=${fresh * 5}`);
  res.status(200).send(JSON.stringify(body));
}
export function fail(res, err) {
  res.setHeader('cache-control', 'no-store');
  res.status(502).json({ error: err.message });
}
