/* Prediction markets: chamber control by venue with a 48-hour sparkline, the
 * balance-of-power combo, non-race Polymarket questions (config/sources.json
 * markets.topics) and the most competitive races' odds. */
import { app, hub, esc } from '../core.js';

const VENUES = [['kalshi', 'Kalshi'], ['polymarket', 'Polymarket'], ['predictit', 'PredictIt']];
function spark(points, w = 160, h = 34) {
  if (!points || points.length < 2) return '<span class="muted spark-empty">history builds up as the poller runs</span>';
  const t0 = Date.parse(points[0].t), t1 = Date.parse(points[points.length - 1].t) || t0 + 1;
  const x = (t) => ((Date.parse(t) - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v) => h - 2 - v * (h - 4);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Democratic probability over time"><line x1="0" x2="${w}" y1="${y(0.5)}" y2="${y(0.5)}" class="mid"/><path d="${d}" style="stroke:${app.partyColor('DEM')}"/></svg>`;
}
function control(ch, m, ticks) {
  const c = m?.control?.[ch];
  if (!c) return '';
  const avg = c.avg;
  return `<div class="mk-row"><div class="mk-title"><b>${ch === 'S' ? 'Senate control' : 'House control'}</b>
      <span class="mk-big" style="--c:${app.partyColor(avg.DEM >= 0.5 ? 'DEM' : 'GOP')}">${Math.round(Math.max(avg.DEM, avg.GOP) * 100)}% ${avg.DEM >= 0.5 ? 'D' : 'R'}</span></div>
    <div class="prob"><i style="width:${avg.DEM * 100}%;background:${app.partyColor('DEM')}"></i><i style="width:${avg.GOP * 100}%;background:${app.partyColor('GOP')}"></i></div>
    <table class="mini"><tbody>${VENUES.filter(([k]) => c[k]).map(([k, l]) => `<tr><td>${l}</td><td>D ${Math.round(c[k].DEM * 100)}%</td><td>R ${Math.round(c[k].GOP * 100)}%</td></tr>`).join('')}</tbody></table>
    ${spark(ticks?.[`control:${ch}`])}</div>`;
}

// topic questions: Yes prices as they trade, not renormalised; bars are neutral (these are not parties)
const pctOf = (p) => (p < 0.005 ? '<1%' : p > 0.995 ? '>99%' : `${Math.round(p * 100)}%`);
const money = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${v}`);
function moved(d1) {
  const pts = d1 == null ? 0 : Math.round(d1 * 100);
  return pts ? `<span class="tp-d" title="change over 24 hours">${pts > 0 ? '▲' : '▼'} ${pts > 0 ? '+' : '−'}${Math.abs(pts)} pt${Math.abs(pts) === 1 ? '' : 's'}</span>` : '<span class="tp-d"></span>';
}
const line = (label, o) => `<div class="tp-o${o.closed ? ' done' : ''}"><span class="tp-l">${esc(label)}</span><span class="tp-bar"><i style="width:${Math.max(0.5, o.p * 100)}%"></i></span><b>${pctOf(o.p)}</b>${moved(o.d1)}</div>`;
const SHOW = 5;
function question(e) {
  const yesOnly = e.outcomes.length === 1 && e.outcomes[0].label === 'Yes';
  const shown = e.outcomes.slice(0, SHOW), rest = e.outcomes.slice(SHOW);
  const restLine = !rest.length ? '' : e.exclusive
    ? line(`${rest.length} others`, { p: rest.reduce((s, o) => s + o.p, 0) })
    : `<div class="tp-more muted">${rest.length} more, each ${pctOf(Math.max(...rest.map((o) => o.p)))} or less</div>`;
  return `<div class="tp-ev"><a class="tp-q" href="https://polymarket.com/event/${encodeURIComponent(e.slug)}" target="_blank" rel="noopener">${esc(e.title)}</a>
    <span class="tp-meta muted">${e.closed ? 'resolved · ' : ''}${e.volume ? `${money(e.volume)} traded` : ''}</span>
    ${yesOnly ? line('Yes', e.outcomes[0]) : shown.map((o) => line(o.label, o)).join('') + restLine}</div>`;
}
function topicGroups(m, which) {
  const groups = (m.topics || []).filter((g) => which === 'all' || g.id === which);
  return groups.map((g) => `<section class="mk-topic"><h3>${esc(g.name)}</h3>${g.note ? `<p class="muted small">${esc(g.note)}</p>` : ''}
    ${g.events.length ? g.events.map(question).join('') : '<p class="muted small">No prices yet.</p>'}</section>`).join('');
}

export default {
  type: 'markets', name: 'Prediction markets',
  defaults: { races: 'S', topics: 'all' },
  settings: [{ key: 'races', label: 'Race odds', options: [['S', 'Senate races'], ['G', 'Governor races'], ['H', 'Competitive House races'], ['none', 'Control only']] },
    { key: 'topics', label: 'World questions', options: () => [['all', 'All'], ...(app.config.markets?.topics || []).map((g) => [g.id, g.name]), ['none', 'None']] }],
  title: () => 'Prediction markets',
  mount(body, settings, ctx) {
    let m = null;
    function draw() {
      if (!m) { body.innerHTML = '<p class="muted pad">Loading…</p>'; return; }
      const combo = m.control?.combo?.avg;
      const list = settings.races === 'none' ? [] : app.manifest.filter((r) => r.chamber === settings.races && m.races?.[r.id]?.avg && (settings.races !== 'H' || Math.abs(r.consensus?.score ?? 3) < 1.5))
        .map((r) => ({ r, p: m.races[r.id].avg.DEM ?? (1 - (m.races[r.id].avg.GOP ?? 0.5)) }))
        .sort((a, b) => Math.abs(a.p - 0.5) - Math.abs(b.p - 0.5)).slice(0, 40);
      body.innerHTML = `<div class="markets">${control('S', m, m.ticks)}${control('H', m, m.ticks)}
        ${combo ? `<div class="mk-row"><b>Both chambers</b> <span class="muted">Polymarket</span><div class="combo">${[['D/D', 'D Senate · D House'], ['R/D', 'R Senate · D House'], ['R/R', 'R Senate · R House'], ['D/R', 'D Senate · R House']].map(([k, l]) => `<span><b>${Math.round((combo[k] || 0) * 100)}%</b> ${l}</span>`).join('')}</div></div>` : ''}
        ${settings.topics !== 'none' ? topicGroups(m, settings.topics || 'all') : ''}
        ${list.length ? `<table class="mk-races"><thead><tr><th>Race</th><th>Odds (avg of venues)</th><th class="num">D</th></tr></thead><tbody>${list.map(({ r, p }) => `<tr><td>${esc(r.name)}</td><td><div class="prob sm"><i style="width:${p * 100}%;background:${app.partyColor('DEM')}"></i><i style="width:${(1 - p) * 100}%;background:${app.partyColor('GOP')}"></i></div></td><td class="num">${Math.round(p * 100)}%</td></tr>`).join('')}</tbody></table>` : ''}
        ${m.meta?.errors?.length ? `<p class="feed-error">${m.meta.errors.map(esc).join('<br>')}</p>` : ''}
        <p class="muted small">Prices are probabilities from Kalshi, Polymarket and PredictIt, renormalised so the parties shown sum to 100%. Markets are not results.</p></div>`;
    }
    const un = hub.subscribe('markets', (s) => { m = s.data || m; draw(); ctx.meta(s.error ? 'error' : ''); });
    draw();
    return { destroy: un, settingsChanged: draw };
  },
};
