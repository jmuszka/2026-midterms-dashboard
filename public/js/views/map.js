/* Results map. Senate and governors by state, House by 2026 district (state borders on top).
 * Colour modes: live result, pre-election rating, market odds, flips, swing vs 2024. */
import { app, hub, esc, fmt, pct1, signed, selection, tip, raceState, ratingClass, dataNote } from '../core.js';
import { raceTooltip } from './race.js';

let GEO = null; // loaded once, shared by every map window
async function geo() {
  if (GEO) return GEO;
  const [states, districts] = await Promise.all([fetch('/data/states-10m.json').then((r) => r.json()), fetch('/data/districts-2026.json').then((r) => r.json())]);
  const fipsToSt = Object.fromEntries(Object.entries(app.config.states).map(([st, s]) => [s.fips, st]));
  const st = topojson.feature(states, states.objects.states);
  st.features.forEach((f) => { f.st = fipsToSt[f.id]; });
  GEO = {
    states: st.features.filter((f) => f.st && f.st !== 'DC'),
    borders: topojson.mesh(states, states.objects.states, (a, b) => a !== b),
    nation: topojson.feature(states, states.objects.nation),
    districts: topojson.feature(districts, districts.objects.districts).features,
  };
  return GEO;
}

const MODES = [['result', 'Live result'], ['rating', 'Ratings consensus'], ['markets', 'Market odds'], ['flips', 'Flips'], ['swing', 'Shift vs 2024 president']];
const RATING_FILL = { sd: 'var(--dem)', ld: 'var(--dem-2)', td: 'var(--dem-3)', tu: 'var(--toss)', tr: 'var(--gop-3)', lr: 'var(--gop-2)', sr: 'var(--gop)', none: 'var(--none)' };

