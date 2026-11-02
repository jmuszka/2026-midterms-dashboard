#!/usr/bin/env node
// Election-night rehearsal: replays a real past election through the real pipeline, compressed
// into a few minutes, so vote counts, calls, county tables and the timeline can be checked end to
// end before Nov 3. A local fake of politics.api.cnn.io serves CNN's own final files (Senate 2020:
// the same seats as 2026; governors 2022: the same 36 states; House 2024) rewritten as 2026, with
// every count growing from zero as each state's polls "close", lead swings along the way, AP calls
// arriving as races settle, and county files growing in step.
//
//   node scripts/rehearse.mjs                          # in-memory store, one process: site at http://localhost:8791
//   node scripts/rehearse.mjs --env .env.rehearsal     # a THROWAWAY Supabase project: the real scraper writes it,
//                                                      # a read-only site reads it (never the production project)
//   --minutes 20   length of the compressed night (polls close over the first 40%, counting runs to 90%)
//   --port 8791    site port (the fake CNN listens on port + 8)
// Then: node tests/rehearsal.browser.mjs .cache/browser http://localhost:8791
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const MINUTES = +opt('--minutes', 20);
const PORT = +opt('--port', 8791), CNN_PORT = PORT + 8;
const ENV = opt('--env', null);
const CACHE = path.join(ROOT, '.cache', 'rehearsal');
const SOURCE = { SG: '2020-SG', GG: '2022-GG', HG: '2024-HG' }; // 2026 contest -> past file
const UPSTREAM = 'https://politics.api.cnn.io/results';
const log = (...a) => console.log(new Date().toLocaleTimeString('en-US', { hour12: false }), ...a);
fs.mkdirSync(CACHE, { recursive: true });

