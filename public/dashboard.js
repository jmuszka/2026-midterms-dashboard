/* BC Election Night dashboard — frontend */
const $ = (s) => document.querySelector(s);
const fmt = (n) => (n ?? 0).toLocaleString('en-CA');
const pct1 = (n) => `${(n ?? 0).toFixed(1)}%`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { config: null, parties: new Map(), geo: null, results: null, pinned: null, filter: '', newsSeen: new Set(), firstNews: true, lastResultsAt: 0, xMode: null };

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const party = (id) => state.parties.get(id) || { id, name: id, short: id, color: '#888' };

/* ---------------- init ---------------- */
async function init() {
  state.config = await getJSON('/api/config');
  for (const p of state.config.parties) state.parties.set(p.id, p);
  $('#x-link').textContent = `@${state.config.twitter.handle}`;
  $('#x-link').href = `https://x.com/${state.config.twitter.handle}`;
  renderLegend();
  setupVideo();
  state.geo = await getJSON('/data/bc-electoral-districts-2023.geojson');
  setupMap();
  await Promise.allSettled([loadResults(), loadNews(), loadTweets()]);
  setInterval(loadResults, (state.config.resultsRefreshSeconds || 60) * 1000);
  setInterval(loadNews, (state.config.news.refreshSeconds || 120) * 1000);
  setInterval(loadTweets, (state.config.twitter.refreshSeconds || 120) * 1000);
  setInterval(tickStatus, 5000);
  $('#riding-filter').addEventListener('input', (e) => { state.filter = e.target.value.toLowerCase(); renderTable(); });
  $('#riding-filter').addEventListener('click', (e) => e.stopPropagation());
}

function renderLegend() {
  $('#legend').innerHTML = state.config.parties.filter((p) => p.id !== 'OTH')
    .map((p) => `<span><i class="chip" style="--c:${p.color}"></i>${esc(p.name)}</span>`).join('');
}

/* ---------------- results ---------------- */
async function loadResults() {
  try {
    const r = await getJSON('/api/results');
    state.results = r;
    state.lastResultsAt = Date.now();
    renderSummary(); paintMap(); renderTable(); renderDetail();
    tickStatus();
  } catch (e) {
    $('#status').innerHTML = `<span class="warn">Results fetch failed: ${esc(e.message)}</span>`;
  }
}
function tickStatus() {
  const r = state.results; if (!r) return;
  const s = r.summary;
  const boxesPct = s.boxesTotal ? Math.round((s.boxesReported / s.boxesTotal) * 100) : 0;
  const asOf = r.asOf ? r.asOf.replace(/^\d{2}\/\d{2}\/\d{4}\s*/, '') : '';
  $('#status').innerHTML =
    `Elections BC initial count · as of <b>${esc(asOf)}</b> PT · ` +
    `<b>${s.reportingRidings}</b>/${s.ridings} ridings reporting · ` +
    `<b>${fmt(s.boxesReported)}</b>/${fmt(s.boxesTotal)} ballot boxes (${boxesPct}%) · ` +
    `${fmt(s.totalVotes)} votes · refreshed ${timeAgo(state.lastResultsAt)}` +
    (r.stale ? ' <span class="warn">(stale — upstream error)</span>' : '');
}
function renderSummary() {
  const { parties, summary } = state.results;
  const order = Object.values(parties).sort((a, b) => (b.elected + b.leading) - (a.elected + a.leading) || b.votes - a.votes);
  const seatbar = $('#seatbar');
  seatbar.innerHTML = order.flatMap((p) => {
    const segs = [];
    if (p.elected) segs.push(`<div class="seg" style="--c:${party(p.id).color}; width:${(p.elected / summary.seats) * 100}%" title="${esc(party(p.id).name)}: ${p.elected} elected/projected"></div>`);
    if (p.leading) segs.push(`<div class="seg leading" style="--c:${party(p.id).color}; width:${(p.leading / summary.seats) * 100}%" title="${esc(party(p.id).name)}: ${p.leading} leading"></div>`);
    return segs;
  }).join('');
  const shown = order.filter((p) => p.elected + p.leading > 0 || p.pct >= 0.5 || ['CP', 'NDP', 'GP'].includes(p.id));
  $('#party-tiles').innerHTML = shown.map((p) => {
    const meta = party(p.id);
    return `<div class="tile" style="--c:${meta.color}">
      <div class="name"><span>${esc(meta.name)}</span><span>${esc(meta.short)}</span></div>
      <div class="seats">${p.elected + p.leading}<small>${p.elected} elected · ${p.leading} leading</small></div>
      <div class="votes">${pct1(p.pct)} · ${fmt(p.votes)} votes</div>
    </div>`;
  }).join('');
}

