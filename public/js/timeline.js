/* Timeline model: holds the bundle from /api/timeline and rebuilds the dashboard's data at any
 * moment. stateAt(t) returns the same shape as /api/results, so the views cannot tell a replay
 * from live data. Loaded in hour pieces (settled ones are cached by the CDN for everyone), then
 * appended with ?since= (every 30 s, or when a scraper heartbeat arrives); loadEarlier() adds
 * older history a day at a time. A simulated night is one download. */
import { app, getJSON } from './core.js';

const tl = {
  bundle: null, loaded: false, error: null, subs: new Set(),
  get from() { return this.bundle?.from ? Date.parse(this.bundle.from) : null; },
  get to() { return this.bundle?.to ? Date.parse(this.bundle.to) : null; },
  get simulated() { return !!this.bundle?.simulated; },
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); },
};
export default tl;

const simQ = () => (app.sim ? `sim=1${app.simAt ? `&simAt=${app.simAt}` : ''}` : '');
const url = (since, v) => `/api/timeline?${[simQ(), since ? `since=${encodeURIComponent(since)}` : '', v ? `v=${v}` : ''].filter(Boolean).join('&')}`;
const segUrl = (a, z, head) => `/api/timeline?since=${new Date(a).toISOString()}&until=${new Date(z).toISOString()}${head ? '&head=1' : ''}`;
const HOUR = 3600e3, NIGHT_FROM = Date.parse('2026-11-03T20:00:00.000Z'); // lib/timeline.mjs bundleFloor
const floorAt = (now) => (now >= NIGHT_FROM ? NIGHT_FROM : Math.floor((now - 24 * HOUR) / HOUR) * HOUR);
// settled hour pieces from a to z (whole hours), the first carrying the state in force at a
async function segments(a, z, step) {
  const parts = [];
  for (let x = a; x < z; x += step) parts.push([x, Math.min(z, x + step)]);
  const out = new Array(parts.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, parts.length) }, async () => {
    while (next < parts.length) { const i = next++; out[i] = await getJSON(segUrl(parts[i][0], parts[i][1], i === 0)); }
  }));
  return out;
}

