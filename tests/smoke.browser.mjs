// Usage: node tests/smoke.browser.mjs <scratch-dir> [base-url]   (needs chromium on PATH)
// Loads the dashboard in simulation mode with a pinned clock, visits every workspace of the
// default preset, screenshots each, and checks that every window type rendered real content
// with no uncaught errors. Also exercises the launcher, a settings change and the share link.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [out, base = 'http://localhost:8787'] = process.argv.slice(2);
const simAt = process.env.SIM_AT || 240;
fs.mkdirSync(out, { recursive: true });
fs.rmSync(`${out}/smoke-profile`, { recursive: true, force: true });
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9338', `--user-data-dir=${out}/smoke-profile`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 40 && !ws; i++) { await sleep(250); try { ws = (await (await fetch('http://127.0.0.1:9338/json')).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map(); const errs = [];
sock.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.split('\n').slice(0, 3).join(' ') || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errs.push('console.error: ' + d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/youtube|twitch|doubleclick|googlevideo|ytimg|google\.com|gstatic/.test(d.params.entry.url || '')) errs.push(`log: ${d.params.entry.text} ${d.params.entry.url || ''}`.slice(0, 300));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description }; return r.result?.result?.value; };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}/${n}`, Buffer.from(r.result.data, 'base64')); };
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== '' ? '  ' + extra : ''}`); };
const waitFor = async (expr, ms = 15000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await sleep(250); } return false; };

await send('Runtime.enable'); await send('Log.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${base}/?sim=1&simAt=${simAt}` });
check('app booted (windows present)', await waitFor(`document.querySelectorAll('.win').length > 10`), await ev(`document.querySelectorAll('.win').length`));
await sleep(4000);

// first-visit tour: shows once, Next/Back move the spotlight, Skip ends it and is remembered
check('tour opens on the first visit', await waitFor(`!!document.querySelector('#tour') && /Welcome/.test(document.querySelector('#tour-title').textContent)`, 5000), await ev(`document.querySelector('#tour-title')?.textContent`));
check('tour marks the visit as seen', await ev(`localStorage.getItem('us-dash-tour-v1') === '1'`));
await ev(`document.querySelector('#tour .tour-next').click()`); await sleep(400);
const stepTitle = await ev(`document.querySelector('#tour-title').textContent`);
check('Next moves to the status step with the spotlight on it', stepTitle === 'The status line' && await ev(`(() => { const s = document.querySelector('#tour .tour-spot').getBoundingClientRect(), t = document.querySelector('#status').getBoundingClientRect(); return Math.abs(s.left + 6 - t.left) < 2 && Math.abs(s.top + 6 - t.top) < 2; })()`), stepTitle);
await ev(`document.querySelector('#tour .tour-next').click()`); await sleep(400);
check('third step spotlights the balance window', await ev(`document.querySelector('#tour-title').textContent === 'Balance of power'`), await ev(`document.querySelector('#tour-title').textContent`));
await ev(`document.querySelector('#tour .tour-back-btn').click()`); await sleep(400);
check('Back returns to the previous step', await ev(`document.querySelector('#tour-title').textContent === 'The status line'`));
await shot('tour.png');
await ev(`document.querySelector('#tour .tour-skip').click()`); await sleep(300);
check('Skip closes the tour', await ev(`!document.querySelector('#tour')`));

const visible = () => ev(`[...document.querySelectorAll('.win')].filter(w => !w.classList.contains('closed') && !w.classList.contains('offscreen')).map(w => w.dataset.win).join(',')`);
// workspace 1
check('ws1 windows', (await visible()) === 'balance-1,map-1,stream-1,feed-1,news-1', await visible());
check('simulation banner shown', await ev(`getComputedStyle(document.querySelector('.sim-banner')).display !== 'none'`));
check('balance: three chambers with seat segments', await waitFor(`document.querySelectorAll('[data-win="balance-1"] .bop-row').length === 3 && document.querySelectorAll('[data-win="balance-1"] .seatbar .seg:not(.none)').length > 6`));
check('map: 50 states drawn, some coloured by result', await waitFor(`(() => { const p = [...document.querySelectorAll('[data-win="map-1"] path.area')]; return p.length === 50 && p.filter(x => /^#|url\\(/.test(x.getAttribute('fill'))).length > 10; })()`), await ev(`document.querySelectorAll('[data-win="map-1"] path.area').length`));
check('feed: simulated events listed', await waitFor(`document.querySelectorAll('[data-win="feed-1"] .ev').length > 20`), await ev(`document.querySelectorAll('[data-win="feed-1"] .ev').length`));
check('news: articles listed', await waitFor(`document.querySelectorAll('[data-win="news-1"] .news-item').length > 10`, 30000), await ev(`document.querySelectorAll('[data-win="news-1"] .news-item').length`));
check('stream: iframe pointed at a YouTube embed', await ev(`/youtube\\.com\\/embed\\//.test(document.querySelector('[data-win="stream-1"] iframe').src)`), await ev(`document.querySelector('[data-win="stream-1"] iframe').src`));
check('sources ribbon sits right under the timeline; disclaimer footer at the bottom', await ev(`(() => { const s = document.querySelector('#credits-sources'), d = document.querySelector('#disclaimer'); const t = document.querySelector('#transport').getBoundingClientRect(), sr = s.getBoundingClientRect(); return /CNN/.test(s.textContent) && Math.abs(sr.top - t.bottom) <= 1 && /non-partisan/.test(d.textContent) && /endorses no candidate/.test(d.title) && d.getBoundingClientRect().bottom <= innerHeight; })()`));
check('bar status shows simulation clock', await ev(`/SIMULATION/.test(document.querySelector('#status').textContent)`), await ev(`document.querySelector('#status').textContent`));
check('site notice banner hidden while config/notice.json is disabled', await ev(`document.querySelector('#notice-banner').hidden`));
await shot('ws1.png');

// reader window: open the first headline, expect extracted text or a clear failure note, then Esc
await ev(`document.querySelector('[data-win="news-1"] .news-item a.t').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))`);
check('reader opens', await waitFor(`!document.querySelector('#reader').hidden`, 3000));
check('reader shows article content or a failure note', await waitFor(`document.querySelector('#reader-msg').textContent === '' && !!document.querySelector('#reader-frame').srcdoc && /<h1>/.test(document.querySelector('#reader-frame').srcdoc) || !!document.querySelector('#reader-frame').getAttribute('src')`, 25000), await ev(`document.querySelector('#reader-src').textContent.slice(0, 80)`));
await shot('reader.png');
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300);
check('Esc closes the reader', await ev(`document.querySelector('#reader').hidden`));

