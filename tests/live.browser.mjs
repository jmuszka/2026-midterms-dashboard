// Usage: node tests/live.browser.mjs <scratch-dir> <read-only-site-url> [--paused]
// Needs a running scraper writing to Supabase and a READ_ONLY=1 server. Checks that the page
// subscribes to the heartbeat over Realtime and refetches with the heartbeat version right
// after each insert. With --paused (scraper stopped 3+ minutes ago) checks the banner instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [out, url, mode] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
fs.rmSync(`${out}/live-profile`, { recursive: true, force: true });
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9339', `--user-data-dir=${out}/live-profile`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws; for (let i = 0; i < 40 && !ws; i++) { await sleep(250); try { ws = (await (await fetch('http://127.0.0.1:9339/json')).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map(); const requests = []; const errs = [];
sock.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); }
  if (d.method === 'Network.requestWillBeSent') requests.push({ t: Date.now(), url: d.params.request.url });
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.split('\n')[0]);
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== '' ? '  ' + extra : ''}`); };
const waitFor = async (expr, ms) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await sleep(250); } return false; };

await send('Runtime.enable'); await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
await waitFor(`document.querySelectorAll('.win').length > 5`, 20000);

if (mode === '--paused') {
  check('paused banner shown', await waitFor(`!document.querySelector('#paused-banner').hidden`, 35000), await ev(`document.querySelector('#paused-banner').textContent`));
  check('no simulation banner on the live site', await ev(`getComputedStyle(document.querySelector('.sim-banner')).display === 'none'`));
  const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}/paused.png`, Buffer.from(r.result.data, 'base64'));
} else {
  check('Realtime subscribed to the heartbeat', await waitFor(`document.body.dataset.realtime === 'on'`, 20000), await ev(`document.body.dataset.realtime`));
  check('paused banner hidden while the scraper runs', await ev(`document.querySelector('#paused-banner').hidden`));
  const before = requests.length;
  const nudged = await (async () => { for (let t = 0; t < 80000; t += 500) { if (requests.slice(before).some((r) => /\/api\/results\?v=\d+/.test(r.url))) return true; await sleep(500); } return false; })();
  check('a heartbeat triggers a versioned refetch of results', nudged, requests.slice(before).filter((r) => /v=/.test(r.url)).map((r) => r.url.replace(/^https?:\/\/[^/]+/, '')).slice(0, 4).join(' '));
  const vs = requests.slice(before).map((r) => r.url.match(/[?&]v=(\d+)/)?.[1]).filter(Boolean);
  check('heartbeats arrive over Realtime', +(await ev(`document.body.dataset.beats || 0`)) > 0, `${await ev(`document.body.dataset.beats`)} received`);
  check('all windows share one version per heartbeat (CDN-friendly)', vs.length > 0 && new Set(vs).size <= Math.ceil(vs.length / 2), JSON.stringify([...new Set(vs)]));
}
check('no uncaught errors', errs.length === 0, errs.join(' | '));
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
sock.close(); chrome.kill(); process.exit(fails ? 1 : 0);
