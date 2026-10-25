/* Shared frontend core: helpers, config, the polling data hub, the selection bus and toasts. */
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
export const pct1 = (n) => (n == null ? '—' : `${n.toFixed(1)}%`);
export const signed = (n, d = 1) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(d)}`);
export function timeAgo(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, (now - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const etTime = (ts) => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
export const closeAt = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.UTC(2026, 10, 3, h + 5, m); }; // EST on Nov 3
export const closeLabel = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const hh = h % 24; return `${hh % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${hh < 12 ? 'am' : 'pm'}`; };

export async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) { let msg = `${r.status}`; try { msg = (await r.json()).error || msg; } catch {} throw new Error(`${url.split('?')[0]}: ${msg}`); }
  return r.json();
}

/* ---------------- app context ---------------- */
export const app = {
  config: null, manifest: [], race: {}, parties: new Map(), sim: false, simAt: 0,
  partyColor(id) { return this.parties.get(id)?.color || '#7A838E'; },
  partyShort(id) { return this.parties.get(id)?.short || '?'; },
  partyName(id) { return this.parties.get(id)?.name || id; },
};
export async function loadApp() {
  const [config, manifest] = await Promise.all([getJSON('/api/config'), getJSON('/api/manifest')]);
  app.config = config;
  app.manifest = manifest.races;
  app.race = Object.fromEntries(manifest.races.map((r) => [r.id, r]));
  for (const p of config.parties) app.parties.set(p.id, p);
  const q = new URLSearchParams(location.search);
  app.sim = q.has('sim') && q.get('sim') !== '0';
  app.simAt = +q.get('simAt') || 0;
}
// "Lean D" etc → numeric score (+3 safe D … −3 safe R)
export const ratingClass = (score) => (score == null ? 'none' : score >= 2.5 ? 'sd' : score >= 1.5 ? 'ld' : score >= 0.75 ? 'td' : score > -0.75 ? 'tu' : score > -1.5 ? 'tr' : score > -2.5 ? 'lr' : 'sr');
export const isCompetitive = (m) => Math.abs(m?.consensus?.score ?? 3) < 1.5;

/* ---------------- data hub ----------------
 * Windows subscribe to a key; the hub polls it only while someone listens and
 * shares one response between every subscriber. Simulation adds ?sim to results/events. */
const KEYS = {
  results: { url: () => `/api/results${simQ()}`, every: 20 },
  markets: { url: () => '/api/markets?ticks=1', every: 60 },
  streams: { url: () => '/api/streams', every: 90 },
  news: { url: () => '/api/news', every: 90 },
  trends: { url: () => '/api/trends', every: 600 },
  stocks: { url: () => '/api/stocks', every: 30 },
};
const simQ = (sep = '?') => (app.sim ? `${sep}sim=1${app.simAt ? `&simAt=${app.simAt}` : ''}` : '');
const subs = new Map(); // key -> Set(fn)
const last = new Map(); // key -> { data, at, error }
const timers = new Map();
function urlFor(key) {
  if (KEYS[key]) return KEYS[key].url();
  if (key.startsWith('social:')) return `/api/social?list=${encodeURIComponent(key.slice(7))}`;
  throw new Error(`unknown hub key ${key}`);
}
const everyFor = (key) => (KEYS[key]?.every || 60) * 1000;
// v: data version (the scraper heartbeat id). Every viewer nudged by the same heartbeat asks for
// the same URL, so the CDN fetches it once per heartbeat instead of once per viewer.
// Replay hook (set by the transport): source(key) returns the data for `key` at the clock's
// moment, or undefined when the timeline has nothing for that key (live data is kept then).
export const replay = { source: null, events: null };
const notify = (key) => { for (const fn of subs.get(key) || []) { try { fn(last.get(key)); } catch (e) { console.error(key, e); } } };
function fromReplay(key) {
  const d = replay.source?.(key);
  if (d === undefined) return false;
  last.set(key, { data: d, at: Date.now() });
  notify(key);
  return true;
}
async function pull(key, v) {
  if (replay.source && fromReplay(key)) return;
  try {
    const u = urlFor(key);
    const data = await getJSON(v ? `${u}${u.includes('?') ? '&' : '?'}v=${v}` : u);
    last.set(key, { data, at: Date.now() });
  } catch (e) {
    const prev = last.get(key);
    last.set(key, { ...(prev || {}), error: e.message, at: prev?.at || 0 });
  }
  for (const fn of subs.get(key) || []) { try { fn(last.get(key)); } catch (e) { console.error(key, e); } }
}
export const hub = {
  subscribe(key, fn) {
    if (!subs.has(key)) subs.set(key, new Set());
    subs.get(key).add(fn);
    if (last.has(key)) queueMicrotask(() => fn(last.get(key)));
    if (!timers.has(key)) { pull(key); timers.set(key, setInterval(() => pull(key), everyFor(key))); }
    return () => { subs.get(key)?.delete(fn); if (!subs.get(key)?.size) { clearInterval(timers.get(key)); timers.delete(key); } };
  },
  get: (key) => last.get(key)?.data || null,
  refresh: (key, v) => (subs.get(key)?.size ? pull(key, v) : null), // only keys someone is watching
  keys: () => [...subs.keys()].filter((k) => subs.get(k)?.size),
  replayTick() { for (const k of this.keys()) fromReplay(k); notifyEvents(); },
  goLive() { for (const k of this.keys()) pull(k); notifyEvents(); },
};

/* events are incremental (?since=id), merged into one list shared by every window */
export const events = { list: [], pollCloses: [], now: null, since: 0, subs: new Set(), timer: null, error: null };
function notifyEvents() {
  const st = replay.events ? { ...replay.events(), error: null } : events;
  for (const fn of events.subs) fn(st, []);
}
async function pullEvents(v) {
  if (replay.events) return notifyEvents(); // replaying: no toasts, the list is the timeline's
  try {
    const d = await getJSON(`/api/events?since=${events.since}${simQ('&')}${v ? `&v=${v}` : ''}`);
    const fresh = d.events.filter((e) => e.id > events.since);
    events.list.push(...fresh);
    if (events.list.length > 3000) events.list.splice(0, events.list.length - 3000);
    if (fresh.length) events.since = fresh[fresh.length - 1].id;
    events.pollCloses = d.pollCloses; events.now = d.now; events.error = null;
    if (replay.events) return notifyEvents(); // the viewer started a replay while this request was in flight
    for (const fn of events.subs) fn(events, fresh);
  } catch (e) { events.error = e.message; for (const fn of events.subs) fn(events, []); }
}
export const refreshEvents = (v) => (events.timer ? pullEvents(v) : null);
export function subscribeEvents(fn) {
  events.subs.add(fn);
  if (events.now) queueMicrotask(() => fn(events, []));
  if (!events.timer) { pullEvents(); events.timer = setInterval(pullEvents, 15000); }
  return () => events.subs.delete(fn);
}

/* ---------------- selection bus ----------------
 * One "selected race" shared by map, chamber, browser, feed and the race card. */
const selSubs = new Set();
export const selection = {
  id: null,
  set(id) { this.id = id; for (const fn of selSubs) fn(id); },
  subscribe(fn) { selSubs.add(fn); return () => selSubs.delete(fn); },
};

/* ---------------- result helpers ---------------- */
// status of one race for colouring: called / leading / none
export function raceState(r) {
  if (!r) return { status: 'none', party: null };
  if (r.called) return { status: 'called', party: r.winner };
  if (r.leader && r.totalVotes > 0) return { status: 'leading', party: r.leader };
  return { status: 'none', party: null };
}
export function marginText(r) {
  if (!r || !r.totalVotes) return '';
  const [a] = r.candidates;
  return `${app.partyShort(a.party)} +${r.marginPct.toFixed(1)}`;
}

/* ---------------- toasts ---------------- */
export function toast(html, { party = null, ms = 9000, onClick = null } = {}) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast';
  if (party) el.style.setProperty('--c', app.partyColor(party));
  el.innerHTML = html;
  if (onClick) { el.style.cursor = 'pointer'; el.addEventListener('click', () => { onClick(); el.remove(); }); }
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

/* ---------------- tooltip ---------------- */
export const tip = {
  show(ev, html) {
    const t = $('#tooltip'); t.innerHTML = html; t.hidden = false;
    let x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + t.offsetWidth > innerWidth - 8) x = ev.clientX - t.offsetWidth - 14;
    if (y + t.offsetHeight > innerHeight - 8) y = Math.max(4, ev.clientY - t.offsetHeight - 14);
    t.style.left = `${x}px`; t.style.top = `${y}px`;
  },
  hide() { $('#tooltip').hidden = true; },
};
