/* Aerial chamber view: every seat of the Senate (100) or House (435) as a hemicycle,
 * or every governorship. Holdovers are muted, called seats solid, leads hatched. */
import { app, hub, esc, selection, tip, dataNote } from '../core.js';
import { seatList, hemicycle, tally, CHAMBERS } from '../seats.js';
import { raceTooltip } from './race.js';

export default {
  type: 'chamber', name: 'Chamber (seats)',
  defaults: { chamber: 'S' },
  settings: [{ key: 'chamber', label: 'Chamber', options: [['S', 'Senate'], ['H', 'House'], ['G', 'Governors']] }],
  title: (s) => `${CHAMBERS[s.chamber].name} seats`,
  mount(body, settings, ctx) {
    let results = null, markets = null;
    body.innerHTML = `<div class="map-tools no-drag"><div class="seg-toggle sm">${[['S', 'Senate'], ['H', 'House'], ['G', 'Gov']].map(([k, l]) => `<button type="button" data-ch="${k}" class="${settings.chamber === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="map-key"><span><i class="swatch solid"></i>Won</span><span><i class="swatch hatched"></i>Leading</span><span><i class="swatch hold"></i>Not up</span><span><i class="swatch none"></i>Not reporting</span></span></div>
      <div class="chamber-wrap"><svg role="img"></svg><div class="chamber-count"></div></div>`;
    const svg = d3.select(body).select('svg');
    function draw() {
      const ch = settings.chamber;
      const seats = seatList(ch, results);
      const W = 600, H = 320;
      const { pts, size } = hemicycle(seats.length, { w: W, h: H, rows: ch === 'H' ? 13 : ch === 'S' ? 5 : 4 });
      svg.attr('viewBox', `0 0 ${W} ${H}`).attr('aria-label', `${CHAMBERS[ch].name}: ${seats.length} seats`);
      const data = seats.map((s, i) => ({ ...s, ...pts[i], i }));
      const fill = (d) => (d.status === 'none' || !d.party ? 'var(--none)' : d.status === 'leading' ? `url(#hatch-${['DEM', 'GOP', 'IND'].includes(d.party) ? d.party : 'OTH'})` : d.status === 'holdover' ? `color-mix(in srgb, ${app.partyColor(d.party)} 38%, var(--panel))` : app.partyColor(d.party));
      svg.selectAll('circle.seat').data(data, (d) => d.i).join('circle').attr('class', (d) => `seat ${d.raceId ? 'race' : ''}`)
        .attr('cx', (d) => d.x).attr('cy', (d) => d.y).attr('r', size).attr('fill', fill)
        .classed('sel', (d) => d.raceId && d.raceId === selection.id)
        .on('mousemove', (ev, d) => tip.show(ev, d.raceId ? raceTooltip(d.raceId, results?.[d.raceId], markets) : `<h3>${esc(app.partyName(d.party))} seat</h3><div class="meta">Not up in 2026</div>`))
        .on('mouseleave', tip.hide)
        .on('click', (ev, d) => { if (d.raceId) { selection.set(d.raceId); ctx.openRace?.(d.raceId); } });
      const t = tally(ch, results);
      const maj = t.majority;
      svg.selectAll('line.maj').data(maj ? [maj] : []).join('line').attr('class', 'maj').attr('x1', W / 2).attr('x2', W / 2).attr('y1', H - 4).attr('y2', 8);
      const D = t.control('DEM'), R = t.seats('GOP');
      body.querySelector('.chamber-count').innerHTML = `<span style="--c:${app.partyColor('DEM')}"><b>${D}</b> D${t.seats('IND') && ch === 'S' ? ' (incl. I)' : ''}${t.leading.DEM ? ` <small>+${t.leading.DEM} leading</small>` : ''}</span>
        ${maj ? `<span class="muted">${maj} for majority</span>` : ''}
        <span style="--c:${app.partyColor('GOP')}"><b>${R}</b> R${t.leading.GOP ? ` <small>+${t.leading.GOP} leading</small>` : ''}</span>`;
    }
    const u1 = hub.subscribe('results', (s) => { results = s.data?.races || results; draw(); ctx.state('results', dataNote(s, 'results')); });
    const u2 = hub.subscribe('markets', (s) => { markets = s.data || markets; });
    const u3 = selection.subscribe(() => svg.selectAll('circle.seat').classed('sel', (d) => d.raceId && d.raceId === selection.id));
    body.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', () => {
      settings.chamber = b.dataset.ch; ctx.save({ chamber: b.dataset.ch });
      body.querySelectorAll('[data-ch]').forEach((x) => x.classList.toggle('on', x === b));
      svg.selectAll('*').remove(); draw();
    }));
    draw();
    return { destroy() { u1(); u2(); u3(); tip.hide(); }, settingsChanged() { svg.selectAll('*').remove(); draw(); } };
  },
};
