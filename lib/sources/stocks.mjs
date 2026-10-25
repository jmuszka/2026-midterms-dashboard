// Stock market data from CNBC's quote service (free, unauthenticated, real time; the same feed
// cnbc.com uses). Quotes in batches; intraday 1-day charts per symbol, downsampled to 5 minutes.
// Symbols and groups live in config/sources.json → stocks.
import { fetchJSON, pool } from '../http.mjs';

const num = (s) => {
  if (s == null) return null;
  const t = String(s).replace(/[,%+]/g, '').trim();
  if (!t || /^UNCH$/i.test(t)) return 0;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};
// Trading session from the clock, by asset type (CNBC's status field says "open" on weekends).
// US equities: pre 4:00, regular 9:30-16:00, after-hours to 20:00 ET, Mon-Fri. Futures and
// Treasuries: Sunday 18:00 to Friday 17:00 ET with a daily 17:00-18:00 break. Crypto: always.
// Currencies: Sunday 17:00 to Friday 17:00 ET without a daily break.
// Exchange holidays are not modelled (Nov 3 2026 is a normal trading day).
export function session(symbol, type, now = Date.now()) {
  const et = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = et.getDay(), mins = et.getHours() * 60 + et.getMinutes();
  if (/\.CB=$/.test(symbol)) return 'open';
  if (type === 'DERIVATIVE' || type === 'BOND' || type === 'CURRENCY') { // FX: Sunday 17:00 to Friday 17:00 ET, round the clock
    if (type === 'CURRENCY') return day === 6 || (day === 5 && mins >= 17 * 60) || (day === 0 && mins < 17 * 60) ? 'closed' : 'open';
    if (day === 6 || (day === 5 && mins >= 17 * 60) || (day === 0 && mins < 18 * 60)) return 'closed';
    return mins >= 17 * 60 && mins < 18 * 60 ? 'closed' : 'open';
  }
  if (day === 0 || day === 6) return 'closed';
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'open';
  if (type === 'INDEX') return 'closed'; // indexes do not trade outside the session
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return 'pre';
  if (mins >= 16 * 60 && mins < 20 * 60) return 'post';
  return 'closed';
}

export function parseQuotes(body) {
  const list = body?.FormattedQuoteResult?.FormattedQuote || [];
  const out = {};
  for (const q of list) {
    if (!q.symbol || q.code === '1') continue; // code 1 = unknown symbol
    const ext = q.ExtendedMktQuote;
    const extPrice = ext && num(ext.last);
    const last = num(q.last), prev = num(q.previous_day_closing);
    // after-hours/pre-market price when there is one: that is what moves on election night
    const price = extPrice != null && extPrice > 0 ? extPrice : last;
    const change = price != null && prev ? price - prev : num(q.change);
    out[q.symbol] = {
      symbol: q.symbol, name: q.name || q.shortName, type: q.type, price, last, prevClose: prev,
      change, changePct: prev ? (change / prev) * 100 : num(q.change_pct),
      unit: /%$/.test(String(q.last)) ? '%' : '', currency: q.currencyCode || 'USD',
      open: num(q.open), high: num(q.high), low: num(q.low), volume: num(q.volume),
      state: session(q.symbol, q.type), extended: extPrice != null && extPrice > 0 ? ext.type : null,
      time: q.last_timedate || q.last_time || null, yearHigh: num(q.yrhiprice), yearLow: num(q.yrloprice), marketCap: q.mktcapView || null,
    };
  }
  return out;
}

export async function stockQuotes(cfg) {
  const symbols = cfg.groups.flatMap((g) => g.symbols.map((s) => s.s));
  const batches = [];
  for (let i = 0; i < symbols.length; i += 25) batches.push(symbols.slice(i, i + 25));
  const res = await pool(batches, 2, (b) => fetchJSON(`${cfg.quoteUrl}?symbols=${encodeURIComponent(b.join('|'))}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`, { timeout: 12000 }));
  const quotes = {}, errors = [];
  res.forEach((r, i) => (r?.error ? errors.push(`quotes ${batches[i][0]}…: ${r.error}`) : Object.assign(quotes, parseQuotes(r))));
  if (!Object.keys(quotes).length && errors.length) throw new Error(errors.join('; '));
  return { quotes, errors, fetchedAt: new Date().toISOString() };
}

// 1-day bars → [[unix s, close], …] at 5-minute resolution, last 24 hours
export function parseChart(body) {
  const bars = body?.barData?.priceBars || [];
  const cutoff = (bars.length ? bars[bars.length - 1].tradeTimeinMills : 0) - 24 * 3600e3;
  const out = [];
  let lastBucket = -1;
  for (const b of bars) {
    const t = b.tradeTimeinMills;
    if (t < cutoff) continue;
    const bucket = Math.floor(t / 300e3);
    const p = parseFloat(b.close);
    if (!Number.isFinite(p)) continue;
    if (bucket === lastBucket) out[out.length - 1] = [Math.round(t / 1000), p];
    else { out.push([Math.round(t / 1000), p]); lastBucket = bucket; }
  }
  return out;
}
export async function stockCharts(cfg) {
  const symbols = cfg.groups.flatMap((g) => g.symbols.map((s) => s.s));
  const res = await pool(symbols, 4, async (s) => parseChart(await fetchJSON(`${cfg.chartUrl}?symbol=${encodeURIComponent(s)}`, { timeout: 12000 })));
  const series = {}, errors = [];
  res.forEach((r, i) => (r?.error ? errors.push(`${symbols[i]}: ${r.error}`) : (series[symbols[i]] = r)));
  return { series, errors, fetchedAt: new Date().toISOString() };
}
