// One router for both the local server (server.mjs) and the Vercel function
// (api/[route].mjs). Each route returns { status, body, cache } where cache is the
// CDN freshness in seconds (0 = no-store). With s-maxage + stale-while-revalidate,
// every viewer shares one upstream fetch per window.
import { createRequire } from 'node:module';
import { snapshot, events, pollCloseEvents, ticks, runPoll, scraperStatus, MANIFEST, SOURCES, TASKS } from './poll.mjs';
import { cnnCounties } from './sources/results.mjs';
import { getArticle } from './article.mjs';
import { PARTIES, STATES } from './model.mjs';
import { shared, READ_ONLY } from './store.mjs';
import { simulate, simulateSeries } from './sim.mjs';
import { bundleFromStore, bundleFromSim } from './timeline.mjs';
import { getStore } from './store.mjs';

const require = createRequire(import.meta.url);
const PRESETS = require('../config/presets.json');
const RACES_DOC = require('../config/races.json');

const ok = (body, cache) => ({ status: 200, body, cache });

// ?sim=<speed> (1 = default 30x) and optional simAt=<minutes after 17:45 ET> pin the clock
async function sim(req) {
  const v = req.query.get('sim');
  if (!v || v === '0') return null;
  const mk = await snapshot('markets').catch(() => null);
  const speed = Math.min(600, Math.max(1, +v > 1 ? +v : 30));
  return simulate(RACES_DOC.races, mk, { speed, offsetMin: +req.query.get('simAt') || 0, seed: req.query.get('seed') || 'nov3' });
}
const bad = (status, error) => ({ status, body: { ok: false, error }, cache: 0 });

function publicConfig() {
  return {
    electionDay: '2026-11-03', timezone: 'America/New_York',
    parties: PARTIES.parties.map(({ match, ...p }) => p),
    states: STATES,
    balance: SOURCES.balance,
    streams: SOURCES.streams.list,
    stocks: { groups: SOURCES.stocks.groups },
    news: { lanes: Object.keys(SOURCES.news.lanes).concat('called') },
    social: Object.fromEntries(Object.entries(SOURCES.social.lists).map(([id, l]) => [id, { name: l.name, accounts: l.accounts.map(({ platform, handle, name }) => ({ platform, handle, name })) }])),
    attribution: { cnn: SOURCES.results.cnn.attribution, states: SOURCES.results.states.map((s) => ({ id: s.id, state: s.state, name: s.attribution })) },
    presets: Object.fromEntries(Object.entries(PRESETS).filter(([k]) => !k.startsWith('_'))),
    store: shared() ? 'shared' : 'instance',
    readOnly: READ_ONLY,
    // Realtime nudge (docs/SCRUBBER.md §0a): the publishable key is meant to be public and RLS limits it to SELECT
    realtime: READ_ONLY && process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY ? { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY, table: 'heartbeat' } : null,
  };
}

