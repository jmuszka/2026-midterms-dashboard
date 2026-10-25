/* Stock market window: indexes, overnight futures, big tech, conglomerates, policy-sensitive
 * stocks and macro (yields, dollar, oil, gold, crypto). Real time from the scraper (CNBC quotes
 * every 30 s, intraday charts every 5 min); in replay, rebuilt from recorded prices.
 * Up/down colours (#2FA88A / #CF7A26) were validated with the dataviz palette checker and are
 * never the only cue: every change also carries ▲/▼ and a sign. */
import { app, hub, esc, tip } from '../core.js';

const UP = '#2FA88A', DOWN = '#CF7A26';
const HERO = ['.SPX', '.IXIC', '.DJI', '@SP.1', '@ND.1', '.VIX', 'US10Y', 'BTC.CB='];
const groups = () => app.config.stocks.groups;
const nameOf = (s) => groups().flatMap((g) => g.symbols).find((x) => x.s === s)?.name || s;
const isStock = (s) => !/^[.@]|^US\d+Y$|\.CB=$/.test(s);
const tone = (x) => (x > 0.005 ? 'up' : x < -0.005 ? 'down' : 'flat');
const arrow = (x) => (x > 0.005 ? '▲' : x < -0.005 ? '▼' : '■');
function price(q) {
  if (q?.price == null) return '—';
  if (q.unit === '%') return `${q.price.toFixed(3)}%`;
  const d = Math.abs(q.price) >= 1000 ? 2 : Math.abs(q.price) >= 1 ? 2 : 4;
  return q.price.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const pct = (q) => (q?.changePct == null ? '' : `${q.changePct > 0 ? '+' : q.changePct < 0 ? '−' : ''}${Math.abs(q.changePct).toFixed(2)}%`);
const chg = (q) => (q?.change == null ? '' : q.unit === '%' ? `${q.change >= 0 ? '+' : '−'}${Math.abs(q.change * 100).toFixed(1)} bp` : `${q.change >= 0 ? '+' : '−'}${Math.abs(q.change).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`);
const SESSION = { open: 'Open', pre: 'Pre-market', post: 'After hours', closed: 'Closed' };

function sparkPath(points, w, h, prev) {
  if (!points?.length) return { d: '', base: null };
  const vs = points.map((p) => p[1]).concat(prev != null ? [prev] : []);
  const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || Math.abs(hi) * 0.001 || 1;
  const t0 = points[0][0], t1 = points[points.length - 1][0] || t0 + 1;
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w, y = (v) => h - 2 - ((v - lo) / span) * (h - 4);
  return { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(''), base: prev != null ? y(prev) : null, x, y, t0, t1 };
}
function spark(sym, q, series, w = 120, h = 34) {
  const pts = series?.[sym];
  const { d, base } = sparkPath(pts, w, h, q?.prevClose);
  if (!d) return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"></svg>`;
  return `<svg class="spark hoverable" data-sym="${esc(sym)}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${esc(nameOf(sym))} intraday">${base != null ? `<line x1="0" x2="${w}" y1="${base}" y2="${base}" class="prev"/>` : ''}<path d="${d}" stroke="${tone(q?.changePct) === 'down' ? DOWN : tone(q?.changePct) === 'up' ? UP : 'var(--text-2)'}"/></svg>`;
}
function tile(sym, q, series, big = false) {
  const t = tone(q?.changePct);
  return `<div class="stk-tile ${big ? 'big' : ''}" title="${esc(q?.name || nameOf(sym))}">
    <div class="stk-head"><b>${esc(nameOf(sym))}</b><span class="sess s-${q?.state || 'closed'}">${SESSION[q?.state] || ''}${q?.extended ? ' · ext' : ''}</span></div>
    <div class="stk-price">${price(q)}</div>
    <div class="stk-chg ${t}"><i aria-hidden="true">${arrow(q?.changePct)}</i> ${pct(q)} <span class="muted">${chg(q)}</span></div>
    ${spark(sym, q, series)}
  </div>`;
}
function heatmap(syms, quotes) {
  const color = (x) => {
    if (x == null) return 'var(--none)';
    const k = Math.max(-1, Math.min(1, x / 3)); // ±3% saturates
    return k >= 0 ? `color-mix(in srgb, ${UP} ${Math.round(18 + k * 72)}%, var(--panel-2))` : `color-mix(in srgb, ${DOWN} ${Math.round(18 - k * 72)}%, var(--panel-2))`;
  };
  return `<div class="stk-heat">${syms.map((s) => { const q = quotes[s]; return `<div class="cell" style="background:${color(q?.changePct)}" title="${esc(q?.name || nameOf(s))}: ${price(q)} (${pct(q)})"><b>${esc(isStock(s) ? s : nameOf(s))}</b><span>${arrow(q?.changePct)} ${pct(q)}</span></div>`; }).join('')}</div>`;
}
function movers(syms, quotes, n = 5) {
  const list = syms.map((s) => ({ s, q: quotes[s] })).filter((x) => x.q?.changePct != null).sort((a, b) => b.q.changePct - a.q.changePct);
  const row = ({ s, q }) => `<li><span>${esc(nameOf(s))} <small class="muted">${esc(s)}</small></span><span class="${tone(q.changePct)}">${arrow(q.changePct)} ${pct(q)}</span></li>`;
  return `<div class="stk-movers"><div><h4>Biggest gains</h4><ol>${list.slice(0, n).map(row).join('')}</ol></div><div><h4>Biggest losses</h4><ol>${list.slice(-n).reverse().map(row).join('')}</ol></div></div>`;
}
// small multiples: % change since previous close on one shared scale, synced crosshair
function multiples(syms, quotes, series) {
  const W = 220, H = 70;
  const pctSeries = Object.fromEntries(syms.map((s) => {
    const pc = quotes[s]?.prevClose, pts = series?.[s] || [];
    return [s, pc ? pts.map(([t, v]) => [t, ((v - pc) / pc) * 100]) : []];
  }));
  const all = Object.values(pctSeries).flat();
  const lo = Math.min(-0.5, ...all.map((p) => p[1])), hi = Math.max(0.5, ...all.map((p) => p[1]));
  const t0 = Math.min(...all.map((p) => p[0])), t1 = Math.max(...all.map((p) => p[0]));
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W, y = (v) => H - 4 - ((v - lo) / (hi - lo || 1)) * (H - 8);
  return `<div class="stk-mult" data-t0="${t0}" data-t1="${t1}">${syms.map((s) => {
    const pts = pctSeries[s], q = quotes[s];
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('');
    return `<figure data-sym="${esc(s)}"><figcaption><b>${esc(nameOf(s))}</b> <span class="${tone(q?.changePct)}">${arrow(q?.changePct)} ${pct(q)}</span></figcaption>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(nameOf(s))}: % change since previous close"><line class="zero" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/><path d="${d}" stroke="${tone(q?.changePct) === 'down' ? DOWN : UP}"/><line class="cross" x1="-10" x2="-10" y1="0" y2="${H}"/></svg></figure>`;
  }).join('')}<p class="muted small">% change since the previous close, all on one scale (${lo.toFixed(1)}% to +${hi.toFixed(1)}%).</p></div>`;
}
function table(syms, quotes, sort) {
  const rows = syms.map((s) => ({ s, q: quotes[s] || {} }));
  const key = { name: (r) => nameOf(r.s), pct: (r) => r.q.changePct ?? -1e9, price: (r) => r.q.price ?? 0 }[sort] || ((r) => 0);
  rows.sort((a, b) => (sort === 'name' ? key(a).localeCompare(key(b)) : key(b) - key(a)));
  const range = (q) => (q.low && q.high && q.high > q.low ? Math.max(0, Math.min(100, ((q.price - q.low) / (q.high - q.low)) * 100)) : null);
  return `<div class="table-scroll"><table class="stk-table"><thead><tr><th data-sort="name">Name</th><th class="num" data-sort="price">Price</th><th class="num" data-sort="pct">Change</th><th>Day range</th><th>Session</th></tr></thead><tbody>${rows.map(({ s, q }) => `<tr><td>${esc(nameOf(s))} <small class="muted">${esc(s)}</small></td><td class="num">${price(q)}</td><td class="num ${tone(q.changePct)}">${arrow(q.changePct)} ${pct(q)}</td><td>${range(q) != null ? `<span class="rng" title="${q.low} – ${q.high}"><i style="left:${range(q)}%"></i></span>` : ''}</td><td><span class="sess s-${q.state || 'closed'}">${SESSION[q.state] || ''}</span></td></tr>`).join('')}</tbody></table></div>`;
}

export default {
  type: 'stocks', name: 'Stock market',
  defaults: { group: 'overview', display: 'tiles', sort: 'pct' },
  settings: [
    { key: 'group', label: 'Show', options: () => [['overview', 'Overview'], ...groups().map((g) => [g.id, g.name]), ['all', 'Everything']] },
    { key: 'display', label: 'Layout (groups)', options: [['tiles', 'Tiles with sparklines'], ['heatmap', 'Heatmap'], ['chart', 'Charts (small multiples)'], ['table', 'Table']] },
  ],
  title: (s) => (s.group === 'overview' ? 'Stock market' : `Markets · ${groups().find((g) => g.id === s.group)?.name || 'Everything'}`),
  mount(body, settings, ctx) {
    body.innerHTML = `<div class="feed-tools no-drag stk-tools"><select data-k="group"></select><div class="seg-toggle sm">${[['tiles', 'Tiles'], ['heatmap', 'Heatmap'], ['chart', 'Charts'], ['table', 'Table']].map(([k, l]) => `<button type="button" data-display="${k}">${l}</button>`).join('')}</div><span class="stk-status muted"></span></div><div class="stk-body"></div>`;
    const sel = body.querySelector('select');
    sel.innerHTML = this.settings[0].options().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
    let data = null;
    const out = body.querySelector('.stk-body');
    function draw() {
      sel.value = settings.group;
      body.querySelectorAll('[data-display]').forEach((b) => { b.classList.toggle('on', b.dataset.display === settings.display); b.disabled = settings.group === 'overview'; });
      if (!data?.quotes || !Object.keys(data.quotes).length) { out.innerHTML = `<p class="muted pad">${data?.error ? esc(data.error) : 'Loading market data…'}</p>`; return; }
      const { quotes, series } = data;
      const spx = quotes['.SPX'], fut = quotes['@SP.1'];
      body.querySelector('.stk-status').textContent = `US stocks: ${SESSION[quotes.AAPL?.state] || '—'} · futures: ${SESSION[fut?.state] || '—'}${data.replay ? ' · replay' : ''}`;
      if (settings.group === 'overview') {
        const stocks = groups().filter((g) => ['tech', 'conglomerates', 'policy'].includes(g.id)).flatMap((g) => g.symbols.map((x) => x.s));
        out.innerHTML = `<div class="stk-hero">${HERO.map((s) => tile(s, quotes[s], series, true)).join('')}</div>
          <h4>Stocks today <small class="muted">tile colour = % change, ±3% saturates</small></h4>${heatmap(stocks, quotes)}${movers(stocks, quotes)}
          ${quotes.AAPL?.state !== 'open' && fut?.state === 'open' ? '<p class="muted small">The stock market is closed; S&amp;P and Nasdaq futures are the live read on investors\' reaction.</p>' : ''}`;
      } else {
        const g = groups().find((x) => x.id === settings.group);
        const syms = g ? g.symbols.map((x) => x.s) : groups().flatMap((x) => x.symbols.map((y) => y.s));
        const note = g?.note ? `<p class="muted small">${esc(g.note)}</p>` : '';
        if (settings.display === 'heatmap') out.innerHTML = note + heatmap(syms, quotes) + movers(syms, quotes, 3);
        else if (settings.display === 'chart') out.innerHTML = note + multiples(syms, quotes, series);
        else if (settings.display === 'table') out.innerHTML = note + table(syms, quotes, settings.sort);
        else out.innerHTML = note + `<div class="stk-grid">${syms.map((s) => tile(s, quotes[s], series)).join('')}</div>`;
      }
      ctx.title(settings.group === 'overview' ? 'Stock market' : `Markets · ${groups().find((x) => x.id === settings.group)?.name || 'Everything'}`);
      ctx.meta(data.replay ? 'as recorded' : spx ? `S&P ${pct(spx)}` : '');
    }
    // interactions
    sel.addEventListener('change', () => { settings.group = sel.value; ctx.save({ group: sel.value }); draw(); });
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-display]'); if (b && !b.disabled) { settings.display = b.dataset.display; ctx.save({ display: b.dataset.display }); draw(); return; }
      const th = e.target.closest('th[data-sort]'); if (th) { settings.sort = th.dataset.sort; ctx.save({ sort: th.dataset.sort }); draw(); }
    });
    // hover: sparkline tooltip with the price at that time; small multiples share one crosshair
    out.addEventListener('mousemove', (e) => {
      const sp = e.target.closest('svg.hoverable');
      if (sp && data?.series?.[sp.dataset.sym]?.length) {
        const pts = data.series[sp.dataset.sym], r = sp.getBoundingClientRect();
        const f = (e.clientX - r.left) / r.width, i = Math.max(0, Math.min(pts.length - 1, Math.round(f * (pts.length - 1))));
        const q = data.quotes[sp.dataset.sym];
        tip.show(e, `<b>${esc(nameOf(sp.dataset.sym))}</b><div class="meta">${new Date(pts[i][0] * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET · ${price({ ...q, price: pts[i][1] })}</div>`);
        return;
      }
      const fig = e.target.closest('.stk-mult figure');
      const mult = out.querySelector('.stk-mult');
      if (!fig || !mult) { tip.hide(); return; }
      const r = fig.querySelector('svg').getBoundingClientRect(), f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const t = +mult.dataset.t0 + f * (+mult.dataset.t1 - +mult.dataset.t0);
      mult.querySelectorAll('line.cross').forEach((l) => { l.setAttribute('x1', f * 220); l.setAttribute('x2', f * 220); });
      const rows = [...mult.querySelectorAll('figure')].map((fg) => {
        const s = fg.dataset.sym, pts = data.series?.[s] || [], pc = data.quotes[s]?.prevClose;
        let best = null; for (const p of pts) if (p[0] <= t) best = p;
        return best && pc ? `<tr><td>${esc(nameOf(s))}</td><td class="num">${(((best[1] - pc) / pc) * 100).toFixed(2)}%</td></tr>` : '';
      }).join('');
      tip.show(e, `<b>${new Date(t * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET</b><table class="mini"><tbody>${rows}</tbody></table>`);
    });
    out.addEventListener('mouseleave', () => { tip.hide(); out.querySelectorAll('line.cross').forEach((l) => { l.setAttribute('x1', -10); l.setAttribute('x2', -10); }); });
    const un = hub.subscribe('stocks', (s) => { data = s.data ? { ...s.data } : { error: s.error }; draw(); });
    return { destroy() { un(); tip.hide(); }, settingsChanged: draw };
  },
};
