// The poller. One call to runPoll() runs every task whose interval has elapsed,
// writes each task's snapshot to the store, diffs results and markets into events,
// and records market ticks for sparklines.
//
// Triggers: the local server runs it on a timer; on Vercel an external scheduler
// (GitHub Actions, cron-job.org, Home Assistant) or Vercel Cron calls /api/poll.
// Read endpoints call snapshot(), which serves the stored copy and, when the store
// has nothing fresh (no scheduler yet, or memory store on a fresh instance),
// runs the task inline so the dashboard still works without any setup.
import { createRequire } from 'node:module';
import { getStore } from './store.mjs';
import { cnn, STATE_ADAPTERS, mergeResults } from './sources/results.mjs';
import { markets } from './sources/markets.mjs';
import { socialList } from './sources/social.mjs';
import { resolveStreams } from './sources/streams.mjs';
import { news, trends } from './sources/news.mjs';
import { diffResults, diffMarkets } from './diff.mjs';
import { closeTime } from './model.mjs';

const require = createRequire(import.meta.url);
export const SOURCES = require('../config/sources.json');
const { races: RACES } = require('../config/races.json');
export const MANIFEST = Object.fromEntries(RACES.map((r) => [r.id, r]));

async function results() {
  const cfg = SOURCES.results;
  const [base, ...states] = await Promise.all([
    cfg.cnn.enabled ? cnn(cfg.cnn, MANIFEST).catch((e) => ({ races: {}, meta: { source: 'cnn', errors: [e.message] } })) : { races: {}, meta: { source: 'cnn', disabled: true } },
    ...cfg.states.filter((s) => s.enabled).map((s) => STATE_ADAPTERS[s.type](s, MANIFEST).catch((e) => ({ races: {}, meta: { source: s.id, errors: [e.status === 404 ? 'not published yet (404)' : e.message] } }))),
  ]);
  const races = mergeResults(base.races, states.map((s) => s.races));
  return { races, sources: [base.meta, ...states.map((s) => s.meta)], fetchedAt: new Date().toISOString() };
}

export const TASKS = {
  results: { interval: SOURCES.results.interval, run: results },
  markets: { interval: SOURCES.markets.interval, run: () => markets(SOURCES.markets) },
  streams: { interval: SOURCES.streams.interval, run: () => resolveStreams(SOURCES.streams.list) },
  news: { interval: SOURCES.news.interval, run: () => news(SOURCES.news) },
  trends: { interval: SOURCES.trends.interval, run: () => trends(SOURCES.trends) },
  ...Object.fromEntries(Object.entries(SOURCES.social.lists).map(([id, list]) => [`social:${id}`, { interval: SOURCES.social.interval, run: () => socialList(list) }])),
};

const inflight = new Map();
async function runTask(name, store) {
  if (inflight.has(name)) return inflight.get(name);
  const p = (async () => {
    const t0 = Date.now();
    const value = await TASKS[name].run();
    const snap = { ...value, task: name, ranAt: new Date().toISOString(), ms: Date.now() - t0 };
    const prev = await store.get(`snap:${name}`);
    await afterRun(name, prev, snap, store);
    await store.set(`snap:${name}`, snap);
    return snap;
  })().finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

async function afterRun(name, prev, snap, store) {
  if (name === 'results') {
    const ev = diffResults(prev?.races, snap.races, MANIFEST, snap.ranAt);
    if (ev.length) await store.addEvents(ev);
  }
  if (name === 'markets') {
    const keys = ['control:S', 'control:H', ...Object.keys(snap.races || {}).filter((id) => Math.abs(MANIFEST[id]?.consensus?.score ?? 3) < 2)];
    const value = (k) => (k.startsWith('control:') ? snap.control?.[k.slice(8)] : snap.races?.[k])?.avg?.DEM ?? null;
    const history = {};
    for (const k of keys) history[k] = await store.ticks(k, new Date(Date.now() - 30 * 60e3).toISOString());
    const alerts = (await store.get('marketAlerts')) || {};
    const ev = diffMarkets(history, snap, MANIFEST, alerts, snap.ranAt);
    if (ev.length) { await store.addEvents(ev); await store.set('marketAlerts', alerts); }
    for (const k of keys) { const v = value(k); if (v != null) await store.addTicks(k, [{ t: snap.ranAt, v }]); }
  }
}

// Run every due task (or the named ones). Returns a summary for /api/poll.
export async function runPoll({ only, force = false } = {}) {
  const store = await getStore();
  const names = only?.length ? only.filter((n) => TASKS[n]) : Object.keys(TASKS);
  const summary = {};
  await Promise.all(names.map(async (n) => {
    const last = await store.get(`snap:${n}`);
    const age = last ? (Date.now() - Date.parse(last.ranAt)) / 1000 : Infinity;
    if (!force && age < TASKS[n].interval - 5) { summary[n] = { skipped: true, age: Math.round(age) }; return; }
    try { const s = await runTask(n, store); summary[n] = { ok: true, ms: s.ms }; }
    catch (e) { summary[n] = { ok: false, error: e.message }; console.error(`[poll ${n}]`, e.message); }
  }));
  return { store: store.kind, ranAt: new Date().toISOString(), tasks: summary };
}

// Read path. Serves the stored snapshot; refreshes inline when it is missing or
// older than 3 intervals, falling back to the stale copy if the refresh fails.
export async function snapshot(name) {
  const store = await getStore();
  const snap = await store.get(`snap:${name}`);
  const age = snap ? (Date.now() - Date.parse(snap.ranAt)) / 1000 : Infinity;
  const limit = store.kind === 'supabase' ? TASKS[name].interval * 3 : TASKS[name].interval;
  if (snap && age < limit) return { ...snap, age: Math.round(age) };
  try { const s = await runTask(name, store); return { ...s, age: 0 }; }
  catch (e) { if (snap) return { ...snap, age: Math.round(age), stale: true, error: e.message }; throw e; }
}

// Poll-close events are a pure function of the clock, so they are synthesised on read.
export function pollCloseEvents(now = Date.now()) {
  const byTime = {};
  for (const r of RACES) (byTime[r.close] ||= new Set()).add(r.state);
  return Object.entries(byTime).map(([hhmm, states]) => ({ id: `close-${hhmm}`, t: closeTime(hhmm), type: 'poll_close', text: `Polls close in ${[...states].sort().join(', ')}`, data: { states: [...states].sort(), races: RACES.filter((r) => r.close === hhmm).length } }))
    .filter((e) => Date.parse(e.t) <= now).sort((a, b) => a.t.localeCompare(b.t));
}
export async function events({ since = 0, limit = 300 } = {}) {
  const store = await getStore();
  await snapshot('results').catch(() => {}); // make sure a diff has run at least once on this instance
  return store.events({ since, limit });
}
export async function ticks(keys, sinceIso) {
  const store = await getStore();
  return Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await store.ticks(k, sinceIso)])));
}
