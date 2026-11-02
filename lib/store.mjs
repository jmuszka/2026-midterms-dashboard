// Store: where the scraper writes snapshots, events and time series, and where read
// endpoints read them. Backends, chosen from the environment:
//
//   SUPABASE_URL + SUPABASE_SECRET_KEY (or legacy SERVICE_ROLE_KEY)      -> read/write (the scraper)
//   SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY (or legacy ANON_KEY) + READ_ONLY=1 -> read only (the site)
//   STORE_FILE=path                             -> one JSON file (local dev; survives restarts)
//   (nothing)                                   -> process memory
//
// READ_ONLY=1 always uses the publishable key, even when the secret key is present in the
// environment (the Vercel Marketplace integration injects both), so the site cannot write.
// Row-level security enforces it too: the publishable/anon role has SELECT only.
//
// Interface (all async):
//   get(k), set(k, v)
//   addEvents(list), events({ since, limit })
//   addTicks(points: [{key,t,v}]), ticks(key, sinceIso), ticksMany(keys, sinceIso) -> {key: [{t,v}]}
//   addRaceTicks(rows), raceTicks({ since, until })
//   addSnapshot(task, t, payload), snapshotAt(task, iso) -> {t, payload} | null (latest at or before), snapshotsSince(task, iso)
//   addNewsItems(items), addPosts(list, posts), addStreamTicks(rows)   (duplicates ignored)
//   beat(row), lastBeat(), firstBeat()
//   ticksSince(iso, keyPrefix?), eventsSince(iso), newsSince(iso), postsSince(iso), streamTicksSince(iso)   (timeline bundle)
//   addStreamVideos(rows) (upsert), streamVideos()                                             (stream replay)
import fs from 'node:fs/promises';

const MAX_EVENTS = 5000, MAX_TICKS = 3000;
export const READ_ONLY = process.env.READ_ONLY === '1' || process.env.READ_ONLY === 'true';

const readOnlyGuard = (store) => {
  for (const k of Object.keys(store)) {
    if (/^(set|add|beat)/.test(k) && typeof store[k] === 'function') store[k] = async () => { throw new Error(`store is read-only (READ_ONLY=1): ${k} refused`); };
  }
  store.readOnly = true;
  return store;
};

function memoryStore(initial = {}, persist = null) {
  const db = { kv: {}, events: [], ticks: {}, seq: 0, raceTicks: [], snapshots: [], news: {}, posts: {}, streamTicks: [], beats: [], ...initial };
  let timer = null;
  const flush = () => { if (!persist) return; clearTimeout(timer); timer = setTimeout(() => persist(db).catch((e) => console.error('store flush:', e.message)), 300); };
  const cap = (a, n) => { if (a.length > n) a.splice(0, a.length - n); };
  return {
    kind: persist ? 'file' : 'memory',
    async get(k) { return db.kv[k] ?? null; },
    async set(k, v) { db.kv[k] = v; flush(); },
    async addEvents(list) {
      for (const e of list) db.events.push({ ...e, id: ++db.seq });
      cap(db.events, MAX_EVENTS); flush();
      return list.length;
    },
    async events({ since = 0, limit = 300 } = {}) { return db.events.filter((e) => e.id > since).slice(-limit); },
    async addTicks(points) { for (const p of points) { const a = (db.ticks[p.key] ||= []); a.push({ t: p.t, v: p.v }); cap(a, MAX_TICKS); } flush(); },
    async ticks(k, sinceIso) { return (db.ticks[k] || []).filter((x) => !sinceIso || x.t >= sinceIso); },
    async ticksMany(keys, sinceIso) { return Object.fromEntries(keys.map((k) => [k, (db.ticks[k] || []).filter((x) => !sinceIso || x.t >= sinceIso)])); },
    async addRaceTicks(rows) { db.raceTicks.push(...rows); cap(db.raceTicks, 200000); flush(); return rows.length; },
    async raceTicks({ since, until } = {}) { return db.raceTicks.filter((r) => (!since || r.t > since) && (!until || r.t <= until)); },
    async ticksSince(since, prefix = '') { return Object.entries(db.ticks).filter(([key]) => key.startsWith(prefix)).flatMap(([key, a]) => a.filter((x) => !since || x.t > since).map((x) => ({ key, ...x }))).sort((a, b) => a.t.localeCompare(b.t)); },
    async eventsSince(since) { return db.events.filter((e) => !since || e.t > since); },
    async newsSince(since) { return Object.values(db.news).filter((i) => !since || i.first_seen > since).sort((a, b) => a.first_seen.localeCompare(b.first_seen)); },
    async postsSince(since) { return Object.values(db.posts).filter((p) => !since || p.firstSeen > since).map((p) => ({ list: p.list, first_seen: p.firstSeen, payload: p })); },
    async streamTicksSince(since) { return db.streamTicks.filter((r) => !since || r.t > since); },
    async firstBeat() { return db.beats[0] || null; },
    async addStreamVideos(rows) { db.videos ||= {}; for (const r of rows) db.videos[r.video_id] = { ...(db.videos[r.video_id] || {}), ...r }; flush(); return rows.length; },
    async streamVideos() { return Object.values(db.videos || {}); },
    async addSnapshot(task, t, payload) { db.snapshots.push({ task, t, payload }); cap(db.snapshots, 5000); flush(); },
    async snapshotAt(task, at) { return db.snapshots.filter((x) => x.task === task && (!at || x.t <= at)).sort((a, b) => a.t.localeCompare(b.t)).pop() || null; },
    async snapshotsSince(task, since) { return db.snapshots.filter((x) => x.task === task && (!since || x.t > since)).sort((a, b) => a.t.localeCompare(b.t)); },
    async addNewsItems(items) { let n = 0; for (const i of items) if (!db.news[i.link]) { db.news[i.link] = i; n++; } flush(); return n; },
    async addPosts(list, posts) { let n = 0; for (const p of posts) if (!db.posts[p.id]) { db.posts[p.id] = { list, ...p }; n++; } flush(); return n; },
    async addStreamTicks(rows) { db.streamTicks.push(...rows); flush(); return rows.length; },
    async beat(row) { db.beats.push(row); cap(db.beats, 2000); flush(); },
    async lastBeat() { return db.beats[db.beats.length - 1] || null; },
  };
}