export default {
  type: 'map', name: 'Results map',
  defaults: { chamber: 'S', mode: 'result' },
  settings: [
    { key: 'chamber', label: 'Races', options: [['S', 'Senate'], ['H', 'House'], ['G', 'Governors']] },
    { key: 'mode', label: 'Colour by', options: MODES },
  ],
  title: (s) => `${{ S: 'Senate', H: 'House', G: 'Governor' }[s.chamber]} map`,
  mount(body, settings, ctx) {
    body.innerHTML = `<div class="map-tools no-drag">
        <div class="seg-toggle sm">${[['S', 'Senate'], ['H', 'House'], ['G', 'Gov']].map(([k, l]) => `<button type="button" data-ch="${k}" class="${settings.chamber === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <select class="mode" aria-label="Colour by">${MODES.map(([k, l]) => `<option value="${k}" ${settings.mode === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button type="button" class="reset-zoom" title="Reset zoom">Reset zoom</button>
        <span class="map-key"></span>
      </div><div class="map-wrap"><svg role="img" aria-label="US results map"></svg></div>`;
    const svg = d3.select(body).select('svg');
    const W = 975, H = 610;
    svg.attr('viewBox', `0 0 ${W} ${H}`);
    const proj = d3.geoAlbersUsa().scale(1300).translate([W / 2, H / 2]);
    const path = d3.geoPath(proj);
    const root = svg.append('g');
    const gFill = root.append('g'), gBorder = root.append('g');
    let results = null, markets = null, ready = false;
    const zoom = d3.zoom().scaleExtent([1, 24]).on('zoom', (e) => { root.attr('transform', e.transform); gBorder.selectAll('path').attr('stroke-width', 1.1 / e.transform.k); gFill.selectAll('path').attr('stroke-width', 0.5 / e.transform.k); });
    svg.call(zoom).on('dblclick.zoom', null);
    body.querySelector('.reset-zoom').addEventListener('click', () => svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity));

    const raceFor = (d) => (settings.chamber === 'H' ? d.id : settings.chamber === 'S' ? (app.race[`S-${d.st}`] ? `S-${d.st}` : app.race[`S-${d.st}-special`] ? `S-${d.st}-special` : null) : (app.race[`G-${d.st}`] ? `G-${d.st}` : null));
    const holdoverFill = (st) => { const p = app.config.balance.G.holdoverStates?.[st]; return settings.chamber === 'G' && p ? `color-mix(in srgb, ${app.partyColor(p)} 28%, var(--panel))` : 'var(--notup)'; };
    function fill(d) {
      const id = raceFor(d);
      if (!id) return holdoverFill(d.st);
      const m = app.race[id], r = results?.[id];
      if (settings.mode === 'rating') return RATING_FILL[ratingClass(m.consensus?.score)];
      if (settings.mode === 'markets') {
        const p = markets?.races?.[id]?.avg?.DEM;
        return p == null ? 'var(--none)' : RATING_FILL[ratingClass(p >= 0.9 ? 3 : p >= 0.7 ? 2 : p >= 0.58 ? 1 : p > 0.42 ? 0 : p > 0.3 ? -1 : p > 0.1 ? -2 : -3)];
      }
      if (settings.mode === 'flips') {
        const s = raceState(r);
        if (s.status === 'none' || !m.incumbent) return 'var(--none)';
        return s.party !== m.incumbent.party ? app.partyColor(s.party) : 'var(--notup)';
      }
      if (settings.mode === 'swing') {
        if (!r?.totalVotes || m.pres2024?.margin == null) return 'var(--none)';
        const d0 = r.candidates.find((c) => c.party === 'DEM'), g0 = r.candidates.find((c) => c.party === 'GOP');
        if (!d0 || !g0) return 'var(--none)';
        const shift = ((d0.votes - g0.votes) / r.totalVotes) * 100 - m.pres2024.margin;
        return d3.interpolateRgb(app.partyColor('GOP'), app.partyColor('DEM'))(Math.max(0, Math.min(1, 0.5 + shift / 30)));
      }
      const s = raceState(r);
      if (s.status === 'called') return app.partyColor(s.party);
      if (s.status === 'leading') return `url(#hatch-${['DEM', 'GOP', 'IND'].includes(s.party) ? s.party : 'OTH'})`;
      return 'var(--none)';
    }
    function key() {
      const k = body.querySelector('.map-key');
      if (settings.mode === 'result') k.innerHTML = '<span><i class="swatch solid"></i>Won</span><span><i class="swatch hatched"></i>Leading</span><span><i class="swatch none"></i>No votes yet</span><span><i class="swatch notup"></i>Not up</span>';
      else if (settings.mode === 'rating' || settings.mode === 'markets') k.innerHTML = '<span class="ramp"><i style="background:var(--dem)"></i><i style="background:var(--dem-2)"></i><i style="background:var(--dem-3)"></i><i style="background:var(--toss)"></i><i style="background:var(--gop-3)"></i><i style="background:var(--gop-2)"></i><i style="background:var(--gop)"></i></span><span>Safe D … Toss-up … Safe R</span>';
      else if (settings.mode === 'flips') k.innerHTML = '<span><i class="swatch solid"></i>Flipped (winning party)</span><span><i class="swatch notup"></i>Held</span>';
      else k.innerHTML = '<span class="ramp grad"></span><span>R +15 … D +15 shift vs 2024 president</span>';
    }
    function draw() {
      if (!ready) return;
      const feats = settings.chamber === 'H' ? GEO.districts : GEO.states;
      gFill.selectAll('path').data(feats, (d) => d.id + settings.chamber).join(
        (enter) => enter.append('path').attr('class', 'area').attr('d', path)
          .on('mousemove', (ev, d) => { const id = raceFor(d); tip.show(ev, id ? raceTooltip(id, results?.[id], markets) : `<h3>${esc(app.config.states[d.st]?.name || '')}</h3><div class="meta">No ${settings.chamber === 'G' ? 'governor' : 'Senate'} race in 2026</div>`); })
          .on('mouseleave', tip.hide)
          .on('click', (ev, d) => { const id = raceFor(d); if (id) { selection.set(id); ctx.openRace?.(id); } }),
      ).attr('fill', fill).classed('sel', (d) => raceFor(d) === selection.id);
      gBorder.selectAll('path').data(settings.chamber === 'H' ? [GEO.borders] : []).join('path').attr('class', 'state-border').attr('d', path);
      key();
    }
    const u1 = hub.subscribe('results', (s) => { results = s.data?.races || results; draw(); ctx.state('results', dataNote(s, 'results')); });
    const u2 = hub.subscribe('markets', (s) => { markets = s.data || markets; if (settings.mode === 'markets') draw(); });
    const u3 = selection.subscribe(() => gFill.selectAll('path').classed('sel', (d) => raceFor(d) === selection.id));
    body.querySelectorAll('[data-ch]').forEach((b) => b.addEventListener('click', () => {
      settings.chamber = b.dataset.ch; ctx.save({ chamber: b.dataset.ch });
      body.querySelectorAll('[data-ch]').forEach((x) => x.classList.toggle('on', x === b));
      gFill.selectAll('path').remove(); draw();
    }));
    body.querySelector('.mode').addEventListener('change', (e) => { settings.mode = e.target.value; ctx.save({ mode: e.target.value }); draw(); });
    geo().then(() => { ready = true; draw(); }).catch((e) => { body.querySelector('.map-wrap').innerHTML = `<p class="feed-error">Map data failed to load: ${esc(e.message)}</p>`; });
    return { destroy() { u1(); u2(); u3(); tip.hide(); }, settingsChanged() { gFill.selectAll('path').remove(); draw(); } };
  },
};