// click a state on the map -> race card opens (floating) with that race
await ev(`(() => { const p = [...document.querySelectorAll('[data-win="map-1"] path.area')].find(x => x.__data__?.st === 'TX'); p.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()`);
await sleep(900);
check('clicking Texas selects S-TX in the race card', await ev(`(() => { const rc = [...document.querySelectorAll('.win:not(.offscreen) .race-card h3')].map(h => h.textContent); return rc.some(t => /Texas Senate/.test(t)); })()`), await ev(`[...document.querySelectorAll('.race-card h3')].map(h=>h.textContent).join('|')`));

// workspace 2
await ev(`wm.workspace(2)`); await sleep(1200);
check('ws2 windows', (await visible()).split(',').sort().join(',') === 'chamber-1,chamber-2,race-1,races-1', await visible());
check('Senate hemicycle has 100 seats', await ev(`document.querySelectorAll('[data-win="chamber-1"] circle.seat').length === 100`), await ev(`document.querySelectorAll('[data-win="chamber-1"] circle.seat').length`));
check('House hemicycle has 435 seats', await ev(`document.querySelectorAll('[data-win="chamber-2"] circle.seat').length === 435`), await ev(`document.querySelectorAll('[data-win="chamber-2"] circle.seat').length`));
check('race browser lists 35 Senate races', await ev(`document.querySelectorAll('[data-win="races-1"] tbody tr').length === 35`), await ev(`document.querySelectorAll('[data-win="races-1"] tbody tr').length`));
check('race card shows Texas candidates', await ev(`document.querySelectorAll('[data-win="race-1"] .cand').length >= 2`));
await shot('ws2.png');

