// Usage: node tests/timeline.browser.mjs <scratch-dir> [base-url]   (needs chromium on PATH)
// The scrubber, in simulation mode with a pinned clock (deterministic): scrubbing to a moment
// must show exactly what the server's simulation shows for that minute.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [out, base = 'http://localhost:8787'] = process.argv.slice(2);
const SIM_AT = 300; // sim clock pinned at 17:45 ET + 300 min = 22:45 ET
const NIGHT_START = Date.parse('2026-11-03T22:45:00Z');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(`${out}/tl-profile`, { recursive: true, force: true });
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9340', `--user-data-dir=${out}/tl-profile`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 40 && !ws; i++) { await sleep(250); try { ws = (await (await fetch('http://127.0.0.1:9340/json')).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map(); const errs = [];
sock.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.split('\n').slice(0, 2).join(' '));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { __error: r.result.exceptionDetails.exception?.description } : r.result?.result?.value; };
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}/${n}`, Buffer.from(r.result.data, 'base64')); };
const key = async (k, code, shift = false) => { for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, text: type === 'rawKeyDown' ? k : undefined, modifiers: shift ? 8 : 0, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }); await sleep(500); };
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== '' ? '  ' + extra : ''}`); };
const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await sleep(250); } return false; };
const mods = `const C = await import('/js/clock.js'); const T = await import('/js/timeline.js'); const H = await import('/js/core.js');`;

await send('Runtime.enable');
await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('us-dash-tour-v1', '1'); } catch {}` }); // no first-visit tour over the test
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${base}/?sim=1&simAt=${SIM_AT}` });
check('transport strip appears once the timeline loads', await waitFor(`!document.querySelector('#transport').hidden`, 30000));
await sleep(2500);
check('starts live', await ev(`document.querySelector('.tl-live').classList.contains('on') && !document.body.classList.contains('replay')`));
check('timeline spans the recorded night', await ev(`(async () => { ${mods} return T.default.from === ${NIGHT_START} && T.default.to === ${NIGHT_START + SIM_AT * 60e3}; })()`), await ev(`(async () => { ${mods} return [new Date(T.default.from).toISOString(), new Date(T.default.to).toISOString()].join(' → '); })()`));

// scrub to 19:51 ET (sim minute 126, a 3-minute step boundary) by clicking the track
const target = NIGHT_START + 126 * 60e3;
const x = await ev(`(() => { const r = document.querySelector('.tl-track').getBoundingClientRect(); return r.left + r.width * ${126 / SIM_AT}; })()`);
const y = await ev(`(() => { const r = document.querySelector('.tl-track').getBoundingClientRect(); return r.top + r.height / 2; })()`);
for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
await sleep(800);
check('clicking the track enters replay', await ev(`document.body.classList.contains('replay') && /Replay/.test(document.querySelector('.tl-time').textContent)`), await ev(`document.querySelector('.tl-time').textContent`));
const t = await ev(`(async () => { ${mods} return C.clock.t; })()`);
check('the clock lands where the track was clicked (±2 min)', Math.abs(t - target) < 120e3, new Date(t).toISOString());
// pin it exactly on the step, then compare with the server's simulation for that minute
await ev(`(async () => { ${mods} C.clock.set(${target}); })()`); await sleep(800);
const replay = await ev(`(async () => { ${mods} const d = H.hub.get('results'); return { replay: d.replay, called: Object.values(d.races).filter(r => r.called).length, reporting: Object.keys(d.races).length, tx: d.races['S-TX'] ? d.races['S-TX'].candidates.map(c => c.name + ':' + c.votes).join(',') : null, ga: d.races['G-GA']?.totalVotes }; })()`);
const truth = await (await fetch(`${base}/api/results?sim=1&simAt=126`)).json();
const tc = Object.values(truth.races);
check('replay shows the same reporting races as the server at that minute', replay.reporting === tc.length, `${replay.reporting} vs ${tc.length}`);
check('replay shows the same called races', replay.called === tc.filter((r) => r.called).length, `${replay.called} vs ${tc.filter((r) => r.called).length}`);
check('replay shows identical Georgia governor vote totals', replay.ga === truth.races['G-GA']?.totalVotes, `${replay.ga} vs ${truth.races['G-GA']?.totalVotes}`);
check('status bar says REPLAY', await ev(`/REPLAY/.test(document.querySelector('#status').textContent)`), await ev(`document.querySelector('#status').textContent`));
check('feed shows no event after the replay moment', await ev(`(async () => { const items = [...document.querySelectorAll('[data-win="feed-1"] .ev .t')]; return items.length > 0; })()`) && await ev(`(async () => { ${mods} const T2 = T; return T2.eventsAt(${target}).every(e => e.t <= new Date(${target}).toISOString()); })()`));
const calledEarly = await ev(`document.querySelectorAll('[data-win="balance-1"] .seatbar .seg:not(.none):not(.hold)').length`);
await shot('replay-1951.png');

// share link carries the moment
const link = await ev(`(async () => { const m = await import('/js/layout.js'); return m.shareLink(); })()`);
const linkT = await ev(`(async () => { const s = ${JSON.stringify('')} + location.href; const h = ${'`'}${'$'}{'${link}'}${'`'}.split('#l=')[1]; const b = Uint8Array.from(atob(h.slice(1).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); const txt = await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text(); return JSON.parse(txt).t; })()`);
console.log('      link carries t =', linkT && new Date(linkT).toISOString());

// back to live with L
await key('l', 'KeyL'); await sleep(1500);
check('L goes back to live', await ev(`!document.body.classList.contains('replay') && document.querySelector('.tl-live').classList.contains('on')`));
check('live state has more called races than 7:51 pm', await ev(`(async () => { ${mods} return Object.values(H.hub.get('results').races).filter(r => r.called).length; })()`) > replay.called);

// keyboard step back from live: ',' goes one minute before the latest data
await key(',', 'Comma'); await sleep(600);
check(', steps back one minute into replay', await ev(`(async () => { ${mods} return C.clock.mode === 'replay' && Math.abs(C.clock.t - (T.default.to - 60e3)) < 2000; })()`));

// playback
await ev(`(async () => { ${mods} C.clock.set(${target}); C.clock.setSpeed(1200); C.clock.play(); })()`); await sleep(1500);
const t2 = await ev(`(async () => { ${mods} return C.clock.t; })()`);
check('play advances the clock at the chosen speed', t2 - target > 10 * 60e3, `${Math.round((t2 - target) / 60e3)} min in 1.5 s`);
await ev(`(async () => { ${mods} C.clock.pause(); C.clock.live(); })()`); await sleep(500); // leave replay, so the next check can only pass on the reloaded page

// open the share link: same moment
await send('Page.navigate', { url: link });
check('share link reopens in replay', await waitFor(`document.body.classList.contains('replay')`, 30000));
check('at the shared moment', await ev(`(async () => { ${mods} return Math.abs(C.clock.t - ${target}) < 1500; })()`), await ev(`(async () => { ${mods} return new Date(C.clock.t).toISOString(); })()`));
await shot('shared-moment.png');

// phone width
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); await sleep(800);
check('phone: strip fits, no horizontal scroll', await ev(`document.documentElement.scrollWidth <= innerWidth + 1`));
await shot('phone-transport.png');

check('no uncaught errors', errs.length === 0, errs.slice(0, 5).join(' | '));
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
sock.close(); chrome.kill(); process.exit(fails ? 1 : 0);
