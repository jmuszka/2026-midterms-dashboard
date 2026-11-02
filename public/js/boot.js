/* Entry point: load config + manifest, register window types, start the WM, restore the layout. */
import { app, $, esc, hub, loadApp, timeAgo, toast, subscribeEvents } from './core.js';
import { createWM } from './wm.js';
import * as L from './layout.js';
import { setupReader } from './reader.js';
import { startLive } from './live.js';
import { startTransport } from './transport.js';
import balance from './views/balance.js';
import map from './views/map.js';
import chamber from './views/chamber.js';
import feed from './views/feed.js';
import race from './views/race.js';
import races from './views/races.js';
import timeline from './views/timeline.js';
import stream from './views/stream.js';
import news from './views/news.js';
import social from './views/social.js';
import markets from './views/markets.js';
import trends from './views/trends.js';
import stocks from './views/stocks.js';

// Attribution footer: every source on screen is named, built from the served config.
function credits() {
  const st = app.config.attribution?.states || [];
  const states = st.length ? `<span title="${esc(st.map((s) => s.name).join(', '))}">state election offices (${st.map((s) => esc(s.state)).join(', ')})</span>` : '';
  const parts = [
    `<b>Results</b> ${esc(app.config.attribution?.cnn || 'CNN / AP')} (race calls are AP's)${states ? `; ${states}` : ''}`,
    '<b>Odds</b> Kalshi, Polymarket, PredictIt (markets, not results)',
    '<b>Quotes</b> CNBC',
    '<b>News</b> publishers\' RSS feeds, Google News',
    '<b>Posts</b> Bluesky, Truth Social',
    '<b>Searches</b> Google Trends',
    '<b>Maps</b> US Census Bureau',
    '<b>Video</b> each channel\'s own player',
  ];
  const el = $('#credits');
  el.innerHTML = `${parts.join(' · ')} · Independent dashboard, not affiliated with any source.`;
  el.title = el.textContent;
}

