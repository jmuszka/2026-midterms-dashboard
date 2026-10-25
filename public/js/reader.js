/* News reader window (ported from the BC dashboard). Clicking a headline opens it in a
 * pop-up: /api/article decodes Google News links, extracts the text with Readability,
 * and the result renders in a script-free sandboxed iframe. Ctrl/Cmd-click opens the site. */
import { $, esc } from './core.js';

const reader = { items: [], idx: -1, item: null, data: null, mode: 'reader', token: 0 };
function readerDoc(a, item) {
  const when = a.published ? new Date(a.published) : item.published ? new Date(item.published) : null;
  const css = `
    :root { color-scheme: dark; }
    body { margin: 0; background: #12161c; color: #dfe3e8; font: 18px/1.65 Georgia, "Iowan Old Style", "Times New Roman", serif; }
    main { max-width: 700px; margin: 0 auto; padding: 32px 28px 80px; }
    .kicker { font: 600 12px/1.4 system-ui, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #8b96a3; }
    h1 { font: 700 32px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; margin: 8px 0 10px; color: #f3f5f7; }
    .by { font: 14px/1.4 system-ui, sans-serif; color: #8b96a3; margin-bottom: 22px; }
    .hero { width: 100%; border-radius: 8px; margin: 0 0 20px; }
    img, video, figure { max-width: 100%; height: auto; }
    figure { margin: 22px 0; } figcaption { font: 13px/1.4 system-ui, sans-serif; color: #8b96a3; margin-top: 6px; }
    a { color: #7fb0f5; } h2, h3, h4 { font-family: system-ui, sans-serif; color: #f3f5f7; line-height: 1.3; margin: 1.6em 0 .5em; }
    blockquote { margin: 1.2em 0; padding: 2px 0 2px 16px; border-left: 3px solid #3A7BE0; color: #c4cad1; }
    table { border-collapse: collapse; font: 14px system-ui, sans-serif; } td, th { border: 1px solid #2a323d; padding: 4px 8px; }
    pre, code { font-size: 14px; white-space: pre-wrap; }
    .note { font: 14px/1.5 system-ui, sans-serif; color: #f0c674; background: #2a2416; border: 1px solid #4a3f22; padding: 12px 14px; border-radius: 8px; }
    .end { margin-top: 36px; font: 14px system-ui, sans-serif; color: #8b96a3; border-top: 1px solid #2a323d; padding-top: 14px; }`;
  const heroInContent = a.image && a.content && a.content.includes(a.image.split('?')[0]);
  const body = a.ok
    ? `${a.image && !heroInContent ? `<img class="hero" src="${esc(a.image)}" alt="" referrerpolicy="no-referrer">` : ''}${a.content}`
    : `<p class="note">${esc(a.error || 'Could not load this article.')} Use “Open original ↗” to read it on ${esc(a.siteName || item.source)}.</p>${a.excerpt ? `<p>${esc(a.excerpt)}</p>` : ''}`;
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${css}</style></head><body><main>
    <div class="kicker">${esc(a.siteName || item.source)}</div>
    <h1>${esc(a.title || item.title)}</h1>
    <div class="by">${[a.byline, when && !isNaN(when) ? when.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : ''].filter(Boolean).map(esc).join(' · ')}</div>
    ${body}
    <p class="end">Reader view extracted from <a href="${esc(a.articleUrl || item.link)}">${esc(a.siteName || item.source)}</a>.</p>
  </main></body></html>`;
}
function setMode(mode) {
  reader.mode = mode;
  const frame = $('#reader-frame');
  $('#reader-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('.reader-body').classList.toggle('original', mode === 'original');
  if (mode === 'original' && reader.data?.articleUrl) { frame.removeAttribute('srcdoc'); frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms'); frame.src = reader.data.articleUrl; }
  else if (reader.data) { frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox'); frame.removeAttribute('src'); frame.srcdoc = readerDoc(reader.data, reader.item); }
}
export async function openReader(items, idx) {
  const item = items[idx];
  if (!item) return;
  const token = ++reader.token;
  Object.assign(reader, { items, idx, item, data: null });
  $('#reader').hidden = false;
  $('#reader-src').innerHTML = `<b>${esc(item.source)}</b> · ${esc(item.title)}`;
  $('#reader-open').href = item.link;
  $('#reader-mode').hidden = true;
  $('#reader-prev').disabled = idx <= 0;
  $('#reader-next').disabled = idx >= items.length - 1;
  const frame = $('#reader-frame');
  frame.removeAttribute('src'); frame.srcdoc = '<body style="background:#12161c"></body>';
  $('#reader-msg').innerHTML = '<div><div class="spinner"></div>Loading article…</div>';
  let a;
  try { a = await (await fetch(`/api/article?url=${encodeURIComponent(item.link)}`)).json(); } catch (e) { a = { ok: false, error: e.message }; }
  if (token !== reader.token) return;
  reader.data = a;
  $('#reader-msg').innerHTML = '';
  if (a.articleUrl) $('#reader-open').href = a.articleUrl;
  $('#reader-mode').hidden = !(a.frameable && a.articleUrl);
  setMode(!a.ok && a.frameable && a.articleUrl ? 'original' : 'reader');
  // keep focus on the dialog, not the iframe: a focused iframe swallows Esc and the arrow keys
  $('.reader-win').focus();
}
export const readerOpenItem = () => reader.item;
function close() {
  reader.token++; reader.item = null;
  $('#reader').hidden = true;
  $('#reader-frame').removeAttribute('src'); $('#reader-frame').srcdoc = '';
}
export function setupReader() {
  $('#reader').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  $('#reader-mode').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('#reader-prev').addEventListener('click', () => openReader(reader.items, reader.idx - 1));
  $('#reader-next').addEventListener('click', () => openReader(reader.items, reader.idx + 1));
  document.addEventListener('keydown', (e) => {
    if ($('#reader').hidden) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && reader.idx > 0) openReader(reader.items, reader.idx - 1);
    else if (e.key === 'ArrowRight' && reader.idx < reader.items.length - 1) openReader(reader.items, reader.idx + 1);
  });
}