/* ---------------- map ---------------- */
const MAP = { W: 1000, H: 720, groups: [] };
function centroidIn(f, bbox) {
  const [x, y] = d3.geoCentroid(f);
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}
function setupMap() {
  const svg = d3.select('#map').attr('viewBox', `0 0 ${MAP.W} ${MAP.H}`);
  svg.selectAll('*').remove();
  const feats = state.geo.features;
  const views = [
    { id: 'main', label: '', extent: [[8, 8], [600, MAP.H - 8]], features: feats, proj: d3.geoConicConformal().parallels([50, 58.5]).rotate([126, 0]) },
    { id: 'metro', label: 'Metro Vancouver', extent: [[618, 28], [992, 420]], features: feats.filter((f) => centroidIn(f, [-123.35, 48.95, -122.4, 49.45])), proj: d3.geoMercator() },
    { id: 'victoria', label: 'Greater Victoria', extent: [[618, 460], [992, MAP.H - 8]], features: feats.filter((f) => centroidIn(f, [-123.55, 48.38, -123.25, 48.70])), proj: d3.geoMercator() },
  ];
  const defs = svg.append('defs');
  for (const v of views) {
    const fc = { type: 'FeatureCollection', features: v.features };
    const pad = v.id === 'main' ? 0 : 10;
    v.proj.fitExtent([[v.extent[0][0] + pad, v.extent[0][1] + pad], [v.extent[1][0] - pad, v.extent[1][1] - pad]], fc);
    const path = d3.geoPath(v.proj);
    const [[x0, y0], [x1, y1]] = v.extent;
    if (v.id !== 'main') {
      defs.append('clipPath').attr('id', `clip-${v.id}`).append('rect').attr('x', x0 - 6).attr('y', y0 - 6).attr('width', x1 - x0 + 12).attr('height', y1 - y0 + 12);
      svg.append('rect').attr('class', 'inset-frame').attr('x', x0 - 6).attr('y', y0 - 6).attr('width', x1 - x0 + 12).attr('height', y1 - y0 + 12).attr('rx', 6);
      svg.append('text').attr('class', 'inset-label').attr('x', x0).attr('y', y0 - 10).text(v.label);
    }
    const g = svg.append('g').attr('clip-path', v.id !== 'main' ? `url(#clip-${v.id})` : null);
    g.selectAll('path').data(v.id === 'main' ? v.features : feats).join('path')
      .attr('class', 'riding none')
      .attr('data-code', (d) => d.properties.ED_ABBREVIATION)
      .attr('d', path)
      .on('mousemove', (ev, d) => showTooltip(ev, d.properties.ED_ABBREVIATION))
      .on('mouseleave', hideTooltip)
      .on('click', (ev, d) => { const code = d.properties.ED_ABBREVIATION; state.pinned = state.pinned === code ? null : code; renderDetail(); paintMap(); renderTable(); });
    MAP.groups.push(g);
  }
}
function paintMap() {
  if (!state.results) return;
  const byCode = new Map(state.results.ridings.map((r) => [r.code, r]));
  d3.selectAll('#map path.riding').each(function (d) {
    const code = d.properties.ED_ABBREVIATION;
    const r = byCode.get(code);
    const el = d3.select(this);
    el.classed('pinned', state.pinned === code);
    if (!r || !r.call.leader) { el.classed('none', true).style('fill', null).style('fill-opacity', null); return; }
    const c = party(r.call.leader).color;
    el.classed('none', false).style('fill', c)
      .style('fill-opacity', r.call.status === 'elected' ? 1 : 0.3 + 0.5 * Math.min(1, r.call.frac));
  });
}
function statusBadge(r) {
  const c = r.call;
  if (c.status === 'elected') return c.basis === 'complete' ? '<span class="badge elected">Elected · count complete</span>' : '<span class="badge projected">Projected</span>';
  if (c.status === 'leading') return '<span class="badge leading">Leading</span>';
  if (c.status === 'tied') return '<span class="badge">Tied</span>';
  return '<span class="badge">No results</span>';
}
function ridingHTML(r, max = 5) {
  const cands = r.candidates.slice(0, max).map((c) => {
    const m = party(c.party);
    const share = r.totalValid ? (c.votes / r.totalValid) * 100 : 0;
    return `<li class="cand" style="--c:${m.color}; --w:${share}%">
      <i class="chip" style="--c:${m.color}"></i>
      <span class="nm">${esc(c.name)} <small>${esc(m.short)}</small></span>
      <span class="v">${fmt(c.votes)}</span><span class="pct">${pct1(share)}</span>
      <span class="bar"><i></i></span></li>`;
  }).join('');
  const more = r.candidates.length > max ? `<li class="muted" style="font-size:11px">+${r.candidates.length - max} more</li>` : '';
  const boxesPct = r.boxes.total ? Math.round((r.boxes.reported / r.boxes.total) * 100) : 0;
  return `<h3>${esc(r.name)} ${statusBadge(r)}</h3>
    <div class="meta">${r.boxes.reported} of ${r.boxes.total} ballot boxes reported (${boxesPct}%) · advance ${r.advance.reported}/${r.advance.total} · election day ${r.finalDay.reported}/${r.finalDay.total}${r.call.marginPct != null && r.call.leader ? ` · margin ${pct1(r.call.marginPct)}` : ''}</div>
    <ol class="cands">${cands}${more}</ol>`;
}
function findRiding(code) { return state.results?.ridings.find((r) => r.code === code); }
function showTooltip(ev, code) {
  const r = findRiding(code); const tip = $('#tooltip');
  const f = state.geo.features.find((f) => f.properties.ED_ABBREVIATION === code);
  tip.innerHTML = r ? ridingHTML(r, 4) : `<h3>${esc(f?.properties.ED_NAME || code)}</h3><div class="meta">No results yet</div>`;
  tip.hidden = false;
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + tip.offsetWidth > innerWidth - 8) x = ev.clientX - tip.offsetWidth - 14;
  if (y + tip.offsetHeight > innerHeight - 8) y = Math.max(8, ev.clientY - tip.offsetHeight - 14);
  tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${y}px`;
}
function hideTooltip() { $('#tooltip').hidden = true; }
function renderDetail() {
  const el = $('#riding-detail');
  if (!state.pinned) { el.innerHTML = '<p class="muted">Hover a riding for details, click to pin it here.</p>'; return; }
  const r = findRiding(state.pinned);
  el.innerHTML = r ? ridingHTML(r, 8) : '<p class="muted">No results yet for this riding.</p>';
}
function renderTable() {
  if (!state.results) return;
  const rank = { elected: 0, leading: 1, tied: 2, none: 3 };
  const rows = state.results.ridings
    .filter((r) => !state.filter || r.name.toLowerCase().includes(state.filter) || r.candidates.some((c) => c.name.toLowerCase().includes(state.filter)))
    .sort((a, b) => rank[a.call.status] - rank[b.call.status] || a.name.localeCompare(b.name));
  $('#riding-list tbody').innerHTML = rows.map((r) => {
    const lead = r.candidates[0];
    const m = lead ? party(lead.party) : null;
    return `<tr data-code="${r.code}" class="${state.pinned === r.code ? 'pinned' : ''}">
      <td>${esc(r.name)}</td>
      <td>${lead && r.call.leader ? esc(lead.name) : '<span class="muted">—</span>'}</td>
      <td>${m && r.call.leader ? `<i class="chip" style="--c:${m.color}"></i> ${esc(m.short)}` : ''}</td>
      <td class="num">${r.call.leader ? pct1(r.call.marginPct) : ''}</td>
      <td class="num">${r.boxes.reported}/${r.boxes.total}</td>
      <td>${statusBadge(r)}</td></tr>`;
  }).join('');
  $('#riding-list tbody').querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => {
    state.pinned = tr.dataset.code; renderDetail(); paintMap(); renderTable();
  }));
}

/* ---------------- video ---------------- */
function parseYouTube(input) {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/(?:youtu\.be\/|v=|\/live\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || s.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}
function setVideo(src, label) {
  $('#video').src = src;
  $('#video-title').textContent = label;
}
function setupVideo() {
  const yt = state.config.youtube;
  let saved = null; try { saved = localStorage.getItem('bc-dash-video'); } catch {}
  const id = saved || yt.videoId;
  if (id === 'channel') setVideo(`https://www.youtube.com/embed/live_stream?channel=${yt.channelId}&autoplay=1&mute=1`, 'CBC News — channel live');
  else setVideo(`https://www.youtube.com/embed/${id}?autoplay=1&mute=1`, yt.title || 'CBC live stream');
  $('#video-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const vid = parseYouTube($('#video-input').value);
    if (!vid) return;
    setVideo(`https://www.youtube.com/embed/${vid}?autoplay=1&mute=1`, `YouTube · ${vid}`);
    try { localStorage.setItem('bc-dash-video', vid); } catch {}
  });
  $('#video-channel-live').addEventListener('click', () => {
    setVideo(`https://www.youtube.com/embed/live_stream?channel=${yt.channelId}&autoplay=1&mute=1`, 'CBC News — channel live');
    try { localStorage.setItem('bc-dash-video', 'channel'); } catch {}
  });
}

