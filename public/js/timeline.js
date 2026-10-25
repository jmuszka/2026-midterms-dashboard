/* Timeline model: holds the bundle from /api/timeline and rebuilds the dashboard's data at any
 * moment. stateAt(t) returns the same shape as /api/results, so the views cannot tell a replay
 * from live data. Loaded once, then appended with ?since= (every 30 s, or when a scraper
 * heartbeat arrives). */
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
function merge(add) {
  const b = tl.bundle;
  mergeRaces(b.races, add.races);
  for (const [k, m] of Object.entries(add.markets || {})) {
    const into = (b.markets[k] ||= { t: [], v: [] });
    m.t.forEach((t, i) => { if (!into.t.length || t > into.t[into.t.length - 1]) { into.t.push(t); into.v.push(m.v[i]); } });
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
  if (add.to && (!b.to || add.to > b.to)) b.to = add.to;
  if (add.from && (!b.from || add.from < b.from)) b.from = add.from;
}
let loading = null;
export function refresh(v) {
  if (loading) return loading;
  loading = (async () => {
    try {
      if (!tl.bundle) { tl.bundle = await getJSON(url(null, v)); }
      else merge(await getJSON(url(tl.bundle.to, v)));
      tl.loaded = true; tl.error = null;
      memo.clear();
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
  for (const k of Object.keys(m)) if (!k.startsWith('control:')) { const a = avg(val(k)); if (a) races[k] = a; }
  const series = (k) => (m[k] ? m[k].t.map((t, i) => ({ t: new Date(t * 1000).toISOString(), v: m[k].v[i] })).filter((p) => Date.parse(p.t) <= ms) : []);
  return { control, races, ticks: { 'control:S': series('control:S'), 'control:H': series('control:H') }, meta: { errors: [] }, replay: true, ranAt: new Date(ms).toISOString() };
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
  const p = tl.bundle?.posts?.[list];
  if (!p?.length) return undefined;
  const s = ms / 1000;
  const posts = p.filter((x) => x.t <= s).map((x) => x.post).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, 80);
  return { id: list, name: app.config.social[list]?.name, posts, errors: [], ranAt: new Date(ms).toISOString(), replay: true };
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
