/* Live stream carousel. Sources come from config/sources.json; /api/streams says
 * which are live and gives a concrete video id, because embed/live_stream?channel=
 * breaks whenever a channel runs two streams at once (most networks on election night). */
import { app, hub, esc, etTime, dataNote } from '../core.js';
import { clock } from '../clock.js';
import { streamAt } from '../timeline.js';

// YouTube IFrame Player API, loaded once, only when a replay needs a seekable player
let ytReady = null;
function youtubeApi() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true; document.head.appendChild(s);
  });
  return ytReady;
}
const REASON = {
  'not-recorded': 'This channel was not recorded, so it cannot be replayed.',
  'before-recording': 'Recording of this channel had not started yet at this moment.',
  offline: 'This channel was not streaming at this moment.',
  'not-started': 'This channel\'s stream had not started yet at this moment.',
  'not-archived': 'YouTube did not keep this part of the stream (archives keep about the first 12 hours).',
  'no-dvr': 'This channel\'s live stream cannot be rewound, so this moment is not available until it is archived.',
};

const TAGS = { network: 'US networks', independent: 'Independent', international: 'International', local: 'Local stations' };
function parseYouTube(s) {
  s = (s || '').trim();
  const m = s.match(/(?:youtu\.be\/|v=|\/live\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/) || s.match(/^([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}
// Embeds start muted so autoplay is allowed; sound is the player's own button (YouTube ignores
// our mute state once the user touches its control, so there is no setting for it).
function embedUrl(src, live) {
  const mute = 1, muted = true; // Twitch/Kick take booleans
  if (src.platform === 'custom') return `https://www.youtube.com/embed/${src.videoId}?autoplay=1&mute=${mute}`;
  if (src.platform === 'twitch') return `https://player.twitch.tv/?channel=${encodeURIComponent(src.channel)}&parent=${location.hostname}&muted=${!!muted}&autoplay=true`;
  if (src.platform === 'kick') return `https://player.kick.com/${encodeURIComponent(src.channel)}?autoplay=true&muted=${!!muted}`;
  if (live?.videoId && (live.status === 'live' || live.status === 'upcoming')) return `https://www.youtube.com/embed/${live.videoId}?autoplay=1&mute=${mute}`;
  return `https://www.youtube.com/embed/live_stream?channel=${src.channel}&autoplay=1&mute=${mute}`;
}

export default {
  type: 'stream', name: 'Live stream',
  defaults: { source: 'nbc', cycle: 0, liveOnly: true, custom: '' },
  settings: [
    { key: 'source', label: 'Source', options: () => app.config.streams.map((s) => [s.id, s.name]) },
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
        <form class="inline-form"><input type="text" placeholder="Paste a YouTube link" aria-label="YouTube URL or ID"><button type="submit">Load</button></form>
        <span class="live-note muted"></span>
      </div><div class="video-box"><iframe title="Live stream" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
        <div class="replay-player" hidden><div></div></div><div class="replay-note" hidden></div></div>`;
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
      if (clock.mode === 'replay' && streamAt(current().id, clock.t) !== undefined) return sync();
      const src = current();
      leaveReplay();
      const url = embedUrl(src, live[src.id]);
      if (frame.dataset.src !== url) { frame.src = url; frame.dataset.src = url; }
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
    body.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = parseYouTube(body.querySelector('form input').value);
      if (!id) return;
      settings.custom = id; ctx.save({ custom: id }); fillPicker(); load();
    });
    /* ---------- replay sync (docs/SCRUBBER.md §6) ----------
     * Live timeline = live stream. In replay the window shows the same channel at the clock's
     * moment: seconds behind the live edge while the stream is still live (DVR), or seconds
     * since its start once archived. Paused or scrubbing: the video is paused on that moment.
     * Playing at 1x/2x: the video plays at that rate and is re-seeked if it drifts > 3 s.
     * Faster: stills at the right moment (YouTube cannot play faster than 2x). */
    const box = body.querySelector('.video-box'), rp = body.querySelector('.replay-player'), note = body.querySelector('.replay-note');
    let player = null, playerVideo = null, playerReady = false, pendingSeek = null;
    function leaveReplay() {
      if (!rp.hidden) { try { player?.pauseVideo(); } catch {} }
      rp.hidden = true; note.hidden = true;
      frame.hidden = false;
      delete box.dataset.syncVideo; delete box.dataset.syncPos; delete box.dataset.syncMode;
    }
    function showNote(text) {
      note.hidden = false; note.textContent = text;
      rp.hidden = true; try { player?.pauseVideo(); } catch {}
    }
    const desiredPos = (tgt) => {
      if (tgt.mode === 'vod') return tgt.pos;
      const d = playerReady ? player.getDuration?.() : 0; // live DVR: duration is the live edge
      return d > 0 ? Math.max(0, d - tgt.behind) : tgt.pos ?? 0;
    };
    async function sync() {
      const src = current();
      const tgt = streamAt(src.id, clock.t);
      if (tgt === undefined) { leaveReplay(); return load(); } // nothing to replay for this channel: stay live
      // stop the live embed so two audio tracks never play
      if (frame.dataset.src !== 'about:blank') { frame.src = 'about:blank'; frame.dataset.src = 'about:blank'; }
      frame.hidden = true;
      body.querySelector('.live-note').textContent = `Replay · ${etTime(clock.t)} ET`;
      if (tgt.kind === 'none') { box.dataset.syncMode = tgt.reason; delete box.dataset.syncVideo; return showNote(REASON[tgt.reason] || 'Not available in replay.'); }
      note.hidden = true; rp.hidden = false;
      const pos = desiredPos(tgt);
      Object.assign(box.dataset, { syncVideo: tgt.videoId, syncPos: pos.toFixed(1), syncMode: tgt.mode });
      ctx.title(`${src.name} · replay`);
      const YT = await youtubeApi();
      if (!player) {
        playerVideo = tgt.videoId; pendingSeek = pos;
        player = new YT.Player(rp.firstElementChild, {
          videoId: tgt.videoId, width: '100%', height: '100%',
          playerVars: { autoplay: 0, start: Math.floor(pos), playsinline: 1, rel: 0, mute: 1, origin: location.origin },
          events: {
            onReady: () => { playerReady = true; sync(); },
            // published for tests and debugging: the player's real state and position
            onStateChange: (e) => { box.dataset.ytState = String(e.data); box.dataset.ytTime = (player.getCurrentTime?.() || 0).toFixed(1); box.dataset.ytDuration = (player.getDuration?.() || 0).toFixed(1); },
          },
        });
        return;
      }
      if (!playerReady) return;
      if (playerVideo !== tgt.videoId) { playerVideo = tgt.videoId; player.cueVideoById({ videoId: tgt.videoId, startSeconds: Math.floor(pos) }); }
      const cur = player.getCurrentTime?.() || 0;
      box.dataset.ytTime = cur.toFixed(1); box.dataset.ytDuration = (player.getDuration?.() || 0).toFixed(1);
      const rolling = clock.playing && clock.speed <= 2;
      if (rolling) {
        if (player.getPlaybackRate?.() !== clock.speed) player.setPlaybackRate(clock.speed);
        if (Math.abs(cur - pos) > 3) player.seekTo(pos, true);
        player.playVideo();
      } else {
        player.pauseVideo();
        if (Math.abs(cur - pos) > 1) player.seekTo(pos, true);
      }
    }
    const unClock = clock.subscribe(() => { if (clock.mode === 'replay') sync(); else load(); });
    const drift = setInterval(() => { if (clock.mode === 'replay' && clock.playing) sync(); }, 2000);

    let timer = null;
    const arm = () => { clearInterval(timer); if (+settings.cycle > 0) timer = setInterval(() => step(1), settings.cycle * 1000); };
    const un = hub.subscribe('streams', (s) => { live = s.data?.streams || live; fillPicker(); load(); ctx.state('streams', s.error ? dataNote(s, 'stream list') : ''); });
    fillPicker(); load(); arm();
    return {
      destroy() { un(); unClock(); clearInterval(timer); clearInterval(drift); frame.src = 'about:blank'; try { player?.destroy(); } catch {} },
      settingsChanged() { fillPicker(); load(); arm(); },
    };
  },
};
