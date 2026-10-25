// Usage: node tests/streamsync.browser.mjs <scratch-dir> <read-only-site-url>
// Stream windows follow the timeline, on real recorded data (scraper running, READ_ONLY site).
// Headless Chromium cannot play YouTube, so the check reads the sync target each stream window
// publishes (data-sync-video / -pos / -mode on .video-box) and which player is showing.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [out, url] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
fs.rmSync(`${out}/ss-profile`, { recursive: true, force: true });
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=9342', `--user-data-dir=${out}/ss-profile`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 40 && !ws; i++) { await sleep(250); try { ws = (await (await fetch('http://127.0.0.1:9342/json')).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map(); const errs = [];
sock.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.split('\n')[0]); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== '' ? '  ' + extra : ''}`); };
const waitFor = async (expr, ms = 20000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await sleep(250); } return false; };
const mods = `const C = await import('/js/clock.js'); const T = await import('/js/timeline.js');`;
const box = `document.querySelector('[data-win="stream-1"] .video-box')`;
const state = () => ev(`(() => { const b = ${box}; const f = b.querySelector(':scope > iframe'); return { liveShown: !f.hidden, liveSrc: f.src, player: !b.querySelector('.replay-player').hidden, note: b.querySelector('.replay-note').hidden ? null : b.querySelector('.replay-note').textContent, ...b.dataset }; })()`);
const pick = (sourceId) => ev(`(() => { const s = document.querySelector('[data-win="stream-1"] .pick'); s.value = '${sourceId}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);

await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await waitFor(`!document.querySelector('#transport').hidden && !!${box}`, 30000);
await pick('nbc'); await sleep(1500);

let st = await state();
check('live timeline: the live stream is shown', st.liveShown && /youtube\.com\/embed\//.test(st.liveSrc) && !st.player, st.liveSrc);

// one hour back (or as far back as the record goes)
const back = await ev(`(async () => { ${mods} const t = Math.max(T.default.from + 60e3, T.default.to - 3600e3); C.clock.set(t); return T.default.to - t; })()`);
await waitFor(`${box}.dataset.syncVideo === 'aF9neWULq64'`, 15000);
st = await state();
check('replay: NBC is replayed from its recorded live video', st.syncVideo === 'aF9neWULq64' && st.player && !st.liveShown, JSON.stringify(st));
check('replay: positioned behind the live edge by the scrub distance', st.syncMode === 'edge', `mode ${st.syncMode}, pos ${st.syncPos}s, scrubbed back ${Math.round(back / 1000)}s`);
check('replay: the live embed is stopped (one audio track)', st.liveSrc === 'about:blank');
check('window title says replay', /replay/i.test(await ev(`document.querySelector('[data-win="stream-1"] h2').textContent`)));

// a channel that cannot be rewound while live
await pick('sky'); await sleep(1200);
st = await state();
check('replay: Sky (no DVR) says it cannot be rewound', st.syncMode === 'no-dvr' && /cannot be rewound/.test(st.note || ''), st.note);

// a moment before recording began
await pick('nbc');
await ev(`(async () => { ${mods} C.clock.set(T.default.from - 3600e3); })()`); await sleep(1200);
st = await state();
check('replay: before the recording began, the window says so', st.syncMode === 'before-recording' && !!st.note, st.note);

// back to live
await ev(`(async () => { ${mods} C.clock.live(); })()`); await sleep(1500);
st = await state();
check('back to live: the live embed returns, replay player hidden', st.liveShown && /youtube\.com\/embed\//.test(st.liveSrc) && !st.player && !st.note, st.liveSrc);

check('no uncaught errors', errs.length === 0, errs.join(' | '));
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
sock.close(); chrome.kill(); process.exit(fails ? 1 : 0);
