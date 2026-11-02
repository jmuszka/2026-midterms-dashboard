/* Race card: one race in depth. Follows the shared selection unless pinned. Also exports
 * the tooltip/summary builders used by the map, chamber and race browser. */
import { app, hub, esc, fmt, pct1, signed, selection, getJSON, closeLabel, ratingClass, timeAgo, etTime, dataNote } from '../core.js';
import { clock } from '../clock.js';

export function statusBadge(r, m) {
  if (r?.called) return `<span class="badge called">${r.simulated ? 'Sim call' : 'Called'}${r.flip ?? (m?.incumbent && r.winner !== m.incumbent.party) ? ' · flip' : ''}</span>`;
  if (r?.runoff) return '<span class="badge runoff">Runoff</span>';
  if (r?.totalVotes > 0) return '<span class="badge leading">Counting</span>';
  return '<span class="badge">No votes yet</span>';
}
function progress(r) {
  if (!r) return '';
  if (r.expectedPct != null) return `${pct1(r.expectedPct)} of expected vote`;
  if (r.precincts?.total) return `${fmt(r.precincts.reporting)}/${fmt(r.precincts.total)} precincts`;
  return '';
}
function candList(m, r, max) {
  const list = r?.candidates?.length ? r.candidates : m.candidates.map((c) => ({ ...c, votes: 0, pct: 0 }));
  const shown = list.slice(0, max);
  return `<ol class="cands">${shown.map((c) => {
    const inc = m.incumbent && (c.incumbent || c.name === m.incumbent.name);
    return `<li class="cand${c.winner ? ' won' : ''}" style="--c:${app.partyColor(c.party)};--w:${c.pct || 0}%">
      <i class="chip"></i><span class="nm">${esc(c.name)} <small>${esc(app.partyShort(c.party))}${inc ? ' · inc.' : ''}</small>${c.winner ? ' <b class="tick" aria-label="winner">Won</b>' : ''}</span>
      <span class="v">${r?.totalVotes ? fmt(c.votes) : ''}</span><span class="pct">${r?.totalVotes ? pct1(c.pct) : ''}</span>
      <span class="bar"><i></i></span></li>`;
  }).join('')}${list.length > max ? `<li class="muted more">+${list.length - max} more</li>` : ''}</ol>`;
}
function oddsLine(id, markets) {
  const o = markets?.races?.[id];
  if (!o?.avg) return '';
  const lead = Object.entries(o.avg).sort((a, b) => b[1] - a[1])[0];
  return `<div class="meta">Markets: ${esc(app.partyName(lead[0]))} ${Math.round(lead[1] * 100)}%</div>`;
}
export function raceTooltip(id, r, markets) {
  const m = app.race[id];
  return `<h3>${esc(m.name)} ${statusBadge(r, m)}</h3>
    <div class="meta">${[progress(r), r?.totalVotes ? `${fmt(r.totalVotes)} votes` : `Polls close ${closeLabel(m.close)} ET`, m.consensus ? `Rating: ${m.consensus.rating}` : ''].filter(Boolean).join(' · ')}</div>
    ${candList(m, r, 4)}${oddsLine(id, markets)}`;
}

