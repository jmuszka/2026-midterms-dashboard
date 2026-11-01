// The poller. One call to runPoll() runs every task whose interval has elapsed,
// writes each task's snapshot to the store, diffs results and markets into events,
// and records the time series the timeline scrubber replays (docs/SCRUBBER.md):
// per-race change ticks, 5-minute keyframes, market ticks, news items, posts and
// stream changes. With { beat: true } it ends with a heartbeat row.
//
// Writers: scripts/scraper.mjs (election night: the owner's machine, the only writer
// to Supabase) and server.mjs locally. Readers: read endpoints call snapshot().
// With READ_ONLY=1 (the Vercel site) snapshot() only ever serves the stored copy and
// nothing here touches an upstream source. Without READ_ONLY (local dev, or a site
// with no scraper) it refreshes inline when the stored copy is stale.
import { createRequire } from 'node:module';
import os from 'node:os';
import { getStore, READ_ONLY } from './store.mjs';
import { cnn, STATE_ADAPTERS, mergeResults } from './sources/results.mjs';
import { markets } from './sources/markets.mjs';
import { socialList } from './sources/social.mjs';
import { resolveStreams, videoMeta } from './sources/streams.mjs';
import { pool } from './http.mjs';
import { news, trends } from './sources/news.mjs';
import { stockQuotes, stockCharts } from './sources/stocks.mjs';
import { diffResults, diffMarkets } from './diff.mjs';
import { closeTime } from './model.mjs';

const require = createRequire(import.meta.url);

// Writer clock. The scraper measures its offset against Supabase's server time and sets it
// here, so ticks, events and heartbeats carry true time even if the machine's clock drifts
// (the owner's laptop had NTP off and ran 98 s slow, which made every heartbeat look stale).
let skewMs = 0;
export const setClockSkew = (ms) => { skewMs = ms; };
const nowIso = () => new Date(Date.now() + skewMs).toISOString();
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
  stocks: { interval: SOURCES.stocks.interval, run: () => stockQuotes(SOURCES.stocks) },
  stockcharts: { interval: SOURCES.stocks.chartInterval, run: () => stockCharts(SOURCES.stocks) },
  ...Object.fromEntries(Object.entries(SOURCES.social.lists).map(([id, list]) => [`social:${id}`, { interval: SOURCES.social.interval, run: () => socialList(list) }])),
};

