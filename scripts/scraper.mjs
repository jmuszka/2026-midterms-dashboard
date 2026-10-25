#!/usr/bin/env node
// Election-night scraper: the ONLY writer to Supabase (docs/SCRUBBER.md §0a).
// Runs every source task on its own interval, writes snapshots, events and the
// scrubber time series, and inserts a heartbeat row each cycle. The Vercel site only reads.
//
//   node scripts/scraper.mjs                 # reads .env (vercel env pull .env --yes)
//   node scripts/scraper.mjs --standby       # write only while no other scraper's heartbeat is fresh
//   node scripts/scraper.mjs --once          # one cycle, then exit (smoke test)
//   node scripts/scraper.mjs --tick 15       # seconds between cycles (default 15)
//
// Needs SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY).
// Keep the machine awake: see scripts/scraper.service (systemd-inhibit).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

// minimal .env loader (no dependency); real environment variables win
for (const file of [opt('--env', path.join(ROOT, '.env'))]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
}
delete process.env.READ_ONLY; // the scraper is the writer by definition
if (!process.env.SUPABASE_URL || !(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
  console.error('scraper: SUPABASE_URL and SUPABASE_SECRET_KEY are required (run: npx vercel env pull .env --yes)');
  process.exit(1);
}
const { runPoll, scraperStatus } = await import('../lib/poll.mjs');
const { getStore } = await import('../lib/store.mjs');

const TICK = (+opt('--tick', 15) || 15) * 1000;
const STANDBY = flag('--standby');
const HOST = os.hostname();
const STALE_FOR_STANDBY = 180; // seconds without another scraper's heartbeat before standby takes over
const log = (...a) => console.log(new Date().toLocaleTimeString('en-US', { hour12: false }), ...a);

const store = await getStore();
if (store.kind !== 'supabase') { console.error(`scraper: expected the Supabase store, got ${store.kind}`); process.exit(1); }

// refuse to become a second writer unless the other one is gone
const other = await scraperStatus();
if (other?.host && other.host !== HOST && other.age != null && other.age < STALE_FOR_STANDBY && !STANDBY) {
  console.error(`scraper: another scraper (${other.host}) wrote a heartbeat ${other.age}s ago. Stop it first, or run with --standby.`);
  process.exit(1);
}
log(`scraper on ${HOST} → ${process.env.SUPABASE_URL} (tick ${TICK / 1000}s${STANDBY ? ', standby' : ''})`);

let running = false, stopping = false, cycles = 0;
async function cycle() {
  if (running || stopping) return;
  running = true;
  try {
    if (STANDBY) {
      const s = await (await import('../lib/poll.mjs')).scraperStatus();
      if (s?.host && s.host !== HOST && s.age != null && s.age < STALE_FOR_STANDBY) { if (cycles++ % 20 === 0) log(`standby: ${s.host} is live (${s.age}s ago)`); return; }
    }
    const t0 = Date.now();
    const out = await runPoll({ beat: true });
    cycles++;
    const ran = Object.entries(out.tasks).filter(([, v]) => !v.skipped);
    const failed = ran.filter(([, v]) => !v.ok);
    if (ran.length) log(`${ran.map(([k, v]) => (v.ok ? k : `${k}✗`)).join(' ')}  (${Date.now() - t0}ms)${failed.length ? '\n  ' + failed.map(([k, v]) => `${k}: ${v.error}`).join('\n  ') : ''}`);
  } catch (e) {
    log(`cycle failed: ${e.message}`); // e.g. Supabase unreachable: keep going, the next cycle retries
  } finally { running = false; }
}

const timer = setInterval(cycle, TICK);
await cycle();
if (flag('--once')) { clearInterval(timer); log('one cycle done'); process.exit(0); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  if (stopping) process.exit(1);
  stopping = true; clearInterval(timer); log(`${sig}: finishing the current cycle…`);
  for (let i = 0; i < 60 && running; i++) await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
});
