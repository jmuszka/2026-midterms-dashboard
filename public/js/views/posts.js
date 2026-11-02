/* Social media feed: everyone from every platform in one stream, filtered by platform, group
 * (the lists in config/sources.json: analysts, senators, pundits…) and individual. A post shows
 * when its platform, at least one of its groups and its author are all ticked. null = everything
 * ticked, so accounts added to the config later are included until the user narrows a section.
 * The launcher's "New feed" entries are presets of this one type (launch() below). */
import { app, hub, esc, timeAgo } from '../core.js';
import { post, PLATFORM } from './social.js';

const lists = () => app.config.social || {};
const personKey = (platform, handle) => `${platform}:${handle.toLowerCase()}`;
// every tracked account once, with the groups it belongs to
export function people() {
  const out = new Map();
  for (const [lid, l] of Object.entries(lists())) for (const a of l.accounts || []) {
    const k = personKey(a.platform, a.handle);
    const cur = out.get(k) || { key: k, platform: a.platform, handle: a.handle, name: a.name || a.handle, lists: [] };
    if (!cur.lists.includes(lid)) cur.lists.push(lid);
    out.set(k, cur);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const on = (set, v) => set == null || set.includes(v);
export function matches(p, s) {
  if (!on(s.platforms, p.platform)) return false;
  const groups = p.lists || [];
  if (s.lists != null && !groups.some((g) => s.lists.includes(g))) return false;
  if (s.people != null && !s.people.includes(personKey(p.platform, p.acct || p.repostBy?.handle || p.author?.handle || ''))) return false;
  return true;
}
const names = (ids, dict) => ids.map((k) => dict[k] || k);
export function titleFor(s) {
  const L = lists();
  if (s.people?.length === 1) return people().find((x) => x.key === s.people[0])?.name || 'Social';
  if (s.people?.length > 1 && s.people.length <= 3) return names(s.people, Object.fromEntries(people().map((x) => [x.key, x.name]))).join(', ');
  const plats = s.platforms?.length ? names(s.platforms, PLATFORM).join(' + ') : '';
  if (s.lists?.length) { const l = names(s.lists, Object.fromEntries(Object.entries(L).map(([k, v]) => [k, v.name]))); return (l.length <= 2 ? l.join(' + ') : `${l.length} groups`) + (plats ? ` on ${plats}` : ''); }
  if (s.people?.length) return `${s.people.length} people${plats ? ` on ${plats}` : ''}`;
  return plats ? `${plats} feed` : 'Everyone';
}

const POLITICIANS = ['senators', 'representatives', 'governors', 'administration'];
export default {
  type: 'posts', name: 'Social media feed',
  defaults: { platforms: null, lists: null, people: null },
  settings: [
    { key: 'platforms', type: 'multi', label: 'Platforms', options: () => Object.entries(PLATFORM) },
    { key: 'lists', type: 'multi', label: 'Groups', options: () => Object.entries(lists()).map(([k, v]) => [k, v.name]) },
    { key: 'people', type: 'multi', label: 'People', groupBy: () => Object.entries(lists()).map(([k, v]) => [k, v.name]),
      options: () => people().flatMap((x) => x.lists.map((lid) => [x.key, `${x.name} (${PLATFORM[x.platform] || x.platform})`, lid])) },
  ],
  // launcher presets: "New feed" entries, each a settings object for this type
  launch: () => [
    { label: 'Everyone', sub: 'every tracked account on every platform', settings: {} },
    { label: 'X feed', sub: 'X accounts only (needs the X token)', settings: { platforms: ['x'] } },
    { label: 'Bluesky feed', sub: 'Bluesky accounts only', settings: { platforms: ['bluesky'] } },
    { label: 'Trump feed', sub: 'Donald Trump only', settings: { people: ['truthsocial:realdonaldtrump'] } },
    { label: 'Analysts feed', sub: 'election analysts and forecasters', settings: { lists: ['analysts', 'x-analysts'] } },
    { label: 'Pundits feed', sub: 'commentators, both sides', settings: { lists: ['pundits'] } },
    { label: 'Politicians feed', sub: 'senators, representatives, governors, the administration', settings: { lists: POLITICIANS } },
    { label: 'Trump administration', sub: 'Trump on Truth Social, the cabinet and the White House on X', settings: { lists: ['administration', 'trump'] } },
    { label: 'Former officials', sub: 'Harris, Obama, Clinton, Pence…', settings: { lists: ['former'] } },
  ],
  title: titleFor,
  mount(body, settings, ctx) {
    let un = null, last = null;
    const draw = () => {
      if (!last) return;
      const d = last.data;
      if (!d) { body.innerHTML = `<p class="feed-error">${esc(last.error || 'Loading…')}</p>`; return; }
      const shown = d.posts.filter((p) => matches(p, settings));
      const errs = d.errors || [];
      body.innerHTML = (shown.map(post).join('') || `<p class="muted pad">${d.posts.length ? 'Nothing from the selected platforms, groups and people yet.' : 'No posts yet.'}</p>`)
        + (errs.length ? `<p class="feed-error">${errs.map(esc).join('<br>')}</p>` : '');
      ctx.title(titleFor(settings));
      ctx.meta(`${shown.length} of ${d.posts.length} posts · ${timeAgo(d.ranAt)}${d.stale ? ' · stale' : ''}`);
    };
    body.className = 'panel-body feed-list social s-all';
    body.innerHTML = '<p class="muted pad">Loading…</p>';
    un = hub.subscribe('social:all', (s) => { last = s; draw(); });
    return { destroy: () => un?.(), settingsChanged: draw };
  },
};