async function authorised(req) {
  const secret = process.env.POLL_SECRET || process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production' && !process.env.VERCEL; // open locally, closed in production without a secret
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}` || req.query.get('key') === secret;
}

export const ROUTES = {
  config: async () => ok(publicConfig(), 300),
  status: async () => ok({ scraper: await scraperStatus(), readOnly: READ_ONLY, now: new Date().toISOString() }, 5),
  manifest: async () => ok({ generatedAt: RACES_DOC.generatedAt, races: RACES_DOC.races }, 3600),
  results: async (req) => {
    const S = await sim(req);
    if (S) return ok({ races: S.races, simulated: true, simTime: S.simTime, speed: S.speed, sources: [{ source: 'sim' }] }, 10);
    const [s, scraper] = await Promise.all([snapshot('results'), scraperStatus()]);
    return ok({ races: s.races, sources: s.sources, ranAt: s.ranAt, age: s.age, stale: !!s.stale, scraper }, READ_ONLY ? 10 : 15);
  },
  events: async (req) => {
    const since = +req.query.get('since') || 0;
    const S = await sim(req);
    if (S) return ok({ events: S.events.filter((e) => e.id > since).slice(-400), pollCloses: pollCloseEvents(Date.parse(S.simTime)), now: S.simTime, simulated: true }, 10);
    const list = await events({ since, limit: 400 });
    return ok({ events: list, pollCloses: pollCloseEvents(), now: new Date().toISOString() }, 10);
  },
  markets: async (req) => {
    const s = await snapshot('markets');
    const body = { control: s.control, races: s.races, meta: s.meta, ranAt: s.ranAt, stale: !!s.stale };
    if (req.query.get('ticks')) body.ticks = await ticks(['control:S', 'control:H'], new Date(Date.now() - 48 * 3600e3).toISOString());
    return ok(body, 30);
  },
  // the scrubber's data: everything recorded, or only what is newer than ?since=<iso>
  timeline: async (req) => {
    const since = req.query.get('since') || null;
    if (since && !Number.isFinite(Date.parse(since))) return bad(400, 'since must be an ISO time');
    const v = req.query.get('sim');
    if (v && v !== '0') {
      const mk = await snapshot('markets').catch(() => null);
      const opts = { speed: Math.min(600, Math.max(1, +v > 1 ? +v : 30)), offsetMin: +req.query.get('simAt') || 0, seed: req.query.get('seed') || 'nov3' };
      const S = simulate(RACES_DOC.races, mk, opts);
      return ok(bundleFromSim(simulateSeries(RACES_DOC.races, mk, opts), S.events, { since }), 10);
    }
    const [store, beat] = await Promise.all([getStore(), scraperStatus()]);
    return ok(await bundleFromStore(store, { since, lastBeat: beat?.t ? beat : null }), 15);
  },
  stocks: async () => {
    const [q, c] = await Promise.all([snapshot('stocks'), snapshot('stockcharts').catch(() => null)]);
    return ok({ quotes: q.quotes, series: c?.series || {}, errors: [...(q.errors || []), ...(c?.errors || [])], ranAt: q.ranAt, stale: !!q.stale }, 15);
  },
  streams: async () => { const s = await snapshot('streams'); return ok({ streams: s.streams, ranAt: s.ranAt }, 60); },
  social: async (req) => {
    const id = req.query.get('list') || 'analysts';
    if (!TASKS[`social:${id}`]) return bad(404, `unknown list ${id}`);
    const s = await snapshot(`social:${id}`);
    return ok({ id, name: s.name, posts: s.posts, errors: s.errors, ranAt: s.ranAt, stale: !!s.stale }, 45);
  },
  news: async (req) => {
    const lane = req.query.get('lane');
    const s = await snapshot('news');
    const items = lane && lane !== 'all' ? s.items.filter((i) => i.lanes.includes(lane)) : s.items;
    return ok({ items, errors: s.errors, ranAt: s.ranAt, fetchedAt: s.fetchedAt }, 60);
  },
  trends: async () => { const s = await snapshot('trends'); return ok({ items: s.items, ranAt: s.ranAt }, 300); },
  counties: async (req) => {
    const id = req.query.get('race');
    if (!MANIFEST[id]) return bad(404, 'unknown race');
    const s = await snapshot('results');
    const key = s.races?.[id]?.countyKey;
    if (!key) return ok({ race: id, counties: [], note: 'county results not available yet' }, 60);
    return ok({ race: id, counties: await cnnCounties(SOURCES.results.cnn.base, key) }, 30);
  },
  article: async (req) => {
    const url = req.query.get('url');
    if (!url) return bad(400, 'Missing url');
    try { return ok(await getArticle(url), 900); }
    catch (e) { return { status: e.status || 502, body: { ok: false, url, error: e.message }, cache: 0 }; }
  },
  poll: async (req) => {
    if (READ_ONLY) return bad(403, 'this site is read-only: data is written by the scraper (scripts/scraper.mjs)');
    if (!(await authorised(req))) return bad(401, 'unauthorised: send Authorization: Bearer $POLL_SECRET');
    const only = req.query.get('only')?.split(',').filter(Boolean);
    return ok(await runPoll({ only, force: !!req.query.get('force') }), 0);
  },
};

// req: { route, query: URLSearchParams, headers }
export async function handle(req) {
  const fn = ROUTES[req.route];
  if (!fn) return bad(404, `no route ${req.route}`);
  try { return await fn(req); }
  catch (e) { if (!e.status) console.error(`[api ${req.route}]`, e); return { status: e.status || 502, body: { ok: false, error: e.message }, cache: e.status === 503 ? 5 : 0 }; }
}
export const cacheHeader = (s) => (s ? `public, max-age=0, s-maxage=${s}, stale-while-revalidate=${s * 5}` : 'no-store');
