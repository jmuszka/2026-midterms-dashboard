// Prediction-market prices for every id in config/markets.json.
// Kalshi and Polymarket are fetched in batches; PredictIt is one JSON blob.
// Output per race/control question: { kalshi: {DEM, GOP, …}, polymarket: {…}, predictit: {…}, avg: {DEM, GOP} }
// where each venue's numbers are renormalised so the parties shown sum to 1.
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
  const out = { control: {}, races: {} };
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