/* ---------------- news ---------------- */
async function loadNews() {
  try {
    const n = await getJSON('/api/news');
    const list = $('#news-list');
    state.newsItems = n.items;
    list.innerHTML = n.items.map((i, idx) => {
      const isNew = !state.firstNews && !state.newsSeen.has(i.link);
      return `<li class="news-item${reader.item?.link === i.link ? ' active' : ''}" data-idx="${idx}">
        <div class="src"><b>${esc(i.source)}</b><span>${i.published ? timeAgo(i.published) : ''}</span>${isNew ? '<span class="new">● new</span>' : ''}</div>
        <a class="t" href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a>
        ${i.description ? `<div class="d">${esc(i.description)}</div>` : ''}</li>`;
    }).join('') || '<li class="muted" style="padding:10px 14px">No articles yet.</li>';
    n.items.forEach((i) => state.newsSeen.add(i.link));
    if (reader.item) {
      const k = n.items.findIndex((i) => i.link === reader.item.link);
      reader.idx = k >= 0 ? k : -1;
      $('#reader-prev').disabled = reader.idx <= 0;
      $('#reader-next').disabled = reader.idx < 0 || reader.idx >= n.items.length - 1;
    }
    state.firstNews = false;
    $('#news-meta').textContent = `${n.items.length} articles · ${timeAgo(n.fetchedAt)}` + (n.errors?.length ? ' · some feeds failed' : '');
    $('#news-meta').title = (n.errors || []).join('\n');
  } catch (e) {
    $('#news-list').innerHTML = `<li class="feed-error">News feed error: ${esc(e.message)}</li>`;
  }
}