/* ---------------- loading and merging ---------------- */
function mergeRaces(into, add) {
  for (const [id, r] of Object.entries(add)) {
    const b = into[id];
    if (!b) { into[id] = r; continue; }
    // align the new rows' candidate columns to the existing ones (new candidates get zeros in old rows)
    const map = r.cand.map(([name, party]) => {
      let i = b.cand.findIndex(([n]) => n === name);
      if (i < 0) { i = b.cand.push([name, party]) - 1; b.v.forEach((row) => row.push(0)); }
      return i;
    });
    r.t.forEach((t, k) => {
      if (b.t.length && t <= b.t[b.t.length - 1]) return; // already have it (overlapping since=)
      const row = new Array(b.cand.length).fill(0);
      r.v[k].forEach((x, j) => { row[map[j]] = x; });
      b.t.push(t); b.v.push(row); b.e.push(r.e[k]); b.p.push(r.p[k]); b.c.push(r.c[k]); b.w.push(r.w[k]);
    });
  }
}
function merge(b, add) {
  mergeRaces(b.races, add.races);
  for (const sec of ['markets', 'stocks', 'stockPrev']) {
    for (const [k, m] of Object.entries(add[sec] || {})) {
      const into = ((b[sec] ||= {})[k] ||= { t: [], v: [] });
      m.t.forEach((t, i) => { if (!into.t.length || t > into.t[into.t.length - 1]) { into.t.push(t); into.v.push(m.v[i]); } });
    }
  }
  const seenEv = new Set(b.events.map((e) => e.id));
  b.events.push(...(add.events || []).filter((e) => !seenEv.has(e.id)));
  const seenNews = new Set(b.news.map((n) => n.item.link));
  b.news.push(...(add.news || []).filter((n) => !seenNews.has(n.item.link)));
  for (const [list, ps] of Object.entries(add.posts || {})) {
    const into = (b.posts[list] ||= []); const seen = new Set(into.map((p) => p.post.id));
    into.push(...ps.filter((p) => !seen.has(p.post.id)));
  }
  for (const [id, rows] of Object.entries(add.streams || {})) (b.streams[id] ||= []).push(...rows);
  const tr = (b.trends ||= []);
  for (const row of add.trends || []) if (!tr.length || row[0] > tr[tr.length - 1][0]) tr.push(row);
  if (add.videos) { b.videos = add.videos; b.archive = add.archive || {}; } // always sent in full
  if (add.topics?.length) b.topics = add.topics; // names only, always sent in full
  if (add.to && (!b.to || add.to > b.to)) b.to = add.to;
  if (add.from && (!b.from || add.from < b.from)) b.from = add.from;
  if (add.start) b.start = add.start;
}
// first load: whole hours since the floor that are settled (3 min past), then the live tail
async function loadInitial(v) {
  const now = Date.now(), floor = floorAt(now), last = Math.floor((now - 180e3) / HOUR) * HOUR;
  if (app.sim || last <= floor) return getJSON(url(null, v));
  const [b, ...rest] = await segments(floor, last, HOUR);
  for (const s of rest) merge(b, s);
  const tail = await getJSON(url(new Date(last).toISOString(), v));
  merge(b, tail);
  b.from = new Date(Math.max(floor, b.start ? Date.parse(b.start) : 0)).toISOString(); // not before the first recording
  return b;
}
let loading = null;
export function refresh(v) {
  if (loading) return loading;
  loading = (async () => {
    try {
      if (!tl.bundle) { tl.bundle = await loadInitial(v); }
      else merge(tl.bundle, await getJSON(url(tl.bundle.to, v)));
      tl.loaded = true; tl.error = null;
      memo.clear();
    } catch (e) { tl.error = e.message; }
    finally { loading = null; }
    for (const fn of tl.subs) fn(tl);
  })();
  return loading;
}
// older history, a day at a time (6-hour pieces), down to the first recording
export const canLoadEarlier = () => !!tl.bundle && !tl.simulated && !!tl.bundle.start && tl.from > Date.parse(tl.bundle.start) + 60e3;
export function loadEarlier(hours = 24) {
  if (!canLoadEarlier() || loading) return loading;
  loading = (async () => {
    try {
      const z = tl.from, a = Math.max(Math.floor(Date.parse(tl.bundle.start) / HOUR) * HOUR, z - hours * HOUR);
      const [b, ...rest] = await segments(a, z, 6 * HOUR);
      for (const s of rest) merge(b, s);
      merge(b, tl.bundle); b.from = new Date(a).toISOString();
      tl.bundle = b; memo.clear(); tl.error = null;
    } catch (e) { tl.error = e.message; }
    finally { loading = null; }
    for (const fn of tl.subs) fn(tl);
  })();
  return loading;
}
export function start() {
  refresh();
  setInterval(() => refresh(), app.sim ? 15000 : 30000);
}