// workspace 3
await ev(`wm.workspace(3)`); await sleep(1200);
check('ws3 windows', (await visible()).split(',').sort().join(',') === 'markets-1,social-1,social-2,timeline-1', await visible());
check('analysts feed has posts', await waitFor(`document.querySelectorAll('[data-win="social-1"] .post').length > 5`, 30000), await ev(`document.querySelectorAll('[data-win="social-1"] .post').length`));
check('Trump feed has posts', await waitFor(`document.querySelectorAll('[data-win="social-2"] .post').length > 5`, 30000), await ev(`document.querySelectorAll('[data-win="social-2"] .post').length`));
check('markets show Senate and House control', await waitFor(`document.querySelectorAll('[data-win="markets-1"] .mk-big').length === 2`, 30000));
check('markets show the Israel and Israel/Palestine questions', await waitFor(`document.querySelectorAll('[data-win="markets-1"] .mk-topic').length === 2 && /Prime Minister of Israel/.test(document.querySelector('[data-win="markets-1"]').textContent)`, 30000), await ev(`document.querySelectorAll('[data-win="markets-1"] .tp-ev').length + ' questions'`));
check('timeline lists poll closings', await ev(`document.querySelectorAll('[data-win="timeline-1"] .tl-list li').length >= 9`), await ev(`document.querySelectorAll('[data-win="timeline-1"] .tl-list li').length`));
await shot('ws3.png');

// workspace 4: House district map
await ev(`wm.workspace(4)`); await sleep(1500);
check('House map draws 435 districts', await waitFor(`document.querySelectorAll('[data-win="map-2"] path.area').length === 435`), await ev(`document.querySelectorAll('[data-win="map-2"] path.area').length`));
await shot('ws4.png');

// workspace 5: stock market
await ev(`wm.workspace(5)`); await sleep(1200);
check('ws5 windows', (await visible()).split(',').sort().join(',') === 'stocks-1,stocks-2', await visible());
check('stocks overview: 8 headline tiles with prices', await waitFor(`(() => { const t = [...document.querySelectorAll('[data-win="stocks-1"] .stk-hero .stk-tile .stk-price')]; return t.length === 8 && t.every(x => /[0-9]/.test(x.textContent)); })()`, 30000), await ev(`document.querySelectorAll('[data-win="stocks-1"] .stk-hero .stk-tile').length`));
check('stocks overview: heatmap of 27 stocks and the movers lists', await ev(`document.querySelectorAll('[data-win="stocks-1"] .stk-heat')[0].querySelectorAll('.cell').length === 27 && document.querySelectorAll('[data-win="stocks-1"] .stk-movers li').length === 10`));
check('stocks overview: 12 currencies against the dollar', await ev(`(() => { const h = document.querySelectorAll('[data-win="stocks-1"] .stk-heat')[1]; return !!h && [...h.querySelectorAll('.cell b')].map(b => b.textContent).join(',') === 'EUR,GBP,CAD,JPY,CNY,CNH,MXN,CHF,AUD,INR,KRW,BRL'; })()`));
check('every change carries an arrow and a sign (not colour alone)', await ev(`[...document.querySelectorAll('[data-win="stocks-1"] .stk-chg')].every(x => /[▲▼■]/.test(x.textContent))`));
check('futures as small multiples: 4 charts with lines', await waitFor(`document.querySelectorAll('[data-win="stocks-2"] .stk-mult figure').length === 4 && [...document.querySelectorAll('[data-win="stocks-2"] .stk-mult path')].some(p => (p.getAttribute('d') || '').length > 20)`, 30000));
for (const [mode, sel, n] of [['table', '.stk-table tbody tr', 4], ['tiles', '.stk-grid .stk-tile', 4], ['heatmap', '.stk-heat .cell', 4]]) {
  await ev(`document.querySelector('[data-win="stocks-2"] [data-display="${mode}"]').click()`); await sleep(400);
  check(`stocks ${mode} layout`, await ev(`document.querySelectorAll('[data-win="stocks-2"] ${sel}').length === ${n}`), await ev(`document.querySelectorAll('[data-win="stocks-2"] ${sel}').length`));
}
await shot('ws5-stocks.png');