/* ---------------- X / Twitter ---------------- */
function linkify(text) {
  return esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//, '').slice(0, 40)}</a>`)
    .replace(/(^|\s)@([A-Za-z0-9_]{1,15})/g, (m, pre, h) => `${pre}<a href="https://x.com/${h}" target="_blank" rel="noopener">@${h}</a>`);
}
function tweetHTML(t) {
  const inner = t.retweetOf || t;
  const a = inner.author || {};
  return `<article class="tweet">
    ${t.retweetOf ? `<div class="rt">↻ ${esc(t.author?.name || '@' + t.author?.handle)} reposted</div>` : ''}
    ${a.avatar ? `<img class="av" src="${esc(a.avatar)}" alt="">` : '<span></span>'}
    <div>
      <div class="hd"><b>${esc(a.name || a.handle || '')}</b><span>@${esc(a.handle || '')}</span><span>·</span><a href="${esc(inner.url)}" target="_blank" rel="noopener" title="${esc(inner.createdAt || '')}">${timeAgo(inner.createdAt)}</a></div>
      <div class="tx">${linkify(inner.text)}</div>
      ${inner.media?.length ? `<div class="media">${inner.media.filter((m) => m.url).map((m) => `<a href="${esc(inner.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}?name=small" alt=""></a>`).join('')}</div>` : ''}
      ${inner.quoted ? `<div class="quote"><div class="hd"><b>${esc(inner.quoted.author?.name || '')}</b><span>@${esc(inner.quoted.author?.handle || '')}</span></div><div class="tx">${linkify(inner.quoted.text)}</div></div>` : ''}
    </div></article>`;
}
async function loadTweets() {
  const handle = state.config.twitter.handle;
  try {
    const t = await getJSON('/api/tweets');
    if (t.ok && t.tweets?.length) {
      state.xMode = 'api';
      $('#x-feed').innerHTML = t.tweets.map(tweetHTML).join('');
      $('#x-meta').textContent = `${t.tweets.length} posts · ${timeAgo(t.fetchedAt)}${t.stale ? ' · stale' : ''}`;
      return;
    }
    if (state.xMode !== 'widget') mountWidget(handle, t.error);
  } catch (e) {
    if (state.xMode !== 'widget') mountWidget(handle, e.message);
  }
}
function mountWidget(handle, reason) {
  state.xMode = 'widget';
  $('#x-meta').textContent = 'embedded timeline';
  $('#x-meta').title = reason ? `Server-side fetch unavailable: ${reason}` : '';
  const box = $('#x-feed');
  box.innerHTML = `<div class="fallback"><a class="twitter-timeline" data-theme="dark" data-dnt="true" data-chrome="noheader nofooter noborders transparent" href="https://twitter.com/${handle}?ref_src=twsrc%5Etfw">Loading posts by @${handle}…</a></div>`;
  if (!document.querySelector('script[src*="platform.twitter.com/widgets.js"]')) {
    const s = document.createElement('script'); s.src = 'https://platform.twitter.com/widgets.js'; s.async = true; document.body.appendChild(s);
  } else if (window.twttr?.widgets) window.twttr.widgets.load(box);
  setTimeout(() => {
    if (!box.querySelector('iframe')) {
      $('#x-meta').textContent = 'embed blocked';
      box.insertAdjacentHTML('beforeend', `<div class="fallback feed-error">X is not serving the timeline to this page right now (server-side fetch and the embedded widget were both refused).<br>
        <a href="https://x.com/${handle}" target="_blank" rel="noopener" style="color:var(--accent)">Open @${handle} on x.com ↗</a>
        <span class="muted"> · retrying every ${state.config.twitter.refreshSeconds || 120}s</span></div>`);
      state.xMode = 'blocked';
    }
  }, 20000);
}

