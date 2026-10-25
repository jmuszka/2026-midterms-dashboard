// Store: where the poller writes snapshots and events, and where read endpoints
// read them. Three backends, chosen from the environment:
//
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  -> Supabase Postgres via PostgREST (db/schema.sql)
//   STORE_FILE=path                            -> one JSON file (local dev; survives restarts)
//   (nothing)                                  -> process memory (each function instance has its own)
//
// Interface: get(key), set(key, value), addEvents(list), events({ since, limit }),
//            addTicks(key, points), ticks(key, sinceIso)
import fs from 'node:fs/promises';

const MAX_EVENTS = 5000, MAX_TICKS = 3000;

function memoryStore(initial = {}, persist = null) {
  const db = { kv: initial.kv || {}, events: initial.events || [], ticks: initial.ticks || {}, seq: initial.seq || 0 };
  let timer = null;
  const flush = () => { if (!persist) return; clearTimeout(timer); timer = setTimeout(() => persist(db).catch((e) => console.error('store flush:', e.message)), 300); };
  return {
    kind: persist ? 'file' : 'memory',
    async get(k) { return db.kv[k] ?? null; },
    async set(k, v) { db.kv[k] = v; flush(); },
    async addEvents(list) {
      for (const e of list) db.events.push({ ...e, id: ++db.seq });
      if (db.events.length > MAX_EVENTS) db.events.splice(0, db.events.length - MAX_EVENTS);
      flush();
      return list.length;
    },
    async events({ since = 0, limit = 300 } = {}) { return db.events.filter((e) => e.id > since).slice(-limit); },
    async addTicks(k, pts) { const a = (db.ticks[k] ||= []); a.push(...pts); if (a.length > MAX_TICKS) a.splice(0, a.length - MAX_TICKS); flush(); },
    async ticks(k, sinceIso) { return (db.ticks[k] || []).filter((x) => !sinceIso || x.t >= sinceIso); },
  };
}

async function fileStore(file) {
  let initial = {};
  try { initial = JSON.parse(await fs.readFile(file, 'utf8')); } catch {}
  return memoryStore(initial, async (db) => { await fs.writeFile(`${file}.tmp`, JSON.stringify(db)); await fs.rename(`${file}.tmp`, file); });
}

function supabaseStore(url, key) {
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  const h = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const req = async (path, init = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...h, ...(init.headers || {}) }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    kind: 'supabase',
    async get(k) { const r = await req(`/kv?key=eq.${encodeURIComponent(k)}&select=value`); return r[0]?.value ?? null; },
    async set(k, v) { await req('/kv', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: k, value: v, updated_at: new Date().toISOString() }) }); },
    async addEvents(list) {
      if (!list.length) return 0;
      await req('/events', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(list.map((e) => ({ t: e.t, type: e.type, race_id: e.raceId || null, chamber: e.chamber || null, state: e.state || null, party: e.party || null, text: e.text, data: e.data || {} }))) });
      return list.length;
    },
    async events({ since = 0, limit = 300 } = {}) {
      const r = await req(`/events?id=gt.${+since || 0}&order=id.desc&limit=${limit}`);
      return r.reverse().map((e) => ({ id: e.id, t: e.t, type: e.type, raceId: e.race_id, chamber: e.chamber, state: e.state, party: e.party, text: e.text, data: e.data }));
    },
    async addTicks(k, pts) { if (pts.length) await req('/ticks', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(pts.map((p) => ({ key: k, t: p.t, v: p.v }))) }); },
    async ticks(k, sinceIso) { return req(`/ticks?key=eq.${encodeURIComponent(k)}${sinceIso ? `&t=gte.${sinceIso}` : ''}&order=t.asc&limit=${MAX_TICKS}&select=t,v`); },
  };
}

let store = null;
export async function getStore() {
  if (store) return store;
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STORE_FILE } = process.env;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) store = supabaseStore(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  else if (STORE_FILE) store = await fileStore(STORE_FILE);
  else store = memoryStore();
  return store;
}
export const shared = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
