// News: RSS feeds from config/sources.json merged per lane, de-duplicated by
// normalised title, newest first. Headlines that read like race calls are tagged
// so the "Called" lane and the live feed can surface them.
import { fetchText, pool } from '../http.mjs';
import { parseRSS } from '../rss.mjs';

// past-tense outcomes only; hedged headlines ("aims to flip", "a chance to win") are not calls
const CALL_RE = /\b(wins|won|defeats|defeated|projected winner|re-?elected|concedes|conceded|flips|flipped|declared (?:the )?winner|holds off)\b/i;
const HEDGE_RE = /\b(aims?|chance|could|would|may|might|hopes?|bid|tries|trying|seeks?|poised|expected|predicts?|if|can|will|odds|path|race to|fight)\b|\?/i;
const isCall = (t) => CALL_RE.test(t) && !HEDGE_RE.test(t);
const keyOf = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 12).join(' ');

export async function news(cfg) {
  const feeds = cfg.feeds;
  const res = await pool(feeds, 8, async (f) => parseRSS((await fetchText(f.url, { timeout: 12000 })).text, f.name, f.id));
  const errors = [];
  const items = [];
  res.forEach((r, i) => (r?.error ? errors.push(`${feeds[i].id}: ${r.error}`) : items.push(...r)));
  const laneOf = {};
  for (const [lane, ids] of Object.entries(cfg.lanes || {})) for (const id of ids) (laneOf[id] ||= []).push(lane);
  const seen = new Map();
  for (const it of items) {
    delete it.raw;
    const k = keyOf(it.title);
    const lanes = laneOf[it.feedId] || ['national'];
    if (seen.has(k)) { const prev = seen.get(k); prev.lanes = [...new Set([...prev.lanes, ...lanes])]; continue; }
    it.lanes = [...lanes];
    if (isCall(it.title)) it.lanes.push('called');
    seen.set(k, it);
  }
  const cutoff = Date.now() - 4 * 86400e3; // analysis feeds keep old posts around
  const sorted = [...seen.values()].filter((i) => !i.published || i.published > cutoff).sort((a, b) => (b.published || 0) - (a.published || 0));
  // cap per lane, so high-volume Google News queries cannot crowd out the analysis feeds
  const keep = new Set(), count = {};
  for (const it of sorted) if (it.lanes.some((l) => (count[l] = (count[l] || 0) + 1) <= 80)) keep.add(it);
  const list = sorted.filter((i) => keep.has(i));
  return { fetchedAt: new Date().toISOString(), errors, items: list };
}

export async function trends(cfg) {
  const { text } = await fetchText(cfg.url, { timeout: 10000 });
  const items = parseRSS(text, 'Google Trends').map((i) => {
    const traffic = i.raw.match(/<ht:approx_traffic>([^<]+)</)?.[1] || null;
    const story = i.raw.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '') || null;
    const storyUrl = i.raw.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/)?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, '') || null;
    return { term: i.title, traffic, published: i.published, story, storyUrl };
  });
  return { fetchedAt: new Date().toISOString(), items };
}