async function main() {
  await loadApp();
  if (app.sim) document.body.classList.add('sim'); // before the WM measures the desktop: the banner takes height
  L.registerTypes([balance, map, chamber, feed, race, races, timeline, stream, news, social, markets, trends, stocks]);
  const presets = app.config.presets;
  const wm = createWM({
    desk: $('#desktop'),
    title: L.titleOf,
    onClose: L.closed,
    onChange: L.persist,
    launcherItems: (q, loc) => L.launcherItems(q, loc, presets),
    onLaunch: (it) => {
      const [kind, arg] = it.action;
      if (kind === 'focus') wm.open(arg);
      if (kind === 'new') L.create(arg);
      if (kind === 'preset') { L.apply(L.preset(presets, arg)); toast(`Loaded preset <b>${esc(presets[arg].name)}</b>`); }
    },
    helpExtra: `<h3>Dashboard</h3><p>Every window has a gear for its settings; the launcher (Panels) opens new windows of any type and loads presets. <b>Share</b> copies a link that carries this whole layout.</p>
      <p>${app.sim ? '<a href="?">Leave simulation mode</a>' : '<a href="?sim=1">Open simulation mode</a>: replays a made-up election night at 30× speed so you can try every view before Nov 3.'}</p>
      <p class="muted">Results: CNN (AP) and official state feeds. Markets: Kalshi, Polymarket, PredictIt. Calls are only shown when a source makes them.</p>`,
  });
  L.init(wm);
  credits();
  window.wm = wm; // for tests and the console, as before
  setupReader();
  await L.restore(presets);

  // site notice (config/notice.json via /api/config): permanent until dismissed; a new text shows again
  const notice = app.config.notice;
  const nb = $('#notice-banner');
  const noticeKey = notice ? `us-dash-notice:${notice.text}` : null;
  let dismissed = false; try { dismissed = !!(noticeKey && localStorage.getItem(noticeKey)); } catch {}
  if (notice && !dismissed) {
    const act = notice.href ? `<a href="${esc(notice.href)}" target="_blank" rel="noopener">${esc(notice.actionLabel || notice.href)}</a>`
      : notice.action ? `<button type="button" class="act" data-action="${esc(notice.action)}">${esc(notice.actionLabel || notice.action)}</button>` : '';
    nb.innerHTML = `<span>${esc(notice.text)}</span>${act}<button type="button" class="x" title="Dismiss" aria-label="Dismiss notice">✕</button>`;
    nb.hidden = false;
    nb.querySelector('.x').addEventListener('click', () => { nb.hidden = true; try { localStorage.setItem(noticeKey, '1'); } catch {} wm.render(); });
    nb.querySelector('[data-action="timeline"]')?.addEventListener('click', () => {
      const track = $('#transport .tl-track');
      if ($('#transport').hidden || !track) { toast('The timeline appears once the night has been recorded.'); return; }
      track.focus(); track.classList.add('flash'); setTimeout(() => track.classList.remove('flash'), 1500);
      toast('Drag the timeline, or press ← → to step through the night.');
    });
  }

  // bar: theme toggle (dark is the default; light is remembered in localStorage us-dash-theme)
  const themeBtn = $('#bar-theme');
  const setTheme = (light) => {
    if (light) document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
    const label = light ? 'Switch to dark mode' : 'Switch to light mode';
    themeBtn.textContent = light ? '☀' : '☾'; themeBtn.title = label; themeBtn.setAttribute('aria-label', label); themeBtn.setAttribute('aria-pressed', String(light));
    try { localStorage.setItem('us-dash-theme', light ? 'light' : 'dark'); } catch {}
  };
  setTheme(document.documentElement.dataset.theme === 'light');
  themeBtn.addEventListener('click', () => setTheme(document.documentElement.dataset.theme !== 'light'));

  // bar: clock (ET), status, share, reset
  const clock = () => { $('#clock').textContent = `${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`; };
  clock(); setInterval(clock, 10000);
  hub.subscribe('results', (s) => {
    const d = s.data;
    const st = $('#status');
    if (!d) { st.innerHTML = `<span class="warn">${esc(s.error || 'loading results…')}</span>`; return; }
    if (d.replay) { st.innerHTML = `<b>REPLAY</b> · ${new Date(d.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET · as recorded${d.simulated ? ' (simulated night)' : ''} · press L for live`; return; }
    if (d.simulated) { st.innerHTML = `<b class="sim-tag">SIMULATION</b> sim clock ${new Date(d.simTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET · not real results`; return; }
    const reporting = Object.values(d.races).filter((r) => r.totalVotes > 0).length;
    const called = Object.values(d.races).filter((r) => r.called).length;
    st.innerHTML = `${reporting ? `${reporting} races reporting · ${called} called` : 'No votes counted yet'} · data ${timeAgo(d.ranAt)}${d.stale ? ' <span class="warn">(stale)</span>' : ''}${s.error ? ` <span class="warn">${esc(s.error)}</span>` : ''}`;
  });
  $('#bar-share').addEventListener('click', async () => {
    const url = await L.shareLink();
    try { await navigator.clipboard.writeText(url); toast('Share link copied. Anyone who opens it gets this exact dashboard.'); }
    catch { prompt('Copy this link to share the dashboard:', url); }
  });
  $('#wm-reset').addEventListener('click', () => { L.apply(L.preset(presets, 'night')); wm.help(false); toast('Layout reset to <b>Election night</b>.'); });
  $('#wm-restore').addEventListener('click', () => {
    try { const b = JSON.parse(localStorage.getItem('us-dash-layout-v1-backup')); if (b) { L.apply(b); wm.help(false); toast('Restored your previous layout.'); } } catch {}
  });
  subscribeEvents(() => {}); // keep events flowing for toasts even when no feed window is open
  startLive();
  startTransport();
  // a share link pasted into a tab already on the dashboard only changes the hash: load it properly
  addEventListener('hashchange', () => { if (/^#l=/.test(location.hash)) location.reload(); });
}
main().catch((e) => { $('#status').innerHTML = `<span class="warn">Start-up failed: ${esc(e.message)}</span>`; console.error(e); });
