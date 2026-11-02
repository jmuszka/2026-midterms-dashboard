// Usage: node tests/rehearsal.browser.mjs <scratch-dir> <site-url> [minutes to sample, default 8]
// Run against scripts/rehearse.mjs (a replayed past election). While the night runs it samples
// /api/results every 15 s; then it checks, for every sample and every race, that the timeline
// replayed at that moment gives exactly the same votes and calls (the recording path: scraper ->
// store -> /api/timeline -> the browser), and that county tables are recorded and replay.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [out, url, mins = 8] = process.argv.slice(2);
const base = url.replace(/\/$/, '');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (label, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra !== '' ? '  ' + extra : ''}`); };
const get = async (p) => (await fetch(base + p)).json();

// 1. sample the live results while the night runs
const samples = [];
const seen = new Set();
const until = Date.now() + mins * 60e3;
console.log(`sampling /api/results for ${mins} min…`);
while (Date.now() < until) {
  const d = await get('/api/results');
  if (d.ranAt && !seen.has(d.ranAt)) {
    seen.add(d.ranAt);
    samples.push({ t: d.ranAt, races: Object.fromEntries(Object.entries(d.races).map(([id, r]) => [id, { called: !!r.called, winner: r.called ? r.winner : null, votes: Object.fromEntries(r.candidates.map((c) => [c.name, c.votes])) }])) });
    const rs = Object.values(d.races);
    console.log(`  ${d.ranAt.slice(11, 19)}  reporting ${rs.filter((r) => r.totalVotes > 0).length}  called ${rs.filter((r) => r.called).length}`);
  }
  await sleep(15e3);
}
const first = samples[0], last = samples[samples.length - 1];
const tot = (s, id) => Object.values(s.races[id]?.votes || {}).reduce((a, b) => a + b, 0);
check('several distinct results snapshots sampled', samples.length >= 4, samples.length);
check('reporting races grew during the night', Object.keys(last.races).filter((id) => tot(last, id) > 0).length > Object.keys(first.races).filter((id) => tot(first, id) > 0).length);
check('calls arrived', Object.values(last.races).filter((r) => r.called).length > Object.values(first.races).filter((r) => r.called).length, Object.values(last.races).filter((r) => r.called).length);
let shrank = 0;
for (let i = 1; i < samples.length; i++) for (const id of Object.keys(samples[i].races)) if (tot(samples[i], id) < tot(samples[i - 1], id)) shrank++;
check('no race total ever went down between samples', shrank === 0, shrank);
const ev = await get('/api/events?since=0');
check('race_called events recorded', (ev.events || []).some((e) => e.type === 'race_called'), (ev.events || []).length + ' events');

// 2. the browser rebuilds every sampled moment from the timeline
fs.rmSync(`${out}/rehearsal-profile`, { recursive: true, force: true });
const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9343', `--user-data-dir=${out}/rehearsal-profile`, 'about:blank'], { stdio: 'ignore' });
let ws; for (let i = 0; i < 40 && !ws; i++) { await sleep(250); try { ws = (await (await fetch('http://127.0.0.1:9343/json')).json()).find((x) => x.type === 'page')?.webSocketDebuggerUrl; } catch {} }
const sock = new WebSocket(ws); await new Promise((r) => sock.addEventListener('open', r));
let id = 0; const pending = new Map(); const errs = [];
sock.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id) { pending.get(d.id)?.(d); pending.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description?.split('\n')[0]); });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
const evj = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${out}/${n}`, Buffer.from(r.result.data, 'base64')); };
await send('Runtime.enable'); await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem('us-dash-tour-v1', '1'); } catch {}` });
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: base + '/' });
const mods = `const T = await import('/js/timeline.js'); const C = await import('/js/clock.js');`;
for (let i = 0; i < 120; i++) { if (await evj(`(async () => { ${mods} return T.default.loaded && T.default.to >= ${Date.parse(last.t)}; })()`)) break; await sleep(500); }
check('timeline loaded and reaches the last sample', await evj(`(async () => { ${mods} return T.default.loaded && T.default.to >= ${Date.parse(last.t)}; })()`), await evj(`(async () => { ${mods} return T.default.error || new Date(T.default.to).toISOString(); })()`));
await shot('rehearsal-live.png');

let raceChecks = 0, mismatches = [];
for (const s of samples) {
  const rep = await evj(`(async () => { ${mods} const d = T.resultsAt(${Date.parse(s.t) + 500}); return Object.fromEntries(Object.entries(d.races).map(([id, r]) => [id, { called: !!r.called, winner: r.called ? r.winner : null, votes: Object.fromEntries(r.candidates.map((c) => [c.name, c.votes])) }])); })()`);
  for (const [rid, want] of Object.entries(s.races)) {
    const got = rep?.[rid];
    const wantVotes = Object.values(want.votes).some((v) => v > 0);
    if (!wantVotes && !want.called && !got) continue; // nothing counted yet: no row recorded is right
    raceChecks++;
    const same = got && got.called === want.called && got.winner === want.winner && Object.entries(want.votes).every(([n, v]) => (got.votes[n] || 0) === v);
    if (!same) mismatches.push(`${s.t.slice(11, 19)} ${rid}: live ${JSON.stringify(want).slice(0, 120)} vs replay ${JSON.stringify(got).slice(0, 120)}`);
  }
}
check(`replay equals live at every sampled moment (${samples.length} moments, ${raceChecks} race states)`, mismatches.length === 0, mismatches.slice(0, 3).join('\n        '));

// 3. county tables: recorded live, and the table in force at a mid-night moment in replay
const statewide = Object.keys(last.races).filter((rid) => !rid.startsWith('H') && tot(last, rid) > 0).slice(0, 3);
const mid = samples[Math.floor(samples.length / 2)];
for (const rid of statewide) {
  const live = await get(`/api/counties?race=${rid}`);
  const sum = (d) => (d.counties || []).reduce((a, c) => a + c.total, 0);
  check(`${rid}: live county table recorded`, live.counties?.length > 0 && !!live.t, `${live.counties?.length} counties, as of ${live.t?.slice(11, 19)}`);
  const at = await get(`/api/counties?race=${rid}&at=${encodeURIComponent(mid.t)}`);
  if (tot(mid, rid) > 0 && at.counties?.length) check(`${rid}: replayed county table is from before the moment and smaller than the latest`, Date.parse(at.t) <= Date.parse(mid.t) && sum(at) <= sum(live), `${sum(at)} ≤ ${sum(live)} votes`);
}
let cardRace = null; // a race whose county table was already recorded at that moment (tables trail counts by up to a minute)
for (const rid of Object.keys(mid.races).filter((r) => !r.startsWith('H') && tot(mid, r) > 0)) {
  if ((await get(`/api/counties?race=${rid}&at=${encodeURIComponent(mid.t)}`)).counties?.length) { cardRace = rid; break; }
}
if (cardRace) {
  await evj(`(async () => { const core = await import('/js/core.js'); const L = await import('/js/layout.js'); core.selection.set('${cardRace}'); if (!document.querySelector('[data-type="race"]')) L.create('race', {}); })()`);
  await evj(`(async () => { ${mods} C.clock.set(${Date.parse(mid.t) + 500}); })()`);
  let txt = '';
  for (let i = 0; i < 20; i++) { await sleep(500); txt = await evj(`document.querySelector('[data-type="race"]')?.textContent || ''`); if (/Counties/.test(txt)) break; }
  check('race card in replay shows the county table with its time', /Counties\s*\d+\s*· as of/.test(txt), txt.match(/Counties[^A-Z]{0,40}/)?.[0] || txt.slice(0, 80));
  await shot('rehearsal-replay.png');
}
check('no uncaught errors in the page', errs.length === 0, errs.slice(0, 3).join(' | '));
chrome.kill();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