// settings change via popover: switch map-2 to ratings mode
await ev(`document.querySelector('[data-win="map-2"] .gear').click()`); await sleep(300);
await ev(`(() => { const s = document.querySelector('#popover select[data-key="mode"]'); s.value = JSON.stringify('rating'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(800);
check('settings popover switched map to ratings', await ev(`(() => { const ok = JSON.parse(localStorage.getItem('us-dash-layout-v1')).inst['map-2'].settings.mode === 'rating'; return ok; })()`));
await ev(`document.querySelector('#popover').hidden = true`);

// launcher: open a new stream window
await ev(`wm.launcher(true)`); await sleep(200);
await ev(`(() => { const i = document.querySelector('#launcher-input'); i.value = 'live stream'; i.dispatchEvent(new Event('input')); })()`); await sleep(200);
const items = await ev(`[...document.querySelectorAll('#launcher-list li[data-i]')].map(l => l.textContent.trim()).join(' | ')`);
await ev(`document.querySelector('#launcher-list li[data-i]').click()`); await sleep(900);
check('launcher created stream-2', await ev(`!!document.querySelector('[data-win="stream-2"]')`), items);

// light mode: the bar button flips data-theme, the choice survives a reload, and the favicon is served
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
check('dark mode is the default', await ev(`!document.documentElement.dataset.theme && document.querySelector('#bar-theme').getAttribute('aria-pressed') === 'false'`));
await ev(`document.querySelector('#bar-theme').click()`); await sleep(300);
check('theme button switches to light mode', await ev(`document.documentElement.dataset.theme === 'light' && localStorage.getItem('us-dash-theme') === 'light' && getComputedStyle(document.body).backgroundColor === 'rgb(233, 236, 241)'`), await ev(`getComputedStyle(document.body).backgroundColor`));
await shot('ws1-light.png');
await ev(`wm.workspace(2)`); await sleep(1200); await shot('ws2-light.png');
await ev(`wm.workspace(3)`); await sleep(1200); await shot('ws3-light.png');
await ev(`wm.workspace(1)`); await sleep(1200);
check('favicon.svg is served as SVG', await ev(`fetch('/favicon.svg').then(r => r.ok && /svg/.test(r.headers.get('content-type')) && r.text()).then(t => /<path fill="#3A7BE0"/.test(t) && /<path fill="#E0453A"/.test(t))`));

// share link round trip
const link = await ev(`(async () => { const m = await import('/js/layout.js'); return m.shareLink(); })()`);
check('share link generated', typeof link === 'string' && /#l=z/.test(link), String(link).slice(0, 80) + '…');
await send('Page.navigate', { url: link.replace(/\?[^#]*/, '?sim=1&simAt=' + simAt) });
await waitFor(`document.querySelectorAll('.win').length > 10`); await sleep(2500);
check('tour does not return on a later visit', !(await ev(`!!document.querySelector('#tour')`)));
check('shared link restores the new stream window', await ev(`!!document.querySelector('[data-win="stream-2"]')`));
check('light mode survives a reload', await ev(`document.documentElement.dataset.theme === 'light' && document.querySelector('#bar-theme').textContent === '☀'`));
await ev(`document.querySelector('#bar-theme').click()`); await sleep(200);
check('theme button switches back to dark', await ev(`!document.documentElement.dataset.theme && localStorage.getItem('us-dash-theme') === 'dark'`));
check('shared link restores the ratings map setting', await ev(`JSON.parse(localStorage.getItem('us-dash-layout-v1')).inst['map-2'].settings.mode === 'rating'`));

// phone width
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await ev(`wm.workspace(1)`); await sleep(1200);
check('phone: no horizontal scroll', await ev(`document.documentElement.scrollWidth <= innerWidth + 1`), await ev(`document.documentElement.scrollWidth`));
await shot('phone.png');

const real = errs.filter((e) => !/favicon|ERR_BLOCKED_BY|youtube|ytimg|net::ERR_ABORTED/.test(e));
check('no uncaught errors', real.length === 0, real.slice(0, 8).join('\n      '));
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
sock.close(); chrome.kill();
process.exit(fails ? 1 : 0);
