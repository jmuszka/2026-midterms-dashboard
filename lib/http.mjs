// Shared fetch helpers for every adapter: browser-like UA (Clarity, PredictIt and
// YouTube refuse bare clients), timeouts, and one retry on 429/5xx.
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export class HttpError extends Error {
  constructor(status, url, body = '') { super(`${status} for ${url.replace(/\?.*$/, '')}`); this.status = status; this.body = body.slice(0, 300); }
}

export async function fetchText(url, opts = {}) {
  const tries = opts.tries ?? 2;
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        body: opts.body,
        headers: { 'user-agent': UA, accept: opts.accept || '*/*', 'accept-language': 'en-US,en;q=0.9', ...(opts.headers || {}) },
        signal: AbortSignal.timeout(opts.timeout || 15000),
        redirect: 'follow',
      });
    } catch (e) {
      if (i + 1 < tries) { await sleep(500 * (i + 1)); continue; }
      throw new Error(`${e.name === 'TimeoutError' ? 'timeout' : e.message} for ${url.replace(/\?.*$/, '')}`);
    }
    if (res.ok) return { text: await res.text(), headers: res.headers, status: res.status, url: res.url };
    const body = await res.text().catch(() => '');
    if (i + 1 < tries && (res.status === 429 || res.status >= 500)) { await sleep(800 * (i + 1)); continue; }
    throw new HttpError(res.status, url, body);
  }
}
export async function fetchJSON(url, opts = {}) {
  const { text } = await fetchText(url, { accept: 'application/json', ...opts });
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error(`invalid JSON from ${url.replace(/\?.*$/, '')}`); }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// run fn over items with at most n in flight; failures come back as { error }
export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; } }
  }));
  return out;
}
