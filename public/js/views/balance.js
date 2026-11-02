/* Balance of power: Senate, House and governors as stacked seat bars with tiles. */
import { app, hub, esc, signed, dataNote } from '../core.js';
import { tally, CHAMBERS } from '../seats.js';

const PARTIES = ['DEM', 'IND', 'GOP'];

function bar(ch, t, markets) {
  const total = t.total;
  const segs = [];
  const w = (n) => `${(n / total) * 100}%`;
  const seg = (p, n, cls, label) => { if (n > 0) segs.push(`<div class="seg ${cls}" style="--c:${app.partyColor(p)};width:${w(n)}" title="${esc(label)}"></div>`); };
  for (const p of ['DEM', 'IND']) {
    seg(p, t.holdover[p] || 0, 'hold', `${app.partyName(p)}: ${t.holdover[p] || 0} not up`);
    seg(p, t.called[p] || 0, '', `${app.partyName(p)}: ${t.called[p] || 0} won`);
    seg(p, t.leading[p] || 0, 'leading', `${app.partyName(p)}: ${t.leading[p] || 0} leading`);
  }
  const other = (t.called.OTH || 0) + (t.leading.OTH || 0);
  if (t.none + other > 0) segs.push(`<div class="seg none" style="width:${w(t.none + other)}" title="${t.none} not yet reporting${other ? `, ${other} other` : ''}"></div>`);
  const p = 'GOP';
  seg(p, t.leading[p] || 0, 'leading', `${app.partyName(p)}: ${t.leading[p] || 0} leading`);
  seg(p, t.called[p] || 0, '', `${app.partyName(p)}: ${t.called[p] || 0} won`);
  seg(p, t.holdover[p] || 0, 'hold', `${app.partyName(p)}: ${t.holdover[p] || 0} not up`);
  const maj = t.majority ? `<div class="majority-line" style="left:${(t.majority / total) * 100}%"><span>${t.majority}</span></div>` : '';
  const odds = markets?.control?.[ch]?.avg;
  return `<div class="bop-row">
    <div class="bop-head"><b>${CHAMBERS[ch].name}</b>
      ${odds ? `<span class="odds" title="Average of prediction markets">Markets: <i class="chip" style="--c:${app.partyColor('DEM')}"></i>${Math.round(odds.DEM * 100)}% · <i class="chip" style="--c:${app.partyColor('GOP')}"></i>${Math.round(odds.GOP * 100)}%</span>` : ''}
      <span class="muted">${t.races} races${t.none ? ` · ${t.none} not reporting` : ''}${t.flips.length ? ` · <b class="flips">${t.flips.length} flip${t.flips.length > 1 ? 's' : ''}</b>` : ''}</span></div>
    <div class="seatbar-wrap"><div class="seatbar" role="img" aria-label="${CHAMBERS[ch].name} seats">${segs.join('')}</div>${maj}</div>
    <div class="bop-tiles">${PARTIES.filter((x) => x !== 'IND' || t.withLeads('IND') > 0).map((x) => tile(ch, t, x)).join('')}</div>
  </div>`;
}
function tile(ch, t, p) {
  const net = t.net(p);
  const called = (t.called[p] || 0) + (t.holdover[p] || 0);
  const lead = t.leading[p] || 0;
  const ctrl = ch === 'S' && p === 'DEM' && t.seats('IND') ? ` <small>+${t.seats('IND')} I caucus</small>` : '';
  return `<div class="tile" style="--c:${app.partyColor(p)}">
    <div class="name"><span>${esc(app.partyName(p))}</span>${net ? `<span class="net ${net > 0 ? 'up' : 'down'}" title="Net change: seats gained minus seats lost so far (won or leading), against the party holding each seat now">${signed(net, 0)}</span>` : ''}</div>
    <div class="seats">${called + lead}${ctrl}</div>
    <div class="sub">${called} won${lead ? ` · ${lead} leading` : ''}${t.holdover[p] ? ` · ${t.holdover[p]} not up` : ''}</div>
  </div>`;
}
function pre(ch, t) { // before any votes: where the raters' consensus puts each seat
  const D = (t.rated.DEM || 0) + (t.holdover.DEM || 0), R = (t.rated.GOP || 0) + (t.holdover.GOP || 0), T = t.rated.TOSS || 0;
  return `<div class="bop-pre muted">Ratings consensus: ${D} D-leaning · ${T} toss-up · ${R} R-leaning${t.majority ? ` · ${t.majority} for a majority` : ''}</div>`;
}

export default {
  type: 'balance', name: 'Balance of power',
  defaults: { chambers: 'SHG' },
  settings: [{ key: 'chambers', label: 'Show', options: [['SHG', 'Senate, House, governors'], ['SH', 'Senate and House'], ['S', 'Senate'], ['H', 'House'], ['G', 'Governors']] }],
  title: () => 'Balance of power',
  mount(body, settings, ctx) {
    let results = null, markets = null;
    const draw = () => {
      const anyVotes = results && Object.values(results).some((r) => r.totalVotes > 0);
      body.innerHTML = `<div class="bop">${[...settings.chambers].map((ch) => { const t = tally(ch, results); return bar(ch, t, markets) + (anyVotes ? '' : pre(ch, t)); }).join('')}</div>`;
    };
    const u1 = hub.subscribe('results', (s) => { results = s.data?.races || results; draw(); ctx.meta(s.data?.simulated ? 'SIMULATED' : ''); ctx.state('results', dataNote(s, 'results')); });
    const u2 = hub.subscribe('markets', (s) => { markets = s.data || markets; draw(); ctx.state('markets', s.error && !s.data ? dataNote(s, 'odds') : ''); });
    draw();
    return { destroy() { u1(); u2(); } };
  },
};
