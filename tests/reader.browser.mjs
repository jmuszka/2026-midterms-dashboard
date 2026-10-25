import { spawn } from 'node:child_process';
import fs from 'node:fs';
// Usage: node tests/reader.browser.mjs <scratch-dir> [url]   (needs chromium on PATH)
const out = process.argv[2];
const url = process.argv[3] || 'http://localhost:8787/';
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9333', '--window-size=1920,1080', `--user-data-dir=${out}/reader-profile`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 40 && !ws; i++) { await sleep(250); try { const t = await (await fetch('http://127.0.0.1:9333/json')).json(); const p = t.find((x) => x.type === 'page'); if (p) ws = p.webSocketDebuggerUrl; } catch {} }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map(); const logs = [];
sock.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') logs.push(d.params.exceptionDetails.exception?.description); if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push(d.params.args.map((a) => a.value ?? a.description).join(' ')); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}/${name}`, Buffer.from(r.result.data, 'base64')); };
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(`document.querySelectorAll('.news-item a.t').length`) > 0) break; }
// click the 3rd headline the way a user would
await ev(`document.querySelectorAll('.news-item a.t')[2].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, button:0}))`);
for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(`document.getElementById('reader-msg').innerHTML === ''`)) break; }
await sleep(1500);
console.log('reader open:', await ev(`!document.getElementById('reader').hidden`), '| title:', await ev(`document.getElementById('reader-src').textContent`));
console.log('srcdoc length:', await ev(`(document.getElementById('reader-frame').srcdoc||'').length`), '| mode toggle visible:', await ev(`!document.getElementById('reader-mode').hidden`));
await shot('reader1.png');
await ev(`document.getElementById('reader-next').click()`);
for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(`document.getElementById('reader-msg').innerHTML === ''`)) break; }
console.log('after next:', await ev(`document.getElementById('reader-src').textContent`));
await ev(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))`);
console.log('closed by Esc:', await ev(`document.getElementById('reader').hidden`));
console.log('errors:', logs.length ? logs : 'none');
sock.close(); chrome.kill();
