/* News feed with lanes (national, analysis, battleground states, race calls) and the reader window. */
import { app, hub, esc, timeAgo } from '../core.js';
import { openReader } from '../reader.js';

const LANES = [['all', 'All'], ['national', 'National'], ['analysis', 'Analysis'], ['states', 'States'], ['called', 'Race calls']];

export default {
  type: 'news', name: 'News',
  defaults: { lane: 'all' },
  settings: [{ key: 'lane', label: 'Lane', options: LANES }],
  title: (s) => (s.lane === 'all' ? 'News' : `News · ${LANES.find((l) => l[0] === s.lane)?.[1]}`),
  mount(body, settings, ctx) {
    body.innerHTML = `<div class="feed-tools no-drag"><div class="seg-toggle sm lanes">${LANES.map(([k, l]) => `<button type="button" data-lane="${k}" class="${settings.lane === k ? 'on' : ''}">${l}</button>`).join('')}</div></div><ol class="feed-list news"></ol>`;
    let items = [], shown = [];
    const seenLinks = new Set(); let first = true;
    function draw() {
      shown = settings.lane === 'all' ? items : items.filter((i) => i.lanes.includes(settings.lane));
      body.querySelector('ol').innerHTML = shown.map((i, idx) => {
        const isNew = !first && !seenLinks.has(i.link);
        return `<li class="news-item" data-idx="${idx}"><div class="src"><b>${esc(i.source)}</b><span>${i.published ? timeAgo(i.published) : ''}</span>${i.lanes.includes('called') ? '<span class="badge called">call</span>' : ''}${isNew ? '<span class="new">new</span>' : ''}</div>
          <a class="t" href="${esc(i.link)}" target="_blank" rel="noopener">${esc(i.title)}</a>${i.description ? `<div class="d">${esc(i.description)}</div>` : ''}</li>`;
      }).join('') || '<li class="muted pad">No articles in this lane yet.</li>';
      ctx.title(settings.lane === 'all' ? 'News' : `News · ${LANES.find((l) => l[0] === settings.lane)[1]}`);
    }
    body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-lane]');
      if (b) { settings.lane = b.dataset.lane; ctx.save({ lane: b.dataset.lane }); body.querySelectorAll('[data-lane]').forEach((x) => x.classList.toggle('on', x === b)); draw(); return; }
      const a = e.target.closest('a.t');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openReader(shown, +a.closest('.news-item').dataset.idx);
    });
    const un = hub.subscribe('news', (s) => {
      if (s.data) { items = s.data.items; draw(); items.forEach((i) => seenLinks.add(i.link)); first = false; }
      ctx.meta(s.error ? 'feed error' : `${items.length} articles · ${timeAgo(s.data?.fetchedAt)}${s.data?.errors?.length ? ' · some feeds failed' : ''}`);
    });
    return { destroy: un, settingsChanged: draw };
  },
};
