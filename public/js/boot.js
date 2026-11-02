/* Entry point: load config + manifest, register window types, start the WM, restore the layout. */
import { app, $, esc, hub, loadApp, timeAgo, toast, subscribeEvents } from './core.js';
import { createWM } from './wm.js';
import * as L from './layout.js';
import { setupReader } from './reader.js';
import { startLive } from './live.js';
import { startTransport } from './transport.js';
import { startTour, tourSeen } from './tour.js';
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
import posts from './views/posts.js';
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
    '<b>Posts</b> Bluesky, X, Truth Social',
    '<b>Searches</b> Google Trends',
    '<b>Maps</b> US Census Bureau',
    '<b>Video</b> each channel\'s own player',
  ];
  const el = $('#credits');
  const sources = `${parts.join(' · ')} · Independent dashboard, not affiliated with any source.`;
  const disclaimer = 'Data is raw, aggregated from these sources as they publish it, and may be incomplete, delayed or later corrected. This dashboard is non-partisan, endorses no candidate or party, and exists for real-time and historical analysis of the election.';
  // ribbon under the timeline: a looping ticker (two copies, shifted by one copy's width) when it does not fit on one line
  const src = $('#credits-sources');
  src.innerHTML = `<span class="ticker"><span>${sources}</span><span aria-hidden="true">${sources}</span></span>`;
  const one = src.querySelector('.ticker span'); src.title = one.textContent;
  const fit = () => {
    const pad = parseFloat(getComputedStyle(one).paddingRight) || 0;
    const w = one.getBoundingClientRect().width - (src.classList.contains('scroll') ? pad : 0);
    const scroll = innerWidth > 900 && !matchMedia('(prefers-reduced-motion: reduce)').matches && w > src.clientWidth - 24;
    src.classList.toggle('scroll', scroll);
    if (scroll) src.style.setProperty('--ticker-s', `${Math.round(one.getBoundingClientRect().width / 20)}s`); // ~20 px/s
  };
  fit(); new ResizeObserver(fit).observe(src);
  el.innerHTML = `<div class="credits-line disclaimer" id="disclaimer">${esc(disclaimer)}</div>`; // footer
  el.querySelector('.disclaimer').title = disclaimer;
}

async function main() {
  await loadApp();
  if (app.sim) document.body.classList.add('sim'); // before the WM measures the desktop: the banner takes height
  L.registerTypes([balance, map, chamber, feed, race, races, timeline, stream, news, posts, social, markets, trends, stocks]);
  const presets = app.config.presets;
  const wm = createWM({
    desk: $('#desktop'),
    title: L.titleOf,
    onClose: L.closed,
    onChange: L.persist,
    launcherItems: (q, loc) => L.launcherItems(q, loc),
    onLaunch: (it) => {
      const [kind, arg, settings] = it.action;
      if (kind === 'focus') wm.open(arg);
      if (kind === 'new') L.create(arg, settings || {});
    },
    helpExtra: `<h3>Dashboard</h3><p>Every window has a gear for its settings; Panels opens new windows of any type; Layouts loads a named layout. <b>Share</b> copies a link that carries this whole layout.</p>
      <p><button type="button" id="tour-start">Take the tour</button> <span class="muted">a guided walk through every part of the dashboard</span></p>
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
    themeBtn.textContent = light ? '☾' : '☀'; themeBtn.title = label; themeBtn.setAttribute('aria-label', label); themeBtn.setAttribute('aria-pressed', String(light));
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
  // Layouts: the named presets in a menu under the button; choosing one replaces the whole layout
  const menu = $('#layouts-menu'), lbtn = $('#bar-layouts');
  menu.innerHTML = Object.entries(presets).map(([k, p]) => `<button type="button" role="menuitem" data-preset="${esc(k)}"><b>${esc(p.name)}</b><span>${esc(p.description)}</span></button>`).join('');
  const showMenu = (on) => {
    menu.hidden = !on; lbtn.setAttribute('aria-expanded', String(on));
    if (on) { // fixed boxes measure from the page width without the scrollbar, which innerWidth includes
      const r = lbtn.getBoundingClientRect(), vw = document.documentElement.clientWidth;
      menu.style.top = `${r.bottom + 6}px`; menu.style.right = `${Math.max(8, Math.min(vw - r.right, vw - menu.offsetWidth - 8))}px`; menu.querySelector('button')?.focus(); }
  };
  lbtn.addEventListener('click', () => showMenu(menu.hidden));
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-preset]'); if (!b) return;
    showMenu(false); L.apply(L.preset(presets, b.dataset.preset)); toast(`Loaded layout <b>${esc(presets[b.dataset.preset].name)}</b>`);
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !e.target.closest('#layouts-menu, #bar-layouts')) showMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { showMenu(false); lbtn.focus(); } });
  $('#wm-reset').addEventListener('click', () => { L.apply(L.preset(presets, 'night')); wm.help(false); toast('Layout reset to <b>Election night</b>.'); });
  $('#wm-restore').addEventListener('click', () => {
    try { const b = JSON.parse(localStorage.getItem('us-dash-layout-v1-backup')); if (b) { L.apply(b); wm.help(false); toast('Restored your previous layout.'); } } catch {}
  });
  subscribeEvents(() => {}); // keep events flowing for toasts even when no feed window is open
  startLive();
  startTransport();
  // first visit: the guided tour, once the windows have drawn. ?tour=1 forces it, ?tour=0 skips it.
  $('#help').addEventListener('click', (e) => { if (e.target.id === 'tour-start') { wm.help(false); startTour({ force: true }); } });
  const tourParam = new URLSearchParams(location.search).get('tour');
  if (tourParam === '1') setTimeout(() => startTour({ force: true }), 1200);
  else if (tourParam !== '0') setTimeout(() => { if (!tourSeen()) startTour(); }, 1200);
  // a share link pasted into a tab already on the dashboard only changes the hash: load it properly
  addEventListener('hashchange', () => { if (/^#l=/.test(location.hash)) location.reload(); });
}
main().catch((e) => { $('#status').innerHTML = `<span class="warn">Start-up failed: ${esc(e.message)}</span>`; console.error(e); });