async function fileStore(file) {
  let initial = {};
  try { initial = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  return memoryStore(initial, async (db) => { await fs.writeFile(`${file}.tmp`, JSON.stringify(db)); await fs.rename(`${file}.tmp`, file); });
}

function supabaseStore(url, key) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  // new-style sb_publishable_/sb_secret_ keys go in apikey only (they are not JWTs); legacy JWT keys also as Bearer
  const h = { apikey: key, 'content-type': 'application/json', ...(key.startsWith('sb_') ? {} : { authorization: `Bearer ${key}` }) };
  const req = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...h, ...(init.headers || {}) }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`supabase ${res.status} ${path.split('?')[0]}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };
  const insert = (table, rows, { ignoreDuplicates = false, upsert = false } = {}) => {
    if (!rows.length) return Promise.resolve(0);
    const prefer = ['return=minimal', ignoreDuplicates ? 'resolution=ignore-duplicates' : upsert ? 'resolution=merge-duplicates' : null].filter(Boolean).join(',');
    return req(`/${table}`, { method: 'POST', headers: { prefer }, body: JSON.stringify(rows) }).then(() => rows.length);
  };
  // PostgREST caps every response at 1,000 rows (the project's max-rows), whatever limit is asked
  // for, so anything that can exceed that is read in pages. `order` must end on a unique column.
  const PAGE = 1000;
  const pageAll = async (pathAndQuery) => {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const rows = await req(`${pathAndQuery}&limit=${PAGE}&offset=${offset}`);
      out.push(...rows);
      if (rows.length < PAGE) return out;
    }
  };
  const chunked = async (rows, n, fn) => { for (let i = 0; i < rows.length; i += n) await fn(rows.slice(i, i + n)); return rows.length; };
  const inList = (keys) => `(${keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})`;
  return {
    kind: 'supabase',
    async get(k) { const r = await req(`/kv?key=eq.${encodeURIComponent(k)}&select=value`); return r[0]?.value ?? null; },
    async set(k, v) { await insert('kv', [{ key: k, value: v, updated_at: new Date().toISOString() }], { upsert: true }); },
    async addEvents(list) {
      return insert('events', list.map((e) => ({ t: e.t, type: e.type, race_id: e.raceId || null, chamber: e.chamber || null, state: e.state || null, party: e.party || null, text: e.text, data: e.data || {} })));
    },
    async events({ since = 0, limit = 300 } = {}) {
      const r = await req(`/events?id=gt.${+since || 0}&order=id.desc&limit=${limit}`);
      return r.reverse().map((e) => ({ id: e.id, t: e.t, type: e.type, raceId: e.race_id, chamber: e.chamber, state: e.state, party: e.party, text: e.text, data: e.data }));
    },
    async addTicks(points) { return chunked(points, 1000, (c) => insert('ticks', c.map((p) => ({ key: p.key, t: p.t, v: p.v })), { ignoreDuplicates: true })); },
    async ticks(k, sinceIso) { return req(`/ticks?key=eq.${encodeURIComponent(k)}${sinceIso ? `&t=gte.${sinceIso}` : ''}&order=t.asc&limit=${MAX_TICKS}&select=t,v`); },
    async ticksMany(keys, sinceIso) {
      const out = Object.fromEntries(keys.map((k) => [k, []]));
      for (let i = 0; i < keys.length; i += 80) {
        const rows = await pageAll(`/ticks?key=in.${encodeURIComponent(inList(keys.slice(i, i + 80)))}${sinceIso ? `&t=gte.${sinceIso}` : ''}&order=t.asc,key.asc&select=key,t,v`);
        for (const r of rows) out[r.key]?.push({ t: r.t, v: r.v });
      }
      return out;
    },
    async addRaceTicks(rows) { return chunked(rows, 500, (c) => insert('race_ticks', c, { ignoreDuplicates: true })); },
    async raceTicks({ since, until } = {}) { return pageAll(`/race_ticks?select=*${since ? `&t=gt.${since}` : ''}${until ? `&t=lte.${until}` : ''}&order=t.asc,race_id.asc`); },
    async ticksSince(since, prefix = '') { return pageAll(`/ticks?select=key,t,v${prefix ? `&key=like.${encodeURIComponent(prefix)}*` : ''}${since ? `&t=gt.${since}` : ''}&order=t.asc,key.asc`); },
    async eventsSince(since) {
      const r = await pageAll(`/events?select=*${since ? `&t=gt.${since}` : ''}&order=id.asc`);
      return r.map((e) => ({ id: e.id, t: e.t, type: e.type, raceId: e.race_id, chamber: e.chamber, state: e.state, party: e.party, text: e.text, data: e.data }));
    },
    async newsSince(since) { return pageAll(`/news_items?select=*${since ? `&first_seen=gt.${since}` : ''}&order=first_seen.asc,link.asc`); },
    async postsSince(since) { return pageAll(`/posts?select=list,first_seen,payload${since ? `&first_seen=gt.${since}` : ''}&order=first_seen.asc,id.asc`); },
    async streamTicksSince(since) { return pageAll(`/stream_ticks?select=*${since ? `&t=gt.${since}` : ''}&order=t.asc,stream_id.asc`); },
    async firstBeat() { const r = await req('/heartbeat?order=t.asc&limit=1'); return r[0] || null; },
    async addStreamVideos(rows) { return insert('stream_videos', rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })), { upsert: true }); },
    async streamVideos() { return pageAll('/stream_videos?select=*&order=video_id.asc'); },
    async addSnapshot(task, t, payload) { await insert('snapshots', [{ task, t, payload }], { ignoreDuplicates: true }); },
    async snapshotAt(task, at) { const r = await req(`/snapshots?task=eq.${encodeURIComponent(task)}${at ? `&t=lte.${at}` : ''}&order=t.desc&limit=1&select=t,payload`); return r[0] || null; },
    async snapshotsSince(task, since) { return pageAll(`/snapshots?task=eq.${encodeURIComponent(task)}${since ? `&t=gt.${since}` : ''}&order=t.asc&select=t,payload`); },
    async addNewsItems(items) { return chunked(items, 500, (c) => insert('news_items', c, { ignoreDuplicates: true })); },
    async addPosts(list, posts) { return chunked(posts, 500, (c) => insert('posts', c.map((p) => ({ id: p.id, list, created_at: p.createdAt || null, first_seen: p.firstSeen, payload: p })), { ignoreDuplicates: true })); },
    async addStreamTicks(rows) { return insert('stream_ticks', rows, { ignoreDuplicates: true }); },
    async beat(row) { await insert('heartbeat', [row]); },
    async lastBeat() { const r = await req('/heartbeat?order=t.desc&limit=1'); return r[0] || null; },
  };
}

let store = null;
export async function getStore() {
  if (store) return store;
  const { SUPABASE_URL, STORE_FILE } = process.env;
  const readKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const writeKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (SUPABASE_URL && READ_ONLY && readKey) store = readOnlyGuard(supabaseStore(SUPABASE_URL, readKey));
  else if (SUPABASE_URL && !READ_ONLY && writeKey) store = supabaseStore(SUPABASE_URL, writeKey);
  else if (STORE_FILE) store = await fileStore(STORE_FILE);
  else store = memoryStore();
  if (READ_ONLY && !store.readOnly) readOnlyGuard(store);
  return store;
}
export const shared = () => !!process.env.SUPABASE_URL && !!(READ_ONLY ? process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY : process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);
export const _memoryStore = memoryStore; // tests