/* ---------------- state at a moment ---------------- */
// index of the last element <= x in an ascending array, or -1
function at(arr, x) {
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
const memo = new Map();
export function resultsAt(ms) {
  const s = Math.floor(ms / 1000);
  if (memo.has(`r${s}`)) return memo.get(`r${s}`);
  const races = {};
  for (const [id, b] of Object.entries(tl.bundle?.races || {})) {
    const i = at(b.t, s);
    if (i < 0) continue;
    const called = b.c[i] === 1, winner = b.w[i];
    const cands = b.cand.map(([name, party], k) => ({ name, party, votes: b.v[i][k] || 0, incumbent: !!(app.race[id]?.incumbent?.name === name) }));
    cands.sort((x, y) => y.votes - x.votes);
    const total = cands.reduce((a, c) => a + c.votes, 0);
    for (const c of cands) c.pct = total ? (c.votes / total) * 100 : 0;
    const win = called ? cands.find((c) => c.party === winner) || cands[0] : null;
    if (win) win.winner = true;
    const [a, z] = cands;
    races[id] = {
      id, source: 'timeline', updatedAt: new Date(b.t[i] * 1000).toISOString(), simulated: tl.simulated,
      called, winner: called ? winner : null, winnerName: win?.name || null, calledBy: called ? (tl.simulated ? 'SIMULATED' : 'as recorded') : null,
      runoff: b.c[i] === 2, flip: null, expectedPct: b.e[i], precincts: b.p[i] ? { reporting: b.p[i][0], total: b.p[i][1] } : null,
      candidates: cands, totalVotes: total, leader: a && a.votes > 0 ? a.party : null,
      marginPct: a && z && total ? ((a.votes - z.votes) / total) * 100 : a && total ? 100 : 0,
    };
  }
  const out = { races, replay: true, at: new Date(ms).toISOString(), ranAt: new Date(ms).toISOString(), simulated: tl.simulated, simTime: new Date(ms).toISOString(), sources: [{ source: 'timeline' }] };
  memo.set(`r${s}`, out);
  if (memo.size > 200) memo.delete(memo.keys().next().value);
  return out;
}
// markets at a moment: only the average Democratic probability is recorded per key
export function marketsAt(ms, live) {
  const m = tl.bundle?.markets || {};
  if (!Object.keys(m).length) return undefined; // nothing recorded (e.g. simulation): keep showing live odds
  const s = Math.floor(ms / 1000);
  const val = (k) => { const x = m[k]; if (!x) return null; const i = at(x.t, s); return i < 0 ? null : x.v[i]; };
  const avg = (v) => (v == null ? null : { avg: { DEM: v, GOP: Math.round((1 - v) * 1000) / 1000 } });
  const control = {};
  for (const k of ['S', 'H']) { const a = avg(val(`control:${k}`)); if (a) control[k] = a; }
  const races = {};
  for (const k of Object.keys(m)) if (!k.startsWith('control:') && !k.startsWith('topic:')) { const a = avg(val(k)); if (a) races[k] = a; }
  // topic questions: names from the bundle, each outcome's Yes price as it was at the moment
  const topics = (tl.bundle.topics || []).map((g) => ({ ...g, events: g.events.map((e) => {
    const outcomes = e.outcomes.map((o) => ({ ...o, p: val(`topic:${o.id}`), d1: null })).filter((o) => o.p != null);
    if (e.exclusive) outcomes.sort((a, b) => b.p - a.p);
    return { ...e, outcomes };
  }).filter((e) => e.outcomes.length) }));
  const series = (k) => (m[k] ? m[k].t.map((t, i) => ({ t: new Date(t * 1000).toISOString(), v: m[k].v[i] })).filter((p) => Date.parse(p.t) <= ms) : []);
  return { control, races, topics, ticks: { 'control:S': series('control:S'), 'control:H': series('control:H') }, meta: { errors: [] }, replay: true, ranAt: new Date(ms).toISOString() };
}
export function eventsAt(ms) {
  const iso = new Date(ms).toISOString();
  return (tl.bundle?.events || []).filter((e) => e.t <= iso);
}
export function newsAt(ms) {
  const n = tl.bundle?.news || [];
  if (!n.length) return undefined;
  const s = ms / 1000;
  const items = n.filter((x) => x.t <= s).map((x) => x.item).sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 200);
  return { items, errors: [], fetchedAt: new Date(ms).toISOString(), ranAt: new Date(ms).toISOString(), replay: true };
}
export function postsAt(list, ms) {
  const all = tl.bundle?.posts || {};
  const s = ms / 1000;
  if (list === 'all') { // the everyone feed: every recorded list, a post once, tagged with its lists
    const byId = new Map();
    for (const [id, rows] of Object.entries(all)) for (const x of rows) {
      if (x.t > s) continue;
      const cur = byId.get(x.post.id);
      if (cur) { if (!cur.lists.includes(id)) cur.lists.push(id); continue; }
      byId.set(x.post.id, { ...x.post, acct: x.post.acct || x.post.repostBy?.handle || x.post.author?.handle || '', lists: [id] });
    }
    if (!byId.size) return undefined;
    const posts = [...byId.values()].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, 400);
    return { id: 'all', name: 'Everyone', posts, errors: [], ranAt: new Date(ms).toISOString(), replay: true };
  }
  const p = all[list];
  if (!p?.length) return undefined;
  const posts = p.filter((x) => x.t <= s).map((x) => x.post).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, 80);
  return { id: list, name: app.config.social[list]?.name, posts, errors: [], ranAt: new Date(ms).toISOString(), replay: true };
}
// Stock quotes at a moment, rebuilt from recorded prices (stock:SYM) and previous closes
// (stockpc:SYM); intraday series = the recorded prices of the 24 hours before the moment.
const typeOf = (s) => (s.startsWith('@') ? 'DERIVATIVE' : /^US\d+Y$/.test(s) ? 'BOND' : /\.CB=$/.test(s) ? 'CRYPTO' : /=$/.test(s) ? 'CURRENCY' : s.startsWith('.') ? 'INDEX' : 'STOCK');
export function sessionAt(symbol, ms) {
  const et = new Date(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(), mins = et.getHours() * 60 + et.getMinutes(), type = typeOf(symbol);
  if (type === 'CRYPTO') return 'open';
  if (type === 'CURRENCY') return day === 6 || (day === 5 && mins >= 1020) || (day === 0 && mins < 1020) ? 'closed' : 'open';
  if (type === 'DERIVATIVE' || type === 'BOND') {
    if (day === 6 || (day === 5 && mins >= 1020) || (day === 0 && mins < 1080)) return 'closed';
    return mins >= 1020 && mins < 1080 ? 'closed' : 'open';
  }
  if (day === 0 || day === 6) return 'closed';
  if (mins >= 570 && mins < 960) return 'open';
  if (type === 'INDEX') return 'closed';
  return mins >= 240 && mins < 570 ? 'pre' : mins >= 960 && mins < 1200 ? 'post' : 'closed';
}
export function stocksAt(ms) {
  const st = tl.bundle?.stocks || {};
  if (!Object.keys(st).length) return undefined; // nothing recorded (e.g. simulation): stay live
  const s = Math.floor(ms / 1000), quotes = {}, series = {};
  for (const [sym, m] of Object.entries(st)) {
    const i = at(m.t, s);
    if (i < 0) continue;
    const pc = tl.bundle.stockPrev?.[sym]; const j = pc ? at(pc.t, s) : -1;
    const price = m.v[i], prevClose = j >= 0 ? pc.v[j] : null;
    const change = prevClose ? price - prevClose : null;
    quotes[sym] = { symbol: sym, price, prevClose, change, changePct: prevClose ? (change / prevClose) * 100 : null, unit: /^US\d+Y$/.test(sym) ? '%' : '', state: sessionAt(sym, ms) };
    const from = s - 24 * 3600;
    const pts = [];
    for (let k = 0; k <= i; k++) if (m.t[k] >= from) pts.push([m.t[k], m.v[k]]);
    series[sym] = pts;
  }
  return { quotes, series, errors: [], replay: true, ranAt: new Date(ms).toISOString() };
}

// What a stream window should show at a moment (docs/SCRUBBER.md §6):
//   undefined                      -> stay live (simulated night with no curated video for this stream)
//   { kind: 'video', videoId, mode: 'vod',  pos }       seconds into an ended/archived video
//   { kind: 'video', videoId, mode: 'edge', behind }    a still-live stream: seconds behind its live edge
//   { kind: 'none', reason }       not-recorded | before-recording | offline | not-started | not-archived
export function streamAt(id, ms) {
  const b = tl.bundle;
  if (!b) return undefined;
  for (const vid of b.archive?.[id] || []) { // curated permanent videos first
    const v = b.videos[vid]; const st = Date.parse(v.start);
    const len = v.length ? v.length * 1000 : v.end ? Date.parse(v.end) - st : null;
    if (ms >= st && (len == null || ms <= st + len)) return { kind: 'video', videoId: vid, mode: 'vod', pos: (ms - st) / 1000, title: v.title, archived: true };
  }
  if (b.simulated) return undefined;
  const ticks = b.streams?.[id];
  if (!ticks?.length) return { kind: 'none', reason: 'not-recorded' };
  const i = at(ticks.map((x) => x[0]), Math.floor(ms / 1000));
  if (i < 0) return { kind: 'none', reason: 'before-recording' };
  const [, videoId, status, title] = ticks[i];
  if (status !== 'live' || !videoId) return { kind: 'none', reason: status === 'upcoming' ? 'not-started' : 'offline' };
  const v = b.videos?.[videoId];
  if (v?.live && v.dvr === false && Date.now() - ms > 60e3) return { kind: 'none', reason: 'no-dvr' }; // this channel cannot be rewound while live
  if (!v?.start || v.live) return { kind: 'video', videoId, mode: 'edge', behind: Math.max(0, (Date.now() - ms) / 1000), pos: v?.start ? (ms - Date.parse(v.start)) / 1000 : null, dvr: v?.dvr ?? true, title: v?.title || title };
  const st = Date.parse(v.start), len = v.length ? v.length * 1000 : null;
  if (len != null && ms > st + len) return { kind: 'none', reason: 'not-archived' };
  return { kind: 'video', videoId, mode: 'vod', pos: Math.max(0, (ms - st) / 1000), title: v.title };
}

// Google Trends list in force at a moment (recorded each time it changed)
export function trendsAt(ms) {
  const b = tl.bundle;
  if (!b || b.simulated) return undefined;
  const rows = b.trends || [];
  const i = at(rows.map((r) => r[0]), Math.floor(ms / 1000));
  return { items: i < 0 ? [] : rows[i][1], ranAt: i < 0 ? null : new Date(rows[i][0] * 1000).toISOString(), replay: true };
}
// which video and status each channel had at a moment (the stream picker's live/scheduled marks)
const streamsMemo = { key: null, value: null };
export function streamsAt(ms) {
  const b = tl.bundle;
  if (!b || b.simulated) return undefined;
  const s = Math.floor(ms / 1000), streams = {}, idx = [];
  for (const [id, ticks] of Object.entries(b.streams || {})) {
    const i = at(ticks.map((x) => x[0]), s); idx.push(i);
    if (i >= 0) { const [, videoId, status, title] = ticks[i]; streams[id] = { id, status, videoId, title }; }
  }
  const key = idx.join(','); // same rows: same object, so windows can skip a redraw
  if (streamsMemo.key !== key) { streamsMemo.key = key; streamsMemo.value = { streams, replay: true }; }
  return streamsMemo.value;
}

// density of the night's notable events per bucket, for the strip's markers
export function markers(buckets) {
  const from = tl.from, to = tl.to;
  if (!from || !to || to <= from) return [];
  const out = Array.from({ length: buckets }, () => ({ calls: 0, flips: 0, dem: 0, gop: 0 }));
  for (const e of tl.bundle.events) {
    if (e.type !== 'race_called' && e.type !== 'flip_called') continue;
    const k = Math.min(buckets - 1, Math.max(0, Math.floor(((Date.parse(e.t) - from) / (to - from)) * buckets)));
    out[k].calls++;
    if (e.type === 'flip_called') { out[k].flips++; if (e.party === 'DEM') out[k].dem++; else if (e.party === 'GOP') out[k].gop++; }
  }
  return out;
}
