// Prediction-market prices for every id in config/markets.json.
// Kalshi and Polymarket are fetched in batches; PredictIt is one JSON blob.
// Output per race/control question: { kalshi: {DEM, GOP, …}, polymarket: {…}, predictit: {…}, avg: {DEM, GOP} }
// where each venue's numbers are renormalised so the parties shown sum to 1.
// Also non-race Polymarket questions (config/sources.json markets.topics): raw Yes prices, not renormalised.
import { createRequire } from 'node:module';
import { fetchJSON, pool } from '../http.mjs';

const require = createRequire(import.meta.url);
const MAP = require('../../config/markets.json');

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const mid = (bid, ask, last) => {
  const b = parseFloat(bid), a = parseFloat(ask), l = parseFloat(last);
  if (b > 0 && a > 0 && a >= b && a - b <= 0.15) return (a + b) / 2; // wide spreads on thin House markets: use last trade
  return Number.isFinite(l) && l > 0 ? l : Number.isFinite(b) && b > 0 ? b : null;
};

function entries(map) { // yields [key, venue, entry] for control questions and races
  const out = [];
  for (const [k, v] of Object.entries(map.control)) for (const [venue, list] of Object.entries(v)) for (const e of list) out.push([`control:${k}`, venue, e]);
  for (const [k, v] of Object.entries(map.races)) for (const [venue, list] of Object.entries(v)) for (const e of list) out.push([k, venue, e]);
  return out;
}

// Polymarket events (Gamma /events?slug=…) -> topic groups: [{ id, name, note, events: [{ slug, title, exclusive, closed, outcomes: [{ id, label, p, d1, closed }] }] }]
// `exclusive` (negRisk): one outcome wins, so outcomes are ranked by price. Otherwise each line is its own
// Yes/No question (date ladders, country lists): expired rungs are dropped while any rung is open.
export function parseTopics(events, groups) {
  const bySlug = new Map((events || []).map((e) => [e.slug, e]));
  return (groups || []).map((g) => ({ id: g.id, name: g.name, note: g.note || '', events: g.events.map((slug) => {
    const e = bySlug.get(slug);
    if (!e) return null;
    const priced = (e.markets || []).filter((m) => m.outcomePrices && m.active !== false);
    const open = priced.filter((m) => !m.closed);
    const list = open.length ? open : priced; // a resolved event keeps its result
    const outcomes = [];
    for (const m of list) {
      let names = [], prices = [];
      try { names = JSON.parse(m.outcomes); prices = JSON.parse(m.outcomePrices).map(parseFloat); } catch { continue; }
      const p = m.closed ? prices[0] : mid(m.bestBid, m.bestAsk, m.lastTradePrice) ?? prices[0];
      if (!Number.isFinite(p)) continue;
      const d1 = m.closed || m.oneDayPriceChange == null ? null : +m.oneDayPriceChange;
      const label = (m.groupItemTitle || '').trim();
      if (list.length === 1 && !(names[0] === 'Yes' && names[1] === 'No') && names.length === 2) { // a two-sided question ("Bibi" / "Opp.")
        outcomes.push({ id: String(m.id), label: names[0], p, d1, closed: !!m.closed }, { id: `${m.id}:1`, label: names[1], p: Math.round((1 - p) * 1e4) / 1e4, d1: d1 == null ? null : -d1, closed: !!m.closed });
      } else outcomes.push({ id: String(m.id), label: label || 'Yes', p, d1, closed: !!m.closed, end: m.endDate || null });
    }
    if (e.negRisk) outcomes.sort((a, b) => b.p - a.p);
    else if (outcomes.length > 1 && outcomes[0].end) outcomes.sort((a, b) => (a.end || '').localeCompare(b.end || '') || b.p - a.p);
    for (const o of outcomes) delete o.end;
    return { slug, title: e.title, exclusive: !!e.negRisk, closed: !!e.closed, volume: Math.round(parseFloat(e.volume) || 0), endDate: e.endDate || null, outcomes };
  }).filter((e) => e && e.outcomes.length) }));
}
async function topics(cfg, errors) {
  const groups = cfg.topics || [];
  const slugs = [...new Set(groups.flatMap((g) => g.events))];
  if (!slugs.length) return [];
  const res = await pool(chunk(slugs, 20), 2, async (batch) => fetchJSON(`${cfg.polymarket || 'https://gamma-api.polymarket.com'}/events?limit=50&${batch.map((s) => `slug=${encodeURIComponent(s)}`).join('&')}`));
  const events = [];
  for (const r of res) { if (r?.error) errors.push(`polymarket topics: ${r.error}`); else events.push(...r); }
  const missing = slugs.filter((s) => !events.some((e) => e.slug === s));
  if (missing.length && events.length) errors.push(`polymarket topics: not found ${missing.join(', ')}`);
  return parseTopics(events, groups);
}