/* ---------------- news reader window ---------------- */
const reader = { item: null, data: null, mode: 'reader', token: 0 };
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
    blockquote { margin: 1.2em 0; padding: 2px 0 2px 16px; border-left: 3px solid #4A8BE8; color: #c4cad1; }
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
    <div class="by">${[a.byline, when && !isNaN(when) ? when.toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : ''].filter(Boolean).map(esc).join(' · ')}</div>
    ${body}
    <p class="end">Reader view extracted from <a href="${esc(a.articleUrl || item.link)}">${esc(a.siteName || item.source)}</a>.</p>
  </main></body></html>`;
}
function setReaderMode(mode) {
  reader.mode = mode;
  const frame = $('#reader-frame');
  $('#reader-mode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $('.reader-body').classList.toggle('original', mode === 'original');
  if (mode === 'original' && reader.data?.articleUrl) { frame.removeAttribute('srcdoc'); frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms'); frame.src = reader.data.articleUrl; }
  else if (reader.data) { frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox'); frame.removeAttribute('src'); frame.srcdoc = readerDoc(reader.data, reader.item); }
}
async function openReader(idx) {
  const item = state.newsItems?.[idx];
  if (!item) return;
  const token = ++reader.token;
  reader.item = item; reader.idx = idx; reader.data = null;
  document.querySelectorAll('.news-item').forEach((li) => li.classList.toggle('active', +li.dataset.idx === idx));
  $('#reader').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#reader-src').innerHTML = `<b>${esc(item.source)}</b> · ${esc(item.title)}`;
  $('#reader-open').href = item.link;
  $('#reader-mode').hidden = true;
  $('#reader-prev').disabled = idx <= 0;
  $('#reader-next').disabled = idx >= state.newsItems.length - 1;
  const frame = $('#reader-frame');
  frame.removeAttribute('src'); frame.srcdoc = '<body style="background:#12161c"></body>';
  $('#reader-msg').innerHTML = '<div><div class="spinner"></div>Loading article…</div>';
  let a;
  try {
    const r = await fetch(`/api/article?url=${encodeURIComponent(item.link)}`);
    a = await r.json();
  } catch (e) { a = { ok: false, error: e.message }; }
  if (token !== reader.token) return;
  reader.data = a;
  $('#reader-msg').innerHTML = '';
  if (a.articleUrl) $('#reader-open').href = a.articleUrl;
  $('#reader-mode').hidden = !(a.frameable && a.articleUrl);
  setReaderMode(!a.ok && a.frameable && a.articleUrl ? 'original' : 'reader');
  $('#reader-frame').focus();
}
function closeReader() {
  reader.token++; reader.item = null;
  $('#reader').hidden = true;
  document.body.style.overflow = '';
  $('#reader-frame').removeAttribute('src'); $('#reader-frame').srcdoc = '';
  document.querySelectorAll('.news-item.active').forEach((li) => li.classList.remove('active'));
}
function setupReader() {
  $('#news-list').addEventListener('click', (e) => {
    const a = e.target.closest('a.t');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // modifier-click still opens a tab
    e.preventDefault();
    openReader(+a.closest('.news-item').dataset.idx);
  });
  $('#reader').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeReader(); });
  $('#reader-mode').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setReaderMode(b.dataset.mode); });
  $('#reader-prev').addEventListener('click', () => openReader(reader.idx - 1));
  $('#reader-next').addEventListener('click', () => openReader(reader.idx + 1));
  document.addEventListener('keydown', (e) => {
    if ($('#reader').hidden) return;
    if (e.key === 'Escape') closeReader();
    else if (e.key === 'ArrowLeft' && reader.idx > 0) openReader(reader.idx - 1);
    else if (e.key === 'ArrowRight' && reader.idx < state.newsItems.length - 1) openReader(reader.idx + 1);
  });
}
setupReader();


init().catch((e) => { $('#status').innerHTML = `<span class="warn">Init failed: ${esc(e.message)}</span>`; console.error(e); });
