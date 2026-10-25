// Reader-mode article extraction for the in-page news window.
// Resolves Google News redirect links, fetches the publisher page, and runs
// Mozilla Readability over it. Output is rendered client-side in a sandboxed
// iframe (no scripts), and is also stripped of active content here.
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MAX_BYTES = 4 * 1024 * 1024;
const cache = new Map(); // url -> { value, expires }

function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('Invalid URL'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Only http(s) URLs are allowed'), { status: 400 });
  const h = u.hostname.toLowerCase();
  const isIp = /^[\d.]+$/.test(h) || h.includes(':');
  if (isIp || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) {
    throw Object.assign(new Error('Host not allowed'), { status: 400 });
  }
  return u;
}

async function get(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-CA,en;q=0.9', ...(init.headers || {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  return res;
}

// news.google.com/rss/articles/<id> → publisher URL (via Google's batchexecute endpoint)
async function decodeGoogleNews(link) {
  const id = new URL(link).pathname.split('/').pop();
  const page = await (await get(`https://news.google.com/articles/${id}`)).text();
  const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) throw new Error('Could not resolve Google News link');
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg]);
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]]));
  const r = await get('https://news.google.com/_/DotsSplashUi/data/batchexecute', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } });
  const text = await r.text();
  const url = JSON.parse(JSON.parse(text.split('\n\n')[1])[0][2])[1];
  if (!/^https?:\/\//.test(url)) throw new Error('Google News decode returned no URL');
  return url;
}

async function readBody(res) {
  const reader = res.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { reader.cancel(); break; }
    chunks.push(value);
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

function frameable(headers) {
  const xfo = (headers.get('x-frame-options') || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return false;
  const csp = (headers.get('content-security-policy') || '').toLowerCase();
  const fa = csp.match(/frame-ancestors([^;]*)/);
  if (fa && !/\*(\s|$)/.test(fa[1])) return false;
  return true;
}

function meta(document, ...names) {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"]`);
    const v = el?.getAttribute('content');
    if (v) return v.trim();
  }
  return null;
}

function sanitize(html, baseUrl) {
  const { document } = parseHTML(`<!doctype html><html><body><div id="root">${html}</div></body></html>`);
  const root = document.getElementById('root');
  root.querySelectorAll('script, style, iframe, object, embed, form, input, button, link, meta, noscript, svg').forEach((el) => el.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || n === 'style' || n === 'srcset' && el.tagName === 'SOURCE') el.removeAttribute(attr.name);
    }
    for (const a of ['href', 'src']) {
      const v = el.getAttribute(a);
      if (!v) continue;
      try {
        const abs = new URL(v, baseUrl);
        if (!/^https?:$/.test(abs.protocol)) el.removeAttribute(a); else el.setAttribute(a, abs.href);
      } catch { el.removeAttribute(a); }
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy'); el.setAttribute('referrerpolicy', 'no-referrer');
      const ds = el.getAttribute('data-src'); if (!el.getAttribute('src') && ds) { try { el.setAttribute('src', new URL(ds, baseUrl).href); } catch {} }
      el.removeAttribute('srcset');
    }
  }
  return root.innerHTML;
}

export async function getArticle(rawUrl) {
  const hit = cache.get(rawUrl);
  if (hit && hit.expires > Date.now()) return hit.value;

  let target = assertPublicUrl(rawUrl).href;
  if (/(^|\.)news\.google\.com$/i.test(new URL(target).hostname) && /\/articles\//.test(target)) {
    target = assertPublicUrl(await decodeGoogleNews(target)).href;
  }
  const res = await get(target);
  const finalUrl = assertPublicUrl(res.url || target).href;
  const base = { url: rawUrl, articleUrl: finalUrl, frameable: res.ok && frameable(res.headers) };
  if (!res.ok) return { ...base, ok: false, error: `Publisher returned ${res.status}${res.status === 403 ? ' (blocks automated readers)' : ''}` };
  if (!/html/i.test(res.headers.get('content-type') || 'text/html')) return { ...base, ok: false, error: 'Not an HTML page' };

  const html = await readBody(res);
  const { document } = parseHTML(html);
  const info = {
    siteName: meta(document, 'og:site_name', 'application-name') || new URL(finalUrl).hostname.replace(/^www\./, ''),
    image: meta(document, 'og:image', 'twitter:image'),
    published: meta(document, 'article:published_time', 'og:article:published_time', 'parsely-pub-date', 'date'),
  };
  let article = null;
  try { article = new Readability(document, { charThreshold: 300 }).parse(); } catch (e) { console.error('readability:', e.message); }
  const value = article && article.content && (article.textContent || '').trim().length > 200
    ? { ...base, ok: true, ...info, title: article.title, byline: article.byline, excerpt: article.excerpt, content: sanitize(article.content, finalUrl), length: article.length }
    : { ...base, ok: false, ...info, title: meta(document, 'og:title') || document.title, excerpt: meta(document, 'og:description', 'description'), error: 'Could not extract readable text (likely paywalled or script-rendered)' };
  if (info.image) { try { value.image = new URL(info.image, finalUrl).href; } catch { value.image = null; } }

  cache.set(rawUrl, { value, expires: Date.now() + 10 * 60 * 1000 });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}
