/* Prediction markets: chamber control by venue with a 48-hour sparkline, the
 * balance-of-power combo, and the most competitive races' odds. */
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

export default {
  type: 'markets', name: 'Prediction markets',
  defaults: { races: 'S' },
  settings: [{ key: 'races', label: 'Race odds', options: [['S', 'Senate races'], ['G', 'Governor races'], ['H', 'Competitive House races'], ['none', 'Control only']] }],
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
        ${list.length ? `<table class="mk-races"><thead><tr><th>Race</th><th>Odds (avg of venues)</th><th class="num">D</th></tr></thead><tbody>${list.map(({ r, p }) => `<tr><td>${esc(r.name)}</td><td><div class="prob sm"><i style="width:${p * 100}%;background:${app.partyColor('DEM')}"></i><i style="width:${(1 - p) * 100}%;background:${app.partyColor('GOP')}"></i></div></td><td class="num">${Math.round(p * 100)}%</td></tr>`).join('')}</tbody></table>` : ''}
        ${m.meta?.errors?.length ? `<p class="feed-error">${m.meta.errors.map(esc).join('<br>')}</p>` : ''}
        <p class="muted small">Prices are probabilities from Kalshi, Polymarket and PredictIt, renormalised so the parties shown sum to 100%. Markets are not results.</p></div>`;
    }
    const un = hub.subscribe('markets', (s) => { m = s.data || m; draw(); ctx.meta(s.error ? 'error' : ''); });
    draw();
    return { destroy: un, settingsChanged: draw };
  },
};
