// Usage: node tests/wm.browser.mjs <scratch-dir> [url]   (needs chromium on PATH)
// Drives the Hyprland-style window manager with real keyboard/mouse input via the DevTools protocol.
// Ported from the BC build: workspace 1 of the 'Election night' preset has the same tree shape
// (balance-1 = seats, map-1 = map, stream-1 = video, feed-1 = news, news-1 = x).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [out, url = 'http://localhost:8787/?sim=1&simAt=240'] = process.argv.slice(2);
fs.rmSync(`${out}/wm-profile`, { recursive: true, force: true });
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9337', `--user-data-dir=${out}/wm-profile`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 40 && !ws; i++) { await sleep(250); try { ws = (await (await fetch('http://127.0.0.1:9337/json')).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map(); const errs = [];
sock.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.split('\n').slice(0, 2).join(' ')); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}/${n}`, Buffer.from(r.result.data, 'base64')); };
const MOD = { alt: 1, ctrl: 2, shift: 8 };
const mods = (...m) => m.reduce((a, k) => a | MOD[k], 0);
const CODES = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
async function key(k, ...m) {
  const code = /^[0-9]$/.test(k) ? `Digit${k}` : /^[a-z]$/.test(k) ? `Key${k.toUpperCase()}` : k === '/' ? 'Slash' : k;
  const vk = CODES[k] || k.toUpperCase().charCodeAt(0);
  const mm = mods(...m);
  if (mm & 1) await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: mm });
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k.length === 1 ? k : k, code, windowsVirtualKeyCode: vk, modifiers: mm });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mm });
  if (mm & 1) await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18, modifiers: 0 });
  await sleep(650);
}
const mouse = (type, x, y, button = 'left', m = 0) => send('Input.dispatchMouseEvent', { type, x, y, button, buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1, clickCount: 1, modifiers: m });
async function drag(x, y, dx, dy, button = 'left', m = 0) {
  await mouse('mouseMoved', x, y, 'none', m); await mouse('mousePressed', x, y, button, m);
  for (let k = 1; k <= 10; k++) { await mouse('mouseMoved', x + (dx * k) / 10, y + (dy * k) / 10, button, m); await sleep(30); }
  await mouse('mouseReleased', x + dx, y + dy, button, m); await sleep(650);
}
const rect = (t) => ev(`(() => { const r = document.querySelector('.win[data-win="${t}"]').getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })()`);
const S = () => ev(`JSON.stringify({ active: wm.state().active, focus: wm.state().focus, ws1: (function l(n){return !n?[]:n.id?[n.id]:[...l(n.a),...l(n.b)]})(wm.state().ws[1]), ws2: (function l(n){return !n?[]:n.id?[n.id]:[...l(n.a),...l(n.b)]})(wm.state().ws[2]), float: Object.keys(wm.state().floating), special: (function l(n){return !n?[]:n.id?[n.id]:[...l(n.a),...l(n.b)]})(wm.state().special) })`);
const visibleWins = () => ev(`[...document.querySelectorAll('.win')].filter(w => !w.classList.contains('closed') && !w.classList.contains('offscreen')).map(w => w.dataset.win).join(',')`);
const check = (label, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);

await send('Runtime.enable');
await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('us-dash-tour-v1', '1'); } catch {}` }); // no first-visit tour over the test
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
const load = async () => { await send('Page.navigate', { url }); for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`!!window.wm && document.querySelectorAll('[data-win="map-1"] path.area').length > 0`)) break; } await sleep(900); };
await load();

// 1. default dwindle layout and Hyprland gaps
check('ws1 shows 5 windows', (await visibleWins()) === 'balance-1,map-1,stream-1,feed-1,news-1', await visibleWins());
const [m, v, n, x] = [await rect('map-1'), await rect('stream-1'), await rect('feed-1'), await rect('news-1')];
const barH = await ev(`document.getElementById('bar').offsetHeight`);
const deskBottom = await ev(`Math.round(document.getElementById('desktop').getBoundingClientRect().bottom)`); // the credits footer sits below the desktop
check('outer gap 20px', m[0] === 20 && v[0] + v[2] === 1900 && x[1] + x[3] === deskBottom - 20, JSON.stringify({ m, v, x, deskBottom }));
check('inner gap 10px', v[0] - (m[0] + m[2]) === 10 && n[1] - (v[1] + v[3]) === 10 && x[0] - (n[0] + n[2]) === 10);
check('active border is the gradient', (await ev(`getComputedStyle(document.querySelector('.win.active')).backgroundImage`)).includes('linear-gradient'));
await shot('wm-default.png');

// 2. focus follows mouse
await mouse('mouseMoved', n[0] + n[2] / 2, n[1] + n[3] / 2, 'none'); await sleep(200);
check('hover focuses feed', JSON.parse(await S()).focus === 'feed-1');