const inflight = new Map();
async function runTask(name, store) {
  if (inflight.has(name)) return inflight.get(name);
  const p = (async () => {
    const t0 = Date.now();
    const value = await TASKS[name].run();
    const snap = { ...value, task: name, ranAt: nowIso(), ms: Date.now() - t0 };
    const prev = await store.get(`snap:${name}`);
    await afterRun(name, prev, snap, store);
    await store.set(`snap:${name}`, snap);
    return snap;
  })().finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

const tickRow = (id, r, t) => ({
  race_id: id, t, src_t: r.updatedAt || null, called: !!r.called, winner: r.called ? r.winner : null, runoff: !!r.runoff,
  expected: r.expectedPct ?? null, prec: r.precincts?.reporting ?? null, prec_total: r.precincts?.total ?? null,
  votes: r.candidates.map((c) => [c.name, c.party, c.votes]), src: r.countsFrom || r.source || null,
});
const sameTick = (a, b) => a && b && a.called === b.called && a.winner === b.winner && a.runoff === b.runoff && a.expected === b.expected
  && a.prec === b.prec && JSON.stringify(a.votes) === JSON.stringify(b.votes);
const KEYFRAME_EVERY = 5 * 60e3;

async function afterRun(name, prev, snap, store) {
  const t = snap.ranAt;
  if (name === 'results') {
    const ev = diffResults(prev?.races, snap.races, MANIFEST, t);
    if (ev.length) await store.addEvents(ev);
    // scrubber: one row per race whose state changed since the last snapshot
    const rows = [];
    for (const [id, r] of Object.entries(snap.races || {})) {
      const row = tickRow(id, r, t);
      const before = prev?.races?.[id] ? tickRow(id, prev.races[id], prev.ranAt) : null;
      if (!sameTick(row, before)) rows.push(row);
    }
    if (rows.length) await store.addRaceTicks(rows);
    snap.ticksWritten = rows.length;
    const last = await store.get('lastKeyframe');
    if (!last || Date.parse(t) - Date.parse(last) >= KEYFRAME_EVERY) { await store.addSnapshot('results', t, snap.races); await store.set('lastKeyframe', t); }
  }
  if (name === 'markets') {
    const competitive = ['control:S', 'control:H', ...Object.keys(snap.races || {}).filter((id) => Math.abs(MANIFEST[id]?.consensus?.score ?? 3) < 2)];
    const all = ['control:S', 'control:H', ...Object.keys(snap.races || {})];
    const value = (k) => (k.startsWith('control:') ? snap.control?.[k.slice(8)] : snap.races?.[k])?.avg?.DEM ?? null;
    const history = await store.ticksMany(competitive, new Date(Date.parse(t) - 30 * 60e3).toISOString());
    const alerts = (await store.get('marketAlerts')) || {};
    const ev = diffMarkets(history, snap, MANIFEST, alerts, t);
    if (ev.length) { await store.addEvents(ev); await store.set('marketAlerts', alerts); }
    // only when the price moved (or every 15 min as a keep-alive), so a quiet market costs no rows
    const prevValue = (k) => (k.startsWith('control:') ? prev?.control?.[k.slice(8)] : prev?.races?.[k])?.avg?.DEM ?? null;
    const crossed = (ms) => !prev?.ranAt || Math.floor(Date.parse(t) / ms) !== Math.floor(Date.parse(prev.ranAt) / ms);
    const refresh = crossed(900e3), hourly = crossed(3600e3);
    const pts = all.map((k) => ({ key: k, t, v: value(k) }));
    // topic questions (markets.topics): each outcome's Yes price as topic:<market id>
    const outcomes = (topics) => new Map((topics || []).flatMap((g) => g.events.flatMap((e) => e.outcomes.map((o) => [`topic:${o.id}`, o.p]))));
    const was = outcomes(prev?.topics);
    for (const [key, v] of outcomes(snap.topics)) pts.push({ key, t, v, was: was.get(key) ?? null });
    // The ~410 races that are not competitive were most of the rows (each re-sent every 15 min) and
    // make the timeline bundle heavy: they get a row on a move of a point or more, or hourly.
    const close = new Set(competitive);
    const keep = (p) => {
      if (p.v == null) return false;
      if (p.key.startsWith('topic:')) return refresh || p.v !== p.was;
      if (close.has(p.key)) return refresh || p.v !== prevValue(p.key);
      const last = lastRecorded.get(p.key) ?? prevValue(p.key);
      return hourly || last == null || Math.abs(p.v - last) >= 0.01;
    };
    const rows = pts.filter(keep).map(({ key, t, v }) => ({ key, t, v }));
    await store.addTicks(rows);
    for (const r of rows) lastRecorded.set(r.key, r.v);
  }
  if (name === 'stocks') {
    // timeline: price (stock:SYM) on change, previous close (stockpc:SYM) when a new session starts
    const pts = [];
    for (const [sym, q] of Object.entries(snap.quotes || {})) {
      const o = prev?.quotes?.[sym];
      if (q.price != null && q.price !== o?.price) pts.push({ key: `stock:${sym}`, t, v: q.price });
      if (q.prevClose != null && q.prevClose !== o?.prevClose) pts.push({ key: `stockpc:${sym}`, t, v: q.prevClose });
    }
    await store.addTicks(pts);
  }
  if (name === 'news') {
    const seen = new Set((prev?.items || []).map((i) => i.link));
    const fresh = (snap.items || []).filter((i) => !seen.has(i.link));
    await store.addNewsItems(fresh.map((i) => ({ link: i.link, first_seen: t, published: i.published ? new Date(i.published).toISOString() : null, source: i.source, title: i.title, lanes: i.lanes, description: i.description || null, image: i.image || null })));
  }
  if (name.startsWith('social:')) {
    const seen = new Set((prev?.posts || []).map((p) => p.id));
    await store.addPosts(name.slice(7), (snap.posts || []).filter((p) => !seen.has(p.id)).map((p) => ({ ...p, firstSeen: t })));
  }
  if (name === 'streams') {
    const rows = Object.entries(snap.streams || {}).filter(([id, v]) => { const o = prev?.streams?.[id]; return !o || o.videoId !== v.videoId || o.status !== v.status; })
      .map(([id, v]) => ({ stream_id: id, t, video_id: v.videoId || null, status: v.status, title: v.title || null }));
    await store.addStreamTicks(rows);
    // stream replay: broadcast times for each video, fetched once when first seen and again when
    // its stream ends (to learn the end time and how much YouTube archived)
    const known = (await store.get('videoMetaSeen')) || {};
    const todo = [];
    for (const [id, v] of Object.entries(snap.streams || {})) {
      if (v.videoId && (v.status === 'live' || v.status === 'upcoming') && known[v.videoId] !== v.status) todo.push({ stream: id, videoId: v.videoId, status: v.status });
    }
    for (const [id, o] of Object.entries(prev?.streams || {})) {
      const now = snap.streams?.[id];
      if (o.videoId && o.status === 'live' && now?.videoId !== o.videoId && known[o.videoId] !== 'ended') todo.push({ stream: id, videoId: o.videoId, status: 'ended' });
    }
    if (todo.length) {
      const metas = await pool(todo.slice(0, 12), 4, async (x) => ({ ...(await videoMeta(x.videoId)), stream_id: x.stream, status: x.status }));
      const rowsV = metas.filter((m) => m && !m.error && m.video_id).map(({ status, ...m }) => m);
      if (rowsV.length) await store.addStreamVideos(rowsV);
      for (const m of metas) if (m && !m.error && m.video_id) known[m.video_id] = m.live ? 'live' : m.end_at ? 'ended' : m.status;
      await store.set('videoMetaSeen', known);
    }
  }
}

// Run every due task (or the named ones). Returns a summary for /api/poll.
export const VERSION = '2026-11-01';
const backoff = new Map(); // task -> { fails, until }: wait interval × 2^(fails−1), at most 15 min
const lastRecorded = new Map(); // market key -> last value written as a tick (thinning, below)
export async function runPoll({ only, force = false, beat = false } = {}) {
  const store = await getStore();
  const names = only?.length ? only.filter((n) => TASKS[n]) : Object.keys(TASKS);
  const summary = {};
  await Promise.all(names.map(async (n) => {
    const last = await store.get(`snap:${n}`);
    const age = last ? (Date.now() + skewMs - Date.parse(last.ranAt)) / 1000 : Infinity;
    if (!force && age < TASKS[n].interval - 5) { summary[n] = { skipped: true, age: Math.round(age) }; return; }
    if (!force && Date.now() < (backoff.get(n)?.until || 0)) { summary[n] = { skipped: true, backoff: Math.round((backoff.get(n).until - Date.now()) / 1000) }; return; }
    try { const s = await runTask(n, store); backoff.delete(n); summary[n] = { ok: true, ms: s.ms }; }
    catch (e) {
      // a failed run writes no snapshot, so without this the task would rerun on every 15 s cycle
      const fails = (backoff.get(n)?.fails || 0) + 1;
      backoff.set(n, { fails, until: Date.now() + Math.min(TASKS[n].interval * 2 ** (fails - 1), 900) * 1000 });
      summary[n] = { ok: false, error: e.message }; console.error(`[poll ${n}]`, e.message);
    }
  }));
  const out = { store: store.kind, ranAt: nowIso(), tasks: summary };
  if (beat) {
    const tasks = Object.fromEntries(Object.entries(summary).filter(([, v]) => !v.skipped).map(([k, v]) => [k, v.ok ? 'ok' : `error: ${v.error}`.slice(0, 200)]));
    if (Math.abs(skewMs) > 2000) tasks._clock = `local clock off by ${Math.round(skewMs / 1000)}s (corrected)`;
    await store.beat({ t: out.ranAt, host: os.hostname(), version: VERSION, tasks });
  }
  return out;
}

// Scraper liveness for read responses (cached briefly: every request asks)
let beatCache = { at: 0, value: null };
export async function scraperStatus() {
  if (Date.now() - beatCache.at < 5000) return beatCache.value;
  const store = await getStore();
  let value = null;
  try { const b = await store.lastBeat(); value = b ? { t: b.t, age: Math.round((Date.now() - Date.parse(b.t)) / 1000), host: b.host, tasks: b.tasks } : { age: null }; } catch (e) { value = { age: null, error: e.message }; }
  beatCache = { at: Date.now(), value };
  return value;
}

// Read path. Serves the stored snapshot; refreshes inline when it is missing or
// older than 3 intervals, falling back to the stale copy if the refresh fails.
export async function snapshot(name) {
  const store = await getStore();
  const snap = await store.get(`snap:${name}`);
  const age = snap ? (Date.now() - Date.parse(snap.ranAt)) / 1000 : Infinity;
  if (READ_ONLY) { // the site never fetches upstream: stale data is shown as stale, not refreshed
    if (!snap) throw Object.assign(new Error(`no ${name} data yet: the scraper has not written it`), { status: 503 });
    return { ...snap, age: Math.round(age), stale: age > TASKS[name].interval * 3 };
  }
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
  if (!READ_ONLY) await snapshot('results').catch(() => {}); // make sure a diff has run at least once on this instance
  return store.events({ since, limit });
}
export async function ticks(keys, sinceIso) {
  const store = await getStore();
  return store.ticksMany(keys, sinceIso);
}