function detail(id, r, markets, counties, countyAt) {
  const m = app.race[id];
  const st = app.config.states[m.state] || {};
  const inc = m.incumbent ? `${esc(m.incumbent.name)} (${esc(app.partyShort(m.incumbent.party))})${m.open ? ', not running' : ''}` : 'Open / new seat';
  const raters = Object.entries(m.ratings || {});
  const o = markets?.races?.[id];
  const venues = o ? Object.entries(o).filter(([k]) => k !== 'avg') : [];
  return `<div class="race-card">
    <div class="rc-head"><h3>${esc(m.name)}</h3>${statusBadge(r, m)}</div>
    <div class="meta">${[progress(r), r?.totalVotes ? `${fmt(r.totalVotes)} votes counted` : `Polls close ${closeLabel(m.close)} ET`, r?.calledBy ? `called by ${esc(r.calledBy)}` : '', r?.updatedAt ? `updated ${timeAgo(r.updatedAt)}` : ''].filter(Boolean).join(' · ')}</div>
    ${r?.expectedPct != null ? `<div class="progress" title="Share of expected vote counted"><i style="width:${Math.min(100, r.expectedPct)}%"></i></div>` : ''}
    ${candList(m, r, 8)}
    <dl class="facts">
      <dt>Incumbent</dt><dd>${inc}</dd>
      ${m.pvi ? `<dt>Partisan lean</dt><dd>${esc(m.pvi)} (Cook PVI)</dd>` : ''}
      ${m.pres2024 ? `<dt>2024 president</dt><dd>${m.pres2024.margin >= 0 ? 'Harris' : 'Trump'} +${Math.abs(m.pres2024.margin)} on these lines</dd>` : ''}
      ${st.slow ? `<dt>Count speed</dt><dd>${esc(st.slow)}</dd>` : ''}
      ${st.runoff ? `<dt>Runoff</dt><dd>${esc(st.runoff)}</dd>` : ''}
      ${r?.sources ? `<dt>Sources</dt><dd>${r.sources.map(esc).join(', ')}${r.countsFrom ? ` (counts from ${esc(r.countsFrom)})` : ''}</dd>` : ''}
    </dl>
    ${raters.length ? `<h4>Ratings</h4><div class="raters">${raters.map(([k, v]) => `<span class="rater r-${ratingClass(v.score)}" title="${esc(k)}: ${esc(v.rating)}${v.flip ? ' (flip)' : ''}"><b>${esc(k)}</b>${esc(v.rating.replace('Toss-up', 'Toss'))}</span>`).join('')}</div>` : ''}
    ${venues.length ? `<h4>Prediction markets</h4><table class="mini"><tbody>${venues.map(([v, ps]) => `<tr><td>${esc(v[0].toUpperCase() + v.slice(1))}</td>${Object.entries(ps).sort((a, b) => b[1] - a[1]).map(([p, x]) => `<td><i class="chip" style="--c:${app.partyColor(p)}"></i> ${esc(app.partyShort(p))} ${Math.round(x * 100)}%</td>`).join('')}</tr>`).join('')}</tbody></table>` : ''}
    ${counties?.length ? `<h4>Counties <small class="muted">${counties.length}${countyAt ? ` · as of ${etTime(countyAt)} ET` : ''}</small></h4><div class="table-scroll counties"><table><thead><tr><th>County</th><th>Leader</th><th class="num">Margin</th><th class="num">In</th></tr></thead><tbody>${counties.slice().sort((a, b) => b.total - a.total).map((c) => { const cs = c.candidates.slice().sort((a, b) => b.votes - a.votes); const t = cs.reduce((s, x) => s + x.votes, 0); return `<tr><td>${esc(c.name || c.fips)}</td><td><i class="chip" style="--c:${app.partyColor(cs[0]?.party)}"></i> ${esc(cs[0]?.name || '')}</td><td class="num">${t ? `+${(((cs[0].votes - (cs[1]?.votes || 0)) / t) * 100).toFixed(1)}` : ''}</td><td class="num">${c.pct ?? ''}%</td></tr>`; }).join('')}</tbody></table></div>` : ''}
  </div>`;
}

export default {
  type: 'race', name: 'Race card',
  defaults: { pin: '' },
  settings: [{ key: 'pin', label: 'Race', options: () => [['', 'Follow the selected race'], ...app.manifest.filter((m) => Math.abs(m.consensus?.score ?? 3) < 2 || m.chamber !== 'H').map((m) => [m.id, m.name])] }],
  title: (s) => (s.pin ? app.race[s.pin]?.name || 'Race' : 'Race card'),
  mount(body, settings, ctx) {
    // county table: recorded by the scraper (live: refetched when the race's count moves; replay:
    // the table in force at the clock's minute). The last table stays up while the next one loads.
    let results = null, markets = null, counties = null, countyRace = null, countyAt = null, countyFor = null;
    const countyWant = (rid) => {
      if (clock.mode === 'replay') return { key: `${rid}@${Math.floor(clock.t / 60e3)}`, at: new Date(Math.floor(clock.t / 60e3) * 60e3).toISOString() };
      const r = results?.[rid];
      return r?.countyKey ? { key: `${rid}#${r.totalVotes ?? 0}|${r.expectedPct ?? ''}` } : null;
    };
    const id = () => settings.pin || selection.id;
    const draw = () => {
      const rid = id();
      if (!rid || !app.race[rid]) { body.innerHTML = '<p class="muted pad">Click a state, district, seat or race to see it here.</p>'; ctx.title('Race card'); return; }
      ctx.title(settings.pin ? app.race[rid].name : `Race · ${app.race[rid].name}`);
      body.innerHTML = detail(rid, results?.[rid], markets, countyRace === rid ? counties : null, countyRace === rid ? countyAt : null);
      const want = countyWant(rid);
      if (want && want.key !== countyFor) {
        countyFor = want.key; ctx.state('counties', '');
        getJSON(`/api/counties?race=${encodeURIComponent(rid)}${want.at ? `&at=${encodeURIComponent(want.at)}` : ''}`)
          .then((d) => { if (countyFor === want.key) { counties = d.counties; countyRace = rid; countyAt = d.t || null; draw(); } })
          .catch((e) => { if (countyFor === want.key) ctx.state('counties', `<span class="warn" title="${esc(e.message)}">county results unavailable</span>`); });
      }
    };
    const u1 = hub.subscribe('results', (s) => { results = s.data?.races || results; draw(); ctx.state('results', dataNote(s, 'results')); });
    const u2 = hub.subscribe('markets', (s) => { markets = s.data || markets; draw(); });
    const u3 = selection.subscribe(() => { if (!settings.pin) draw(); });
    let mode = clock.mode; // replay redraws come through the results subscription; this only catches the switch back to live
    const u4 = clock.subscribe(() => { if (clock.mode !== mode) { mode = clock.mode; countyFor = null; draw(); } });
    draw();
    return { destroy() { u1(); u2(); u3(); u4(); }, settingsChanged: draw };
  },
};
