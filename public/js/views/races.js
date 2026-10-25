/* Race browser: every contest as a sortable, filterable table. */
import { app, hub, esc, fmt, pct1, selection, closeLabel, ratingClass, raceState } from '../core.js';
import { statusBadge } from './race.js';

const FILTERS = [['all', 'All'], ['competitive', 'Competitive'], ['tossup', 'Toss-ups'], ['counting', 'Counting'], ['uncalled', 'Uncalled with votes'], ['close', 'Margin under 2'], ['flips', 'Flips'], ['called', 'Called']];

export default {
  type: 'races', name: 'Race browser',
  defaults: { chamber: 'S', filter: 'all', sort: 'state' },
  settings: [
    { key: 'chamber', label: 'Chamber', options: [['S', 'Senate'], ['H', 'House'], ['G', 'Governors'], ['all', 'All']] },
    { key: 'filter', label: 'Show', options: FILTERS },
    { key: 'sort', label: 'Sort', options: [['state', 'State'], ['close', 'Poll close'], ['margin', 'Closest margin'], ['rating', 'Most competitive']] },
  ],
  title: (s) => `${{ S: 'Senate', H: 'House', G: 'Governor', all: 'All' }[s.chamber]} races`,
  mount(body, settings, ctx) {
    body.innerHTML = `<div class="feed-tools no-drag">
      <select data-k="chamber">${this.settings[0].options.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <select data-k="filter">${FILTERS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <input type="search" placeholder="Name, state, district…" aria-label="Filter races"></div>
      <div class="table-scroll tile-body"><table class="races"><thead><tr><th data-s="state">Race</th><th>Leader / winner</th><th class="num" data-s="margin">Margin</th><th class="num">In</th><th data-s="rating">Rating</th><th data-s="close">Closes</th><th>Status</th></tr></thead><tbody></tbody></table></div>`;
    let results = null, q = '';
    for (const sel of body.querySelectorAll('select[data-k]')) { sel.value = settings[sel.dataset.k]; sel.addEventListener('change', () => { settings[sel.dataset.k] = sel.value; ctx.save({ [sel.dataset.k]: sel.value }); draw(); }); }
    body.querySelector('input').addEventListener('input', (e) => { q = e.target.value.toLowerCase(); draw(); });
    body.querySelectorAll('th[data-s]').forEach((th) => th.addEventListener('click', () => { settings.sort = th.dataset.s; ctx.save({ sort: th.dataset.s }); draw(); }));
    const keep = (m, r) => {
      const s = raceState(r);
      switch (settings.filter) {
        case 'competitive': return Math.abs(m.consensus?.score ?? 3) < 1.5;
        case 'tossup': return m.consensus?.rating === 'Toss-up';
        case 'counting': return r?.totalVotes > 0 && !r.called;
        case 'uncalled': return r?.totalVotes > 0 && !r.called;
        case 'close': return r?.totalVotes > 0 && r.marginPct < 2;
        case 'flips': return s.status === 'called' && m.incumbent && r.winner !== m.incumbent.party;
        case 'called': return s.status === 'called';
        default: return true;
      }
    };
    function draw() {
      const rows = app.manifest.filter((m) => (settings.chamber === 'all' || m.chamber === settings.chamber))
        .filter((m) => keep(m, results?.[m.id]))
        .filter((m) => !q || `${m.name} ${m.state} ${app.config.states[m.state]?.name} ${m.candidates.map((c) => c.name).join(' ')}`.toLowerCase().includes(q));
      const key = {
        state: (m) => m.state + String(m.district ?? 0).padStart(2, '0') + m.chamber,
        close: (m) => m.close + m.state,
        margin: (m) => (results?.[m.id]?.totalVotes ? String(results[m.id].marginPct.toFixed(3)).padStart(8, '0') : 'z'),
        rating: (m) => String(Math.abs(m.consensus?.score ?? 3).toFixed(2)),
      }[settings.sort] || ((m) => m.id);
      rows.sort((a, b) => key(a).localeCompare(key(b)));
      body.querySelector('tbody').innerHTML = rows.map((m) => {
        const r = results?.[m.id];
        const lead = r?.totalVotes ? r.candidates[0] : null;
        return `<tr data-race="${m.id}" class="${selection.id === m.id ? 'pinned' : ''}">
          <td>${esc(m.name)}</td>
          <td>${lead ? `<i class="chip" style="--c:${app.partyColor(lead.party)}"></i> ${esc(lead.name)}` : '<span class="muted">—</span>'}</td>
          <td class="num">${lead ? `${app.partyShort(lead.party)} +${r.marginPct.toFixed(1)}` : ''}</td>
          <td class="num">${r?.expectedPct != null ? `${Math.round(r.expectedPct)}%` : r?.precincts?.total ? `${Math.round((r.precincts.reporting / r.precincts.total) * 100)}%` : ''}</td>
          <td><span class="rating r-${ratingClass(m.consensus?.score)}">${esc(m.consensus?.rating || '')}</span></td>
          <td>${closeLabel(m.close)}</td>
          <td>${statusBadge(r, m)}</td></tr>`;
      }).join('');
      ctx.meta(`${rows.length} races`);
    }
    body.querySelector('tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-race]'); if (tr) { selection.set(tr.dataset.race); ctx.openRace?.(tr.dataset.race); } });
    const u1 = hub.subscribe('results', (s) => { results = s.data?.races || results; draw(); });
    const u2 = selection.subscribe(() => body.querySelectorAll('tr[data-race]').forEach((tr) => tr.classList.toggle('pinned', tr.dataset.race === selection.id)));
    draw();
    return { destroy() { u1(); u2(); }, settingsChanged: draw };
  },
};
