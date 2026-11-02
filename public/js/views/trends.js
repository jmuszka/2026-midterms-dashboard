/* Google Trends: what the US is searching right now (trending RSS). */
import { hub, esc, timeAgo, etTime, dataNote, placeholder } from '../core.js';
import { clock } from '../clock.js';

export default {
  type: 'trends', name: 'Google Trends',
  defaults: {},
  settings: [],
  title: () => 'Trending searches',
  mount(body, settings, ctx) {
    body.classList.add('feed-list');
    const un = hub.subscribe('trends', (s) => {
      const items = s.data?.items || [];
      const replay = !!s.data?.replay, now = replay ? clock.t : Date.now(); // in replay, ages are relative to the moment
      body.innerHTML = items.map((i, k) => `<div class="trend"><span class="rank">${k + 1}</span><div><b>${esc(i.term)}</b> <span class="muted">${esc(i.traffic || '')} searches · ${timeAgo(i.published, now)}</span>${i.story ? `<br><a href="${esc(i.storyUrl)}" target="_blank" rel="noopener">${esc(i.story)}</a>` : ''}</div></div>`).join('')
        || (replay ? '<p class="muted">No trending list was recorded by this moment.</p>' : placeholder(s));
      ctx.meta(replay && s.data.ranAt ? `Google Trends, US · as of ${etTime(s.data.ranAt)} ET` : 'Google Trends, US'); ctx.state('trends', dataNote(s, 'trends'));
    });
    return { destroy: un };
  },
};