// 3. keyboard focus / swap / resize
await key('ArrowRight', 'alt');
check('Alt+→ focuses news', JSON.parse(await S()).focus === 'news-1', JSON.parse(await S()).focus);
await key('ArrowUp', 'alt');
check('Alt+↑ focuses stream', JSON.parse(await S()).focus === 'stream-1', JSON.parse(await S()).focus);
await key('ArrowLeft', 'alt', 'shift');
check('Alt+Shift+← swaps stream into the left column', (await rect('stream-1'))[0] === 20, JSON.stringify(await rect('stream-1')));
await key('ArrowLeft', 'alt', 'shift'); // no window to the left: no-op
const w0 = (await rect('stream-1'))[2];
await key('ArrowRight', 'alt', 'ctrl');
check('Alt+Ctrl+→ grows active width', (await rect('stream-1'))[2] > w0, `${w0} -> ${(await rect('stream-1'))[2]}`);

// 4. drag the gap between the two columns
const lw = (await rect('stream-1'))[2]; const gx = 20 + lw + 5;
await drag(gx, 540, 180, 0);
check('dragging the gap resizes the split', Math.abs((await rect('stream-1'))[2] - (lw + 180)) < 6, `${lw} -> ${(await rect('stream-1'))[2]}`);

// 5. Alt+LMB drag news onto the left half of balance -> re-tiles there
const xr = await rect('news-1'), sr = await rect('balance-1');
await drag(xr[0] + 40, xr[1] + 60, (sr[0] + 30) - (xr[0] + 40), (sr[1] + sr[3] / 2) - (xr[1] + 60), 'left', mods('alt'));
const xr2 = await rect('news-1'), sr2 = await rect('balance-1');
check('Alt+drag moves news next to balance (left side)', xr2[0] < sr2[0] && Math.abs(xr2[1] - sr2[1]) < 4, JSON.stringify({ xr2, sr2 }));

// 6. Alt+RMB resize from the bottom-right quadrant grows the window
const before = await rect('news-1');
await drag(before[0] + before[2] - 20, before[1] + before[3] - 10, 120, 0, 'right', mods('alt'));
check('Alt+RMB drag resizes', (await rect('news-1'))[2] > before[2] + 60, `${before[2]} -> ${(await rect('news-1'))[2]}`);