export async function markets(cfg = {}) {
  const all = entries(MAP);
  const errors = [];
  const kalshiBase = cfg.kalshi || 'https://api.elections.kalshi.com/trade-api/v2';
  const gammaBase = cfg.polymarket || 'https://gamma-api.polymarket.com';

  // Kalshi: /markets?tickers=a,b,c (100 per call)
  const kTickers = [...new Set(all.filter(([, v]) => v === 'kalshi').map(([, , e]) => e.ticker))];
  const kPrice = new Map();
  const kRes = await pool(chunk(kTickers, 100), 3, async (batch) => (await fetchJSON(`${kalshiBase}/markets?limit=100&tickers=${batch.join(',')}`)).markets || []);
  for (const r of kRes) {
    if (r?.error) { errors.push(`kalshi: ${r.error}`); continue; }
    for (const m of r) kPrice.set(m.ticker, { p: mid(m.yes_bid_dollars, m.yes_ask_dollars, m.last_price_dollars), vol: parseFloat(m.volume_fp) || 0, status: m.status, result: m.result || null });
  }

  // Polymarket Gamma: /markets?id=1&id=2 (50 per call)
  const pIds = [...new Set(all.filter(([, v]) => v === 'polymarket').map(([, , e]) => e.id))];
  const pPrice = new Map();
  const pRes = await pool(chunk(pIds, 50), 4, async (batch) => fetchJSON(`${gammaBase}/markets?limit=50&${batch.map((id) => `id=${id}`).join('&')}`));
  for (const r of pRes) {
    if (r?.error) { errors.push(`polymarket: ${r.error}`); continue; }
    for (const m of r) {
      let p = mid(m.bestBid, m.bestAsk, m.lastTradePrice);
      if (p == null) { try { p = parseFloat(JSON.parse(m.outcomePrices)[0]); } catch {} }
      pPrice.set(String(m.id), { p, vol: parseFloat(m.volume) || 0, status: m.closed ? 'closed' : 'active' });
    }
  }

  // PredictIt: everything in one call
  const piPrice = new Map();
  try {
    const pi = await fetchJSON(cfg.predictit || 'https://www.predictit.org/api/marketdata/all/');
    for (const mk of pi.markets) for (const c of mk.contracts) piPrice.set(c.id, { p: c.lastTradePrice ?? c.bestBuyYesCost ?? null });
  } catch (e) { errors.push(`predictit: ${e.message}`); }

  // assemble
  const raw = {}; // key -> venue -> party -> price
  const put = (key, venue, party, price) => {
    if (!party || price == null || !Number.isFinite(price)) return;
    const v = ((raw[key] ||= {})[venue] ||= {});
    v[party] = Math.max(v[party] || 0, price); // two contracts for one party (rare): keep the higher
  };
  for (const [key, venue, e] of all) {
    if (venue === 'kalshi') put(key, venue, e.party, kPrice.get(e.ticker)?.p);
    else if (venue === 'polymarket') put(key, venue, e.party, pPrice.get(String(e.id))?.p);
    else if (venue === 'predictit') for (const c of e.contracts || []) put(key, venue, c.party, piPrice.get(c.id)?.p);
  }
  const out = { control: {}, races: {}, topics: await topics(cfg, errors).catch((e) => (errors.push(`polymarket topics: ${e.message}`), [])) };
  for (const [key, venues] of Object.entries(raw)) {
    const norm = {};
    const sum = { }; let n = 0;
    for (const [venue, parties] of Object.entries(venues)) {
      const tot = Object.values(parties).reduce((s, x) => s + x, 0);
      if (!tot) continue;
      norm[venue] = Object.fromEntries(Object.entries(parties).map(([p, x]) => [p, Math.round((x / tot) * 1000) / 1000]));
      for (const [p, x] of Object.entries(norm[venue])) sum[p] = (sum[p] || 0) + x;
      n++;
    }
    if (!n) continue;
    norm.avg = Object.fromEntries(Object.entries(sum).map(([p, x]) => [p, Math.round((x / n) * 1000) / 1000]));
    if (key.startsWith('control:')) out.control[key.slice(8)] = norm; else out.races[key] = norm;
  }
  return { ...out, meta: { source: 'markets', errors, kalshi: kPrice.size, polymarket: pPrice.size, predictit: piPrice.size }, fetchedAt: new Date().toISOString() };
}
