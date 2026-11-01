/* Google Trends: what the US is searching right now (trending RSS). */
import { hub, esc, timeAgo, dataNote, placeholder } from '../core.js';

export default {
  type: 'trends', name: 'Google Trends',
  defaults: {},
  settings: [],
  title: () => 'Trending searches',
  mount(body, settings, ctx) {
    body.classList.add('feed-list');
    const un = hub.subscribe('trends', (s) => {
      const items = s.data?.items || [];
      body.innerHTML = items.map((i, k) => `<div class="trend"><span class="rank">${k + 1}</span><div><b>${esc(i.term)}</b> <span class="muted">${esc(i.traffic || '')} searches · ${timeAgo(i.published)}</span>${i.story ? `<br><a href="${esc(i.storyUrl)}" target="_blank" rel="noopener">${esc(i.story)}</a>` : ''}</div></div>`).join('') || placeholder(s);
      ctx.meta('Google Trends, US'); ctx.state('trends', dataNote(s, 'trends'));
    });
    return { destroy: un };
  },
};
