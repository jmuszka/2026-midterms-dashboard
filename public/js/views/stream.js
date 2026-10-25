/* Live stream carousel. Sources come from config/sources.json; /api/streams says
 * which are live and gives a concrete video id, because embed/live_stream?channel=
 * breaks whenever a channel runs two streams at once (most networks on election night). */
import { app, hub, esc } from '../core.js';

const TAGS = { network: 'US networks', independent: 'Independent', international: 'International', local: 'Local stations' };
function parseYouTube(s) {
  s = (s || '').trim();
  const m = s.match(/(?:youtu\.be\/|v=|\/live\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || s.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}
function embedUrl(src, live, muted) {
  const mute = muted ? 1 : 0;
  if (src.platform === 'custom') return `https://www.youtube.com/embed/${src.videoId}?autoplay=1&mute=${mute}`;
  if (src.platform === 'twitch') return `https://player.twitch.tv/?channel=${encodeURIComponent(src.channel)}&parent=${location.hostname}&muted=${!!muted}&autoplay=true`;
  if (src.platform === 'kick') return `https://player.kick.com/${encodeURIComponent(src.channel)}?autoplay=true&muted=${!!muted}`;
  if (live?.videoId && (live.status === 'live' || live.status === 'upcoming')) return `https://www.youtube.com/embed/${live.videoId}?autoplay=1&mute=${mute}`;
  return `https://www.youtube.com/embed/live_stream?channel=${src.channel}&autoplay=1&mute=${mute}`;
}

export default {
  type: 'stream', name: 'Live stream',
  defaults: { source: 'nbc', muted: true, cycle: 0, liveOnly: true, custom: '' },
  settings: [
    { key: 'source', label: 'Source', options: () => app.config.streams.map((s) => [s.id, s.name]) },
    { key: 'muted', label: 'Sound', options: [[true, 'Muted'], [false, 'Sound on']] },
    { key: 'cycle', label: 'Auto-cycle', options: [[0, 'Off'], [60, 'Every minute'], [120, 'Every 2 min'], [300, 'Every 5 min'], [600, 'Every 10 min']] },
    { key: 'liveOnly', label: 'Prev/next', options: [[true, 'Live sources only'], [false, 'All sources']] },
  ],
  title: (s) => (s.custom ? 'YouTube' : app.config.streams.find((x) => x.id === s.source)?.name || 'Live stream'),
  mount(body, settings, ctx) {
    let live = {};
    body.classList.add('video-panel');
    body.innerHTML = `<div class="stream-tools no-drag">
        <button type="button" class="prev" title="Previous source">‹</button>
        <select class="pick" aria-label="Stream source"></select>
        <button type="button" class="next" title="Next source">›</button>
        <button type="button" class="mute"></button>
        <form class="inline-form"><input type="text" placeholder="Paste a YouTube link" aria-label="YouTube URL or ID"><button type="submit">Load</button></form>
        <span class="live-note muted"></span>
      </div><div class="video-box"><iframe title="Live stream" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
    const frame = body.querySelector('iframe'), pick = body.querySelector('.pick');
    const sources = () => app.config.streams;
    const current = () => (settings.custom ? { id: 'custom', name: 'YouTube', platform: 'custom', videoId: settings.custom } : sources().find((s) => s.id === settings.source) || sources()[0]);
    const isLive = (s) => s.platform !== 'youtube' || live[s.id]?.status === 'live' || (s['24x7'] && live[s.id]?.status !== 'offline');
    function fillPicker() {
      const groups = {};
      for (const s of sources()) (groups[s.tag] ||= []).push(s);
      pick.innerHTML = Object.entries(groups).map(([tag, list]) => `<optgroup label="${esc(TAGS[tag] || tag)}">${list.map((s) => {
        const st = live[s.id]?.status;
        const mark = st === 'live' ? '● ' : st === 'upcoming' ? '◷ ' : s.platform === 'twitch' ? '' : '○ ';
        return `<option value="${s.id}">${mark}${esc(s.name)}${st === 'upcoming' ? ' (scheduled)' : ''}</option>`;
      }).join('')}</optgroup>`).join('') + (settings.custom ? '<option value="custom">Pasted video</option>' : '');
      pick.value = settings.custom ? 'custom' : settings.source;
    }
    function load() {
      const src = current();
      const url = embedUrl(src, live[src.id], settings.muted);
      if (frame.dataset.src !== url) { frame.src = url; frame.dataset.src = url; }
      body.querySelector('.mute').textContent = settings.muted ? 'Unmute' : 'Mute';
      const l = live[src.id];
      body.querySelector('.live-note').textContent = l?.status === 'live' ? `Live: ${l.title || ''}` : l?.status === 'upcoming' ? `Scheduled: ${l.title || ''}` : l?.status === 'offline' ? 'Not live right now' : '';
      ctx.title(src.name);
    }
    const step = (d) => {
      const list = sources().filter((s) => !settings.liveOnly || isLive(s));
      const pool = list.length ? list : sources();
      const i = pool.findIndex((s) => s.id === settings.source);
      settings.source = pool[(i + d + pool.length) % pool.length].id; settings.custom = '';
      ctx.save({ source: settings.source, custom: '' }); fillPicker(); load();
    };
    body.querySelector('.prev').addEventListener('click', () => step(-1));
    body.querySelector('.next').addEventListener('click', () => step(1));
    pick.addEventListener('change', () => { if (pick.value === 'custom') return; settings.source = pick.value; settings.custom = ''; ctx.save({ source: pick.value, custom: '' }); load(); });
    body.querySelector('.mute').addEventListener('click', () => { settings.muted = !settings.muted; ctx.save({ muted: settings.muted }); load(); });
    body.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = parseYouTube(body.querySelector('form input').value);
      if (!id) return;
      settings.custom = id; ctx.save({ custom: id }); fillPicker(); load();
    });
    let timer = null;
    const arm = () => { clearInterval(timer); if (+settings.cycle > 0) timer = setInterval(() => step(1), settings.cycle * 1000); };
    const un = hub.subscribe('streams', (s) => { live = s.data?.streams || live; fillPicker(); load(); });
    fillPicker(); load(); arm();
    return {
      destroy() { un(); clearInterval(timer); frame.src = 'about:blank'; },
      settingsChanged() { fillPicker(); load(); arm(); },
    };
  },
};
