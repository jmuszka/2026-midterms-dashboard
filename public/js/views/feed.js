/* Live feed: every result event (calls, flips, lead changes, vote batches, tight
 * margins, market moves, poll closings) newest first, with filters. Ticker mode
 * fits a one-line window. Also raises toasts for calls/flips in competitive races. */
import { app, esc, etTime, selection, subscribeEvents, isCompetitive, toast } from '../core.js';

const TYPES = {
  flip_called: 'Flip', race_called: 'Call', lead_change: 'Lead change', margin_tight: 'Tight', vote_batch: 'Votes', first_votes: 'First votes',
  runoff: 'Runoff', race_uncalled: 'Uncalled', market_move: 'Markets', poll_close: 'Polls close',
};
const IMPORTANT = new Set(['flip_called', 'race_called', 'lead_change', 'margin_tight', 'runoff', 'race_uncalled', 'market_move', 'poll_close']);

export default {
  type: 'feed', name: 'Live feed',
  defaults: { chambers: 'SHG', scope: 'all', kinds: 'all', ticker: false },
  settings: [
    { key: 'chambers', label: 'Chambers', options: [['SHG', 'All'], ['S', 'Senate'], ['H', 'House'], ['G', 'Governors'], ['SG', 'Senate + governors']] },
    { key: 'scope', label: 'Races', options: [['all', 'All races'], ['competitive', 'Competitive only']] },
    { key: 'kinds', label: 'Events', options: [['all', 'Everything'], ['major', 'Calls, flips, leads, markets'], ['calls', 'Calls and flips only']] },
    { key: 'ticker', label: 'Layout', options: [[false, 'List'], [true, 'Ticker (one line)']] },
  ],
  title: () => 'Live feed',
  mount(body, settings, ctx) {
    body.innerHTML = `<div class="feed-tools no-drag"><input type="search" placeholder="Filter by name, state, district…" aria-label="Filter events"></div><ol class="feed-list events"></ol>`;
    let q = '';
    body.querySelector('input').addEventListener('input', (e) => { q = e.target.value.toLowerCase(); draw(lastState); });
    const ok = (e) => {
      if (e.type === 'poll_close') return settings.kinds !== 'calls';
      if (e.chamber && !settings.chambers.includes(e.chamber)) return false;
      if (settings.scope === 'competitive' && e.raceId && !isCompetitive(app.race[e.raceId])) return false;
      if (settings.kinds === 'major' && !IMPORTANT.has(e.type)) return false;
      if (settings.kinds === 'calls' && !['race_called', 'flip_called', 'runoff'].includes(e.type)) return false;
      if (q && !`${e.text} ${e.state || ''} ${e.raceId || ''}`.toLowerCase().includes(q)) return false;
      return true;
    };
    let lastState = null, seen = 0;
    function draw(st) {
      if (!st) return;
      lastState = st;
      const all = [...st.list, ...st.pollCloses].filter(ok).sort((a, b) => b.t.localeCompare(a.t) || (b.id > a.id ? 1 : -1)).slice(0, 400);
      body.classList.toggle('ticker', !!settings.ticker);
      const ol = body.querySelector('ol');
      if (settings.ticker) {
        ol.innerHTML = `<li class="ticker-track">${all.slice(0, 25).map((e) => `<span class="tk" style="--c:${app.partyColor(e.party)}"><b>${esc(TYPES[e.type] || e.type)}</b> ${esc(e.text)}</span>`).join('')}</li>`;
      } else {
        ol.innerHTML = all.map((e) => `<li class="ev ev-${e.type}" ${e.raceId ? `data-race="${e.raceId}"` : ''} style="--c:${e.party ? app.partyColor(e.party) : 'var(--muted)'}">
          <span class="t">${etTime(e.t)}</span><span class="k">${esc(TYPES[e.type] || e.type)}</span><span class="x">${esc(e.text)}</span></li>`).join('')
          || `<li class="muted pad">${st.error ? `Feed error: ${esc(st.error)}` : 'No updates yet. Results start after the first polls close at 6 pm ET.'}</li>`;
      }
      ctx.meta(`${all.length} updates${app.sim ? ' · SIMULATED' : ''}`);
    }
    body.addEventListener('click', (e) => { const li = e.target.closest('[data-race]'); if (li) { selection.set(li.dataset.race); ctx.openRace?.(li.dataset.race); } });
    const un = subscribeEvents((st, fresh) => {
      draw(st);
      // toasts only for events that arrive while watching (not the backlog on first load)
      if (seen && ctx.primary) for (const e of fresh) {
        if ((e.type === 'flip_called' || (e.type === 'race_called' && isCompetitive(app.race[e.raceId]))) && ok(e)) {
          toast(`<b>${e.type === 'flip_called' ? 'Flip' : 'Called'}</b> ${esc(e.text)}`, { party: e.party, onClick: () => { selection.set(e.raceId); ctx.openRace?.(e.raceId); } });
        }
      }
      seen += st.list.length;
    });
    return { destroy: un, settingsChanged: () => draw(lastState) };
  },
};