async function cached(name, url) {
  const file = path.join(CACHE, `${name}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (rehearsal)' } });
  if (!res.ok) { const e = new Error(`${res.status} ${url}`); e.status = res.status; throw e; }
  const text = await res.text();
  fs.writeFileSync(file, text);
  return JSON.parse(text);
}

/* ---------------- the compressed night ---------------- */
const T0 = Date.now(), D = MINUTES * 60e3;
const races = require('../config/races.json').races;
const closeOf = Object.fromEntries(races.map((r) => [r.id.split('-')[1], r.close]));
const minsAfter6 = (hhmm) => { const [h, m] = (hhmm || '20:00').split(':').map(Number); return ((h < 12 ? h + 24 : h) - 18) * 60 + m; };
const closes = Object.values(closeOf).map(minsAfter6);
const [cMin, cMax] = [Math.min(...closes), Math.max(...closes)];
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return ((h >>> 0) % 10000) / 10000; };
// progress 0..1 of one race: starts when its state's polls close (first 40% of the night), counts over 30–50%
function progress(key, st, now = Date.now()) {
  const start = 0.4 * (minsAfter6(closeOf[st]) - cMin) / Math.max(1, cMax - cMin);
  const span = 0.3 + 0.2 * hash(`${key}span`);
  return Math.max(0, Math.min(1, ((now - T0) / D - start) / span));
}
// early returns lean one way (a "red/blue shift"), so leads change as the count goes on
const share = (key, party, p) => { const s = (hash(key) - 0.5) * 0.8; const e = party === 'DEM' ? 1 + s : party === 'REP' ? 1 - s : 1; return Math.min(1, Math.pow(p, e)); };

function replayRace(r, now) {
  const contest = r.contestType;
  const st = r.stateAbbreviation;
  const key = r.ecKey.replace(/^\d{4}/, '2026');
  const p = progress(key, st, now);
  const fin = r.candidates.map((c) => c.voteNum || 0);
  const total = fin.reduce((s, v) => s + v, 0) || 1;
  const sorted = [...fin].sort((a, b) => b - a);
  const margin = (sorted[0] - (sorted[1] || 0)) / total;
  const callAt = margin > 0.2 ? 0.03 : margin > 0.08 ? 0.5 : margin > 0.02 ? 0.85 : 1;
  const called = (r.editorialStatus === 'called' || r.status === 'W') && p > 0 && p >= callAt;
  const cands = r.candidates.map((c, i) => {
    const v = Math.round(fin[i] * share(key, c.majorParty, p));
    return { ...c, voteNum: v, voteStr: v.toLocaleString('en-US'), winner: called && !!c.winner, runoffCandidate: p >= 1 && !!c.runoffCandidate };
  });
  return {
    ...r, ecKey: key, contestType: contest,
    candidates: cands, totalVote: cands.reduce((s, c) => s + c.voteNum, 0),
    percentReporting: p >= 1 ? r.percentReporting : Math.min(98, Math.round((r.percentReporting ?? 100) * p)),
    editorialStatus: called ? 'called' : 'pending', status: called ? 'W' : null,
    countyVotesAvailable: p > 0, voteTimestamp: new Date(now).toISOString(), extractedAt: new Date(now).toISOString(),
    raceEmbargo: { ...(r.raceEmbargo || {}), pollsClosed: p > 0 },
    _p: p,
  };
}

/* ---------------- fake politics.api.cnn.io ---------------- */
const national = {};
for (const [ct, f] of Object.entries(SOURCE)) national[ct] = await cached(f, `${UPSTREAM}/national-races/${f}.json`);
const fake = http.createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  try {
    const now = Date.now();
    let m = req.url.match(/^\/national-races\/2026-(SG|S2G|HG|GG)\.json/);
    if (m) {
      if (!national[m[1]]) return send(404, { error: 'not published' });
      return send(200, national[m[1]].filter((r) => r.contestType === m[1]).map((r) => { const x = replayRace(r, now); delete x._p; return x; }));
    }
    m = req.url.match(/^\/county-races\/2026-(SG|HG|GG)-([A-Z]{2})((?:-\d+)?)\.json/);
    if (m) {
      const race = national[m[1]]?.find((r) => r.ecKey === `${SOURCE[m[1]]}-${m[2]}${m[3]}`);
      if (!race) return send(404, { error: 'no such race' });
      const x = replayRace(race, now);
      if (!x._p) return send(404, { error: 'not yet' });
      const list = await cached(`county-${race.ecKey}`, `${UPSTREAM}/county-races/${race.ecKey}.json`);
      return send(200, list.map((c) => {
        const cands = (c.candidates || []).map((k) => ({ ...k, voteNum: Math.round((k.voteNum || 0) * share(x.ecKey, k.majorParty, x._p)) }));
        return { ...c, ecKey: x.ecKey, candidates: cands, totalVote: cands.reduce((s, k) => s + k.voteNum, 0), percentReporting: Math.round((c.percentReporting ?? 100) * x._p) };
      }));
    }
    send(404, { error: 'unknown path' });
  } catch (e) { send(e.status || 502, { error: e.message }); }
});
await new Promise((r) => fake.listen(CNN_PORT, r));
const CNN_BASE = `http://localhost:${CNN_PORT}`;
log(`fake CNN at ${CNN_BASE}: Senate ${SOURCE.SG}, governors ${SOURCE.GG}, House ${SOURCE.HG} replayed as 2026 over ${MINUTES} min`);

/* ---------------- the pipeline ---------------- */
const children = [];
const stop = () => { for (const c of children) c.kill('SIGTERM'); fake.close(); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

if (ENV) {
  // the real scraper writes a throwaway Supabase project; a read-only site reads it
  const env = { ...process.env, CNN_BASE };
  for (const line of fs.readFileSync(ENV, 'utf8').split('\n')) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/); if (m) env[m[1]] = m[2]; }
  const run = (cmd, a, extra, tag) => {
    const c = spawn(cmd, a, { cwd: ROOT, env: { ...env, ...extra } });
    c.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`)); c.stderr.on('data', (d) => process.stderr.write(`[${tag}] ${d}`));
    c.on('exit', (code) => { log(`${tag} exited (${code})`); if (tag === 'scraper') stop(); });
    children.push(c);
  };
  run('node', ['scripts/scraper.mjs', '--env', ENV, '--tasks', 'results,counties', '--archive', path.join(CACHE, 'archive')], {}, 'scraper');
  run('node', ['server.mjs'], { READ_ONLY: '1', NO_POLL: '1', PORT: String(PORT) }, 'site');
} else {
  // one process, in-memory store: the same poll code the scraper runs, every 15 s, and the site
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SECRET_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.STORE_FILE;
  process.env.CNN_BASE = CNN_BASE; process.env.NO_POLL = '1'; process.env.PORT = String(PORT);
  const { runPoll } = await import('../lib/poll.mjs');
  await import('../server.mjs');
  const cycle = async () => {
    try {
      const out = await runPoll({ beat: true, only: ['results', 'counties'] });
      const s = out.tasks.results, c = out.tasks.counties;
      if (s && !s.skipped) log(`results ${s.ok ? 'ok' : `✗ ${s.error}`}${c && !c.skipped ? `  counties ${c.ok ? 'ok' : `✗ ${c.error}`}` : ''}`);
    } catch (e) { log(`cycle failed: ${e.message}`); }
  };
  await cycle(); setInterval(cycle, 15e3);
}
log(`site: http://localhost:${PORT}/   night ends ${new Date(T0 + D).toLocaleTimeString('en-US', { hour12: false })}`);
setTimeout(() => log('rehearsal night over: every race at its final count; leave running to inspect, Ctrl-C to stop'), D);
