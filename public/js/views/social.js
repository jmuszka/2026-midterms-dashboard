/* Social feeds: the pundit lists (Bluesky; X when a token is configured) and the
 * dedicated Trump / Truth Social feed. One window shows one list. */
import { app, hub, esc, timeAgo, fmt } from '../core.js';

function linkify(text) {
  return esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//, '').slice(0, 42)}${u.length > 50 ? '…' : ''}</a>`)
    .replace(/(^|\s)@([A-Za-z0-9_.-]{1,40}[A-Za-z0-9_])/g, (m, pre, h) => `${pre}<span class="mention">@${h}</span>`);
}
export const PLATFORM = { bluesky: 'Bluesky', x: 'X', truthsocial: 'Truth Social' };
export function post(p) {
  const a = p.author || {};
  const media = (p.media || []).filter((m) => m.url || m.link);
  return `<article class="post p-${p.platform}">
    ${p.repostBy ? `<div class="rt">Reposted by ${esc(p.repostBy.name || p.repostBy.handle)}</div>` : ''}
    ${a.avatar ? `<img class="av" src="${esc(a.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="av ph">${esc((a.name || '?')[0])}</span>`}
    <div class="pb">
      <div class="hd"><b>${esc(a.name || a.handle)}</b><span>@${esc(a.handle || '')}</span><span>·</span><a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.createdAt || '')}">${timeAgo(p.createdAt)}</a><span class="plat">${PLATFORM[p.platform] || ''}</span></div>
      ${p.text ? `<div class="tx">${linkify(p.text)}</div>` : ''}
      ${media.length ? `<div class="media">${media.map((m) => (m.url ? `<a href="${esc(m.link || p.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>` : `<a class="vid" href="${esc(m.link)}" target="_blank" rel="noopener">${m.type === 'video' ? 'Video' : 'Media'} ↗</a>`)).join('')}</div>` : ''}
      ${p.card ? `<a class="card" href="${esc(p.card.url)}" target="_blank" rel="noopener">${p.card.image ? `<img src="${esc(p.card.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<span>${esc(p.card.title || p.card.url)}</span></a>` : ''}
      ${p.quoted ? `<div class="quote"><div class="hd"><b>${esc(p.quoted.author?.name || '')}</b><span>@${esc(p.quoted.author?.handle || '')}</span></div><div class="tx">${linkify(p.quoted.text || '')}</div></div>` : ''}
      ${p.metrics ? `<div class="metrics muted">${fmt(p.metrics.replies)} replies · ${fmt(p.metrics.reposts)} reposts · ${fmt(p.metrics.likes)} likes</div>` : ''}
    </div></article>`;
}

export default {
  type: 'social', name: 'Social list (one list)',
  defaults: { list: 'analysts' },
  settings: [{ key: 'list', label: 'List', options: () => Object.entries(app.config.social).map(([k, v]) => [k, v.name]) }],
  title: (s) => app.config.social[s.list]?.name || 'Social',
  mount(body, settings, ctx) {
    let un = null;
    const start = () => {
      un?.();
      body.className = `panel-body feed-list social s-${settings.list}`;
      body.innerHTML = '<p class="muted pad">Loading…</p>';
      ctx.title(app.config.social[settings.list]?.name || 'Social');
      un = hub.subscribe(`social:${settings.list}`, (s) => {
        const d = s.data;
        if (!d) { body.innerHTML = `<p class="feed-error">${esc(s.error || 'Loading…')}</p>`; return; }
        const errs = d.errors || [];
        body.innerHTML = (d.posts.map(post).join('') || '<p class="muted pad">No posts yet.</p>')
          + (errs.length ? `<p class="feed-error">${errs.map(esc).join('<br>')}</p>` : '');
        const via = d.posts.find((p) => p.via) ? ` · via ${d.posts.find((p) => p.via).via} archive` : '';
        ctx.meta(`${d.posts.length} posts · ${timeAgo(d.ranAt)}${via}${d.stale ? ' · stale' : ''}`);
      });
    };
    start();
    return { destroy: () => un?.(), settingsChanged: start };
  },
};