// 6b. plain title-bar drag (no modifier) moves a window; clicks and header controls don't
const tree = async () => ev(`JSON.stringify(wm.state().ws[1])`);
const t0 = await tree();
const hd = await ev(`(() => { const r = document.querySelector('.win[data-win="feed-1"] .panel-head h2').getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; })()`);
await mouse('mouseMoved', hd[0], hd[1], 'none'); await mouse('mousePressed', hd[0], hd[1]); await mouse('mouseReleased', hd[0], hd[1]); await sleep(500);
check('plain click on a title bar changes nothing', t0 === await tree());
const btn = await ev(`(() => { const r = document.querySelector('.win[data-win="stream-1"] .panel-head .gear').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
await drag(btn[0], btn[1], -400, 300);
check('dragging from a header button does not move the window', t0 === await tree());
await ev(`document.querySelector('#popover').hidden = true`);
const mr0 = await rect('map-1');
await drag(hd[0], hd[1], (mr0[0] + mr0[2] - 30) - hd[0], (mr0[1] + mr0[3] / 2) - hd[1]);
const nr2 = await rect('feed-1'), mr2 = await rect('map-1');
check('dragging the feed title bar onto the map\'s right half tiles it there', nr2[0] > mr2[0] && Math.abs(nr2[1] - mr2[1]) < 4 && t0 !== await tree(), JSON.stringify({ nr2, mr2 }));
check('cursor is grab on title bars', (await ev(`getComputedStyle(document.querySelector('.win[data-win="map-1"] .panel-head')).cursor`)) === 'grab');

// 6a. Hyprland drag: while a tiled window is dragged the others re-tile around the hole at once,
// the window under the pointer is marked as the drop target, and a drop on nothing restores the tree
{
  const allRects = () => ev(`Object.fromEntries([...document.querySelectorAll('.win:not(.closed):not(.offscreen)')].map(w => { const r = w.getBoundingClientRect(); return [w.dataset.win, [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]]; }))`);
  const t0 = await tree(), before = await allRects(), nr = before['news-1'];
  const hx = nr[0] + 40, hy = nr[1] + 12, px = hx - 480, py = hy + 320;
  await mouse('mouseMoved', hx, hy, 'none'); await mouse('mousePressed', hx, hy);
  for (let k = 1; k <= 8; k++) { await mouse('mouseMoved', hx + ((px - hx) * k) / 8, hy + ((py - hy) * k) / 8); await sleep(30); }
  await sleep(600);
  const mid = await allRects();
  const others = Object.keys(before).filter((id) => id !== 'news-1');
  check('mid-drag: the other windows re-tile around the hole', others.some((id) => JSON.stringify(mid[id]) !== JSON.stringify(before[id])), JSON.stringify({ before, mid }));
  check('mid-drag: dragged window stays visible and follows the pointer', await ev(`(() => { const w = document.querySelector('.win[data-win="news-1"]'); return !w.classList.contains('closed') && w.classList.contains('dragging'); })()`));
  const under = others.find((id) => { const r = mid[id]; return px >= r[0] && px < r[0] + r[2] && py >= r[1] && py < r[1] + r[3]; });
  check('mid-drag: window under the pointer is the drop target', !!under && (await ev(`document.querySelector('.win.drop-target')?.dataset.win`)) === under, `${under} vs ${await ev(`document.querySelector('.win.drop-target')?.dataset.win`)}`);
  await mouse('mouseMoved', 600, 5); await sleep(50); await mouse('mouseReleased', 600, 5); await sleep(700); // drop on the bar: nothing there
  check('drop on nothing restores the original layout', t0 === await tree() && JSON.stringify(await allRects()) === JSON.stringify(before));
  check('no drop-target left behind', !(await ev(`!!document.querySelector('.win.drop-target')`)));
}

// 7. workspaces
await key('2', 'alt');
check('Alt+2 shows seats, race card and browser', (await visibleWins()) === 'chamber-1,chamber-2,race-1,races-1' && JSON.parse(await S()).active === 2, await visibleWins());
await shot('wm-ws2.png');
await key('1', 'alt');
check('Alt+1 back', JSON.parse(await S()).active === 1);
await mouse('mouseMoved', 300, 700, 'none'); await sleep(200);
const f = JSON.parse(await S()).focus;
await key('6', 'alt', 'shift');
let st = JSON.parse(await S());
check(`Alt+Shift+6 moves ${f} to ws6 and follows`, st.active === 6 && (await visibleWins()) === f, JSON.stringify(st));
check('bar lists workspaces 1-6 and special', (await ev(`[...document.querySelectorAll('#workspaces button')].map(b=>b.textContent).join(',')`)) === '1,2,3,4,5,6,S', await ev(`[...document.querySelectorAll('#workspaces button')].map(b=>b.textContent).join(',')`));
await key('1', 'alt');

// 8. float, fullscreen, close, launcher
await mouse('mouseMoved', 1500, 300, 'none'); await sleep(200);
const ff = JSON.parse(await S()).focus;
await key('v', 'alt');
check(`Alt+V floats ${ff}`, JSON.parse(await S()).float.includes(ff));
await shot('wm-float.png');
await key('v', 'alt');
check('Alt+V again re-tiles', !JSON.parse(await S()).float.includes(ff));
await key('f', 'alt');
const fr = await rect(ff);
check('Alt+F fullscreen covers the viewport', fr[0] === 0 && fr[1] === 0 && fr[2] === 1920 && fr[3] === 1080, JSON.stringify(fr));
await key('f', 'alt');
await key('c', 'alt');
check(`Alt+C closes ${ff}`, !(await visibleWins()).split(',').includes(ff), await visibleWins());
await key('r', 'alt');
check('Alt+R opens the launcher', await ev(`!document.getElementById('launcher').hidden && document.activeElement.id === 'launcher-input'`));
const typeName = { balance: 'balance of power', map: 'results map', stream: 'live stream', feed: 'live feed', news: 'news' }[ff.split('-')[0]];
await ev(`(() => { const i = document.getElementById('launcher-input'); i.value = ${JSON.stringify('new ' + typeName)}; i.dispatchEvent(new Event('input')); })()`);
await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await sleep(900);
const reopened = JSON.parse(await S()).focus;
check(`launcher opens a new ${ff.split('-')[0]} window`, reopened && reopened.startsWith(ff.split('-')[0] + '-') && (await visibleWins()).split(',').includes(reopened), `${reopened} | ${await visibleWins()}`);
const ff2 = reopened;

// 9. special workspace
await key('s', 'alt', 'shift');
st = JSON.parse(await S());
check(`Alt+Shift+S sends ${ff2} to special and shows it`, st.special.includes(ff2) && await ev(`document.body.classList.contains('special-open')`));
await shot('wm-special.png');
await key('s', 'alt');
check('Alt+S hides special', !(await ev(`document.body.classList.contains('special-open')`)) && !(await visibleWins()).split(',').includes(ff2));

// 10. persistence + reset
const saved = await S(); await load();
check('layout survives reload', saved === await S());
await ev(`document.getElementById('bar-help').click()`); await sleep(200);
check('help overlay lists binds', (await ev(`document.querySelectorAll('#help-table tr').length`)) >= 15);
await ev(`document.getElementById('wm-reset').click()`); await sleep(700);
check('reset restores default', (await visibleWins()) === 'balance-1,map-1,stream-1,feed-1,news-1' && JSON.parse(await S()).special.join() === 'trends-1', await visibleWins());

// 11. phone width: panels stack, no horizontal scroll
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(800);
check('phone: panels stack', await ev(`(() => { const t = [...document.querySelectorAll('.win:not(.closed)')].map(w => w.getBoundingClientRect().top); return t.length === 18 && new Set(t.map(Math.round)).size === 18; })()`));
check('phone: no horizontal scroll', await ev(`document.documentElement.scrollWidth <= 420`));
await shot('wm-phone.png');
console.log('errors:', errs.length ? errs : 'none');
sock.close(); chrome.kill();
