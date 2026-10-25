// Shared feed logic for the local server (server.mjs) and Vercel functions (api/*.mjs).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const config = require('../config.json');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ---------- small cache with stale-on-error ----------
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const entry = cache.get(key) || {};
  if (entry.value && entry.expires > now) return entry.value;
  if (entry.promise) return entry.promise;
  entry.promise = (async () => {
    try {
      const value = await fn();
      cache.set(key, { value, expires: Date.now() + ttlMs, fetchedAt: Date.now() });
      return value;
    } catch (err) {
      console.error(`[${key}] refresh failed:`, err.message);
      if (entry.value) {
        cache.set(key, { value: { ...entry.value, stale: true, error: err.message }, expires: Date.now() + 15000 });
        return cache.get(key).value;
      }
      throw err;
    }
  })();
  cache.set(key, entry);
  return entry.promise;
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml,text/csv,*/*;q=0.8', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 15000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return { text: await res.text(), headers: res.headers };
}

// ---------- CSV ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---------- Elections BC results ----------
const partyIndex = new Map();
for (const p of config.parties) for (const m of p.match || []) partyIndex.set(m.toLowerCase(), p.id);
function partyId(affiliation) {
  const key = (affiliation || '').trim().toLowerCase();
  if (partyIndex.has(key)) return partyIndex.get(key);
  if (key === '') return 'IND';
  return 'OTH';
}
const toInt = (s) => parseInt(String(s).replace(/[^0-9-]/g, ''), 10) || 0;
function parseOf(s) {
  // "25 of 80 (Not Verified)" / "4 of 5 reported (Not Verified)"
  const m = String(s || '').match(/(\d+)\s+of\s+(\d+)/i);
  return { reported: m ? +m[1] : 0, total: m ? +m[2] : 0, verified: !/not verified/i.test(s || '') };
}

function callRiding(d) {
  const [a, b] = d.candidates;
  const V = d.candidates.reduce((s, c) => s + c.votes, 0);
  const frac = d.boxes.total ? d.boxes.reported / d.boxes.total : 0;
  if (!a || V === 0 || d.boxes.reported === 0) return { status: 'none', frac, leader: null };
  const lead = a.votes - (b ? b.votes : 0);
  const marginPct = (lead / V) * 100;
  if (lead <= 0) return { status: 'tied', frac, leader: null, marginPct: 0 };
  const complete = frac >= 1 || !/in progress/i.test(d.status || 'In Progress');
  if (complete) return { status: 'elected', basis: 'complete', frac, leader: a.party, marginPct };
  const remaining = (V / d.boxes.reported) * (d.boxes.total - d.boxes.reported);
  const needShare = remaining > 0 ? (lead / remaining + 1) / 2 : 1; // share of remaining votes runner-up needs
  const P = config.projection || {};
  const projected = (frac >= (P.minFracForNeedShare ?? 0.25) && needShare > (P.needShare ?? 0.8))
    || (P.rules || [{ minFrac: 0.6, minMargin: 10 }, { minFrac: 0.85, minMargin: 4 }]).some((r) => frac >= r.minFrac && marginPct >= r.minMargin);
  return { status: projected ? 'elected' : 'leading', basis: projected ? 'projected' : null, frac, leader: a.party, marginPct, needShare };
}

function buildResults(candRows, lastModified) {
  const ridings = new Map();
  for (const r of candRows) {
    const code = r['Electoral District Code'];
    if (!code) continue;
    let d = ridings.get(code);
    if (!d) {
      d = {
        code,
        name: r['Electoral District Name'],
        candidates: [],
        rejected: 0,
        boxes: parseOf(r['In-district Ballot Box count']),
        advance: parseOf(r['AdvanceTotals']),
        finalDay: parseOf(r['FinalTotals']),
        status: r['Initial Count Status'],
        asOf: `${r.Date} ${r.Time}`,
      };
      ridings.set(code, d);
    }
    const name = r["Candidate's Ballot Name"];
    const votes = toInt(r['Total Valid Votes']);
    if (/^rejected ballots$/i.test(name)) { d.rejected = votes; continue; }
    d.candidates.push({ name, affiliation: r.Affiliation, party: partyId(r.Affiliation), votes, pct: parseFloat(r['% of Popular Vote']) || 0 });
  }
  const parties = Object.fromEntries(config.parties.map((p) => [p.id, { id: p.id, elected: 0, leading: 0, votes: 0, candidates: 0 }]));
  let totalVotes = 0, boxesReported = 0, boxesTotal = 0, reportingRidings = 0, completeRidings = 0;
  const list = [];
  for (const d of ridings.values()) {
    d.candidates.sort((x, y) => y.votes - x.votes);
    d.totalValid = d.candidates.reduce((s, c) => s + c.votes, 0);
    d.call = callRiding(d);
    totalVotes += d.totalValid;
    boxesReported += d.boxes.reported; boxesTotal += d.boxes.total;
    if (d.boxes.reported > 0) reportingRidings++;
    if (d.call.basis === 'complete') completeRidings++;
    for (const c of d.candidates) { parties[c.party].votes += c.votes; parties[c.party].candidates++; }
    if (d.call.leader) parties[d.call.leader][d.call.status === 'elected' ? 'elected' : 'leading']++;
    list.push(d);
  }
  list.sort((x, y) => x.name.localeCompare(y.name));
  for (const p of Object.values(parties)) p.pct = totalVotes ? (p.votes / totalVotes) * 100 : 0;
  return {
    source: 'Elections BC — initial count (preliminary, unverified)',
    lastModified: lastModified || null,
    asOf: list[0]?.asOf || null,
    fetchedAt: new Date().toISOString(),
    summary: { seats: config.seats, majority: config.majority, totalVotes, boxesReported, boxesTotal, reportingRidings, completeRidings, ridings: list.length },
    parties,
    ridings: list,
  };
}

export async function getResults() {
  return cached('results', (config.resultsRefreshSeconds || 60) * 1000 - 2000, async () => {
    const url = `${config.electionsBC.base}/${config.electionsBC.eventPrefix}_Candidate.csv`;
    const { text, headers } = await fetchText(url);
    return buildResults(parseCSV(text), headers.get('last-modified'));
  });
}

// ---------- RSS / news ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e.toLowerCase()] ?? m;
  });
}
const stripTags = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
function tag(x, name) {
  const m = x.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decode(stripTags(m[1])) : '';
}
function parseRSS(xml, feedName) {
  const items = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const isGoogle = /google/i.test(feedName);
  return items.map((x) => {
    let title = tag(x, 'title');
    const source = tag(x, 'source') || feedName;
    if (isGoogle && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    let link = tag(x, 'link');
    if (!link) { const m = x.match(/<link\b[^>]*href="([^"]+)"/i); link = m ? decode(m[1]) : ''; }
    const published = Date.parse(tag(x, 'pubDate') || tag(x, 'dc:date') || tag(x, 'published')) || null;
    const description = isGoogle ? '' : tag(x, 'description').slice(0, 280);
    return { title, link, source, feed: feedName, published, description };
  }).filter((i) => i.title && i.link);
}
export async function getNews() {
  return cached('news', (config.news.refreshSeconds || 120) * 1000, async () => {
    const settled = await Promise.allSettled(config.news.feeds.map(async (f) => parseRSS((await fetchText(f.url)).text, f.name)));
    const errors = [];
    const items = [];
    settled.forEach((s, i) => (s.status === 'fulfilled' ? items.push(...s.value) : errors.push(`${config.news.feeds[i].name}: ${s.reason.message}`)));
    if (!items.length && errors.length) throw new Error(errors.join('; '));
    const seen = new Set();
    const deduped = items.filter((i) => { const k = i.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); if (seen.has(k)) return false; seen.add(k); return true; });
    deduped.sort((a, b) => (b.published || 0) - (a.published || 0));
    return { fetchedAt: new Date().toISOString(), errors, items: deduped.slice(0, 80) };
  });
}

// ---------- X / Twitter ----------
function normTweet(t) {
  if (!t) return null;
  let text = t.full_text ?? t.text ?? '';
  for (const u of t.entities?.urls || []) text = text.replace(u.url, u.expanded_url || u.display_url || u.url);
  const media = (t.extended_entities?.media || t.entities?.media || []).map((m) => ({ type: m.type, url: m.media_url_https, link: m.expanded_url }));
  for (const m of t.entities?.media || []) text = text.replace(m.url, '').trim();
  const user = t.user || {};
  return {
    id: t.id_str, text, createdAt: t.created_at ? new Date(t.created_at).toISOString() : null,
    url: `https://x.com/${user.screen_name || config.twitter.handle}/status/${t.id_str}`,
    author: { name: user.name, handle: user.screen_name, avatar: user.profile_image_url_https },
    retweetOf: t.retweeted_status ? normTweet(t.retweeted_status) : null,
    quoted: t.quoted_status ? normTweet(t.quoted_status) : null,
    media,
  };
}
async function tweetsFromSyndication(handle) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}?dnt=true&lang=en&showReplies=false`;
  const { text } = await fetchText(url, { headers: { referer: 'https://platform.twitter.com/', accept: 'text/html' } });
  const m = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('syndication: no timeline payload');
  const data = JSON.parse(m[1]);
  const entries = data?.props?.pageProps?.timeline?.entries || [];
  const tweets = entries.map((e) => e.content?.tweet).filter(Boolean).map(normTweet);
  if (!tweets.length) throw new Error('syndication: empty timeline');
  return tweets;
}
async function tweetsFromMirror(base, handle) {
  const { text } = await fetchText(`${base}/${encodeURIComponent(handle)}/rss`, { timeout: 8000 });
  const items = parseRSS(text, base);
  if (!items.length) throw new Error(`${base}: no items`);
  return items.map((i) => ({
    id: i.link.split('/').pop().replace(/#.*$/, ''), text: i.description || i.title,
    createdAt: i.published ? new Date(i.published).toISOString() : null,
    url: i.link.replace(new URL(base).host, 'x.com'),
    author: { name: handle, handle }, retweetOf: null, quoted: null, media: [],
  }));
}
// ---- Official X API v2 (used when X_BEARER_TOKEN is set) ----
// X bills reads per post returned, so after the first call we only ask for
// posts newer than the newest one already held (since_id). A quiet poll costs nothing.
const xState = { userId: config.twitter.userId || null, tweets: [], newestId: null };
async function xApi(pathAndQuery) {
  const res = await fetch(`https://api.x.com/2${pathAndQuery}`, {
    headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}`, 'user-agent': 'bc-election-dashboard' },
    signal: AbortSignal.timeout(12000),
  });
  if (res.ok) return res.json();
  const body = await res.text().catch(() => '');
  let detail = '';
  try { const j = JSON.parse(body); detail = [j.title, j.reason, j.detail, j.errors?.[0]?.message].filter(Boolean).join(' / '); } catch { detail = body.slice(0, 200); }
  console.error(`X API ${res.status} on ${pathAndQuery.split('?')[0]}: ${body.slice(0, 500)}`);
  const hint = {
    401: 'token rejected: check X_BEARER_TOKEN',
    402: 'out of X API credits: top up in the X Developer Console',
    403: 'app lacks access to this endpoint, or credits are not set up',
    429: `rate limited until ${new Date(Number(res.headers.get('x-rate-limit-reset')) * 1000).toISOString()}`,
  }[res.status] || body.slice(0, 200);
  throw new Error(`X API ${res.status}: ${hint}${detail && detail !== hint ? ` (X says: ${detail})` : ''}`);
}
function cleanText(t) {
  let text = t.note_tweet?.text || t.text || '';
  const urls = t.note_tweet?.entities?.urls || t.entities?.urls || [];
  for (const u of urls) {
    if (u.media_key || /\/(photo|video)\/\d+$/.test(u.expanded_url || '')) text = text.replace(u.url, '');
    else text = text.replace(u.url, u.unwound_url || u.expanded_url || u.url);
  }
  return text.trim();
}
function fromXApi(t, inc) {
  if (!t) return null;
  const user = inc.users.get(t.author_id) || {};
  const media = (t.attachments?.media_keys || []).map((k) => inc.media.get(k)).filter(Boolean)
    .map((m) => ({ type: m.type, url: m.url || m.preview_image_url, link: null }));
  const ref = (type) => t.referenced_tweets?.find((r) => r.type === type);
  const rt = ref('retweeted'), q = ref('quoted');
  return {
    id: t.id, text: cleanText(t), createdAt: t.created_at || null,
    url: `https://x.com/${user.username || config.twitter.handle}/status/${t.id}`,
    author: { name: user.name, handle: user.username, avatar: user.profile_image_url },
    retweetOf: rt && inc.tweets.get(rt.id) ? fromXApi(inc.tweets.get(rt.id), inc) : null,
    quoted: q && inc.tweets.get(q.id) ? fromXApi(inc.tweets.get(q.id), inc) : null,
    media,
  };
}
async function tweetsFromXApi(handle) {
  if (!xState.userId) xState.userId = (await xApi(`/users/by/username/${encodeURIComponent(handle)}`)).data.id;
  const q = new URLSearchParams({
    max_results: '10',
    exclude: 'replies',
    'tweet.fields': 'created_at,entities,attachments,referenced_tweets,note_tweet,author_id',
    expansions: 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
    'user.fields': 'name,username,profile_image_url',
    'media.fields': 'url,preview_image_url,type',
  });
  if (xState.newestId) q.set('since_id', xState.newestId);
  const r = await xApi(`/users/${xState.userId}/tweets?${q}`);
  const inc = {
    users: new Map((r.includes?.users || []).map((u) => [u.id, u])),
    media: new Map((r.includes?.media || []).map((m) => [m.media_key, m])),
    tweets: new Map((r.includes?.tweets || []).map((t) => [t.id, t])),
  };
  const fresh = (r.data || []).map((t) => fromXApi(t, inc));
  if (r.meta?.newest_id) xState.newestId = r.meta.newest_id;
  const seen = new Set();
  xState.tweets = [...fresh, ...xState.tweets].filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 40);
  return xState.tweets;
}

export async function getTweets() {
  return cached('tweets', (config.twitter.refreshSeconds || 120) * 1000, async () => {
    const handle = config.twitter.handle;
    const errors = [];
    if (process.env.X_BEARER_TOKEN) {
      try { return { ok: true, source: 'x-api', handle, fetchedAt: new Date().toISOString(), tweets: await tweetsFromXApi(handle) }; }
      catch (e) { errors.push(e.message); if (xState.tweets.length) return { ok: true, stale: true, error: e.message, source: 'x-api', handle, fetchedAt: new Date().toISOString(), tweets: xState.tweets }; }
    }
    try { return { ok: true, source: 'syndication', handle, fetchedAt: new Date().toISOString(), tweets: await tweetsFromSyndication(handle) }; }
    catch (e) { errors.push(e.message); }
    for (const base of config.twitter.rssMirrors || []) {
      try { return { ok: true, source: base, handle, fetchedAt: new Date().toISOString(), tweets: await tweetsFromMirror(base, handle) }; }
      catch (e) { errors.push(e.message); }
    }
    throw new Error(errors.join(' | '));
  });
}

export function publicConfig() {
  const { port, ...pub } = config;
  return pub;
}
