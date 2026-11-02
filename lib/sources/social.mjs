// Social feeds normalised to one post shape:
//   { id, platform, url, createdAt, text, author: {name, handle, avatar, url}, media: [{type, url, link}],
//     repostBy: {name, handle}|null, quoted: {author, text, url}|null, card: {url, title, image}|null,
//     metrics: {replies, reposts, likes}|null }
// Bluesky and Truth Social are free and unauthenticated; X needs X_BEARER_TOKEN and bills per post.
import { fetchJSON, fetchText, pool } from '../http.mjs';
import { parseRSS, decode, stripTags, rawTag } from '../rss.mjs';

/* ---------------- Bluesky (public AppView) ---------------- */
const BSKY = 'https://public.api.bsky.app/xrpc';
const bskyUrl = (uri, handle) => `https://bsky.app/profile/${handle}/post/${uri.split('/').pop()}`;
function bskyMedia(embed) {
  if (!embed) return [];
  const e = embed.media || embed; // recordWithMedia wraps media
  if (e.images) return e.images.map((i) => ({ type: 'photo', url: i.thumb, link: i.fullsize }));
  if (e.$type?.includes('video')) return [{ type: 'video', url: e.thumbnail, link: e.playlist }];
  return [];
}
function bskyQuote(embed) {
  const rec = embed?.record?.record || embed?.record;
  if (!rec?.author || !rec.value) return null;
  return { author: { name: rec.author.displayName || rec.author.handle, handle: rec.author.handle }, text: rec.value.text || '', url: bskyUrl(rec.uri, rec.author.handle) };
}
export function normBsky(item) {
  const p = item.post, a = p.author;
  const ext = p.embed?.external || p.embed?.media?.external;
  return {
    id: `bsky:${p.cid}`, platform: 'bluesky', url: bskyUrl(p.uri, a.handle), createdAt: p.record?.createdAt || p.indexedAt,
    text: p.record?.text || '',
    author: { name: a.displayName || a.handle, handle: a.handle, avatar: a.avatar || null, url: `https://bsky.app/profile/${a.handle}` },
    media: bskyMedia(p.embed), quoted: bskyQuote(p.embed),
    card: ext ? { url: ext.uri, title: ext.title, image: ext.thumb || null } : null,
    repostBy: item.reason?.$type?.includes('reasonRepost') ? { name: item.reason.by?.displayName, handle: item.reason.by?.handle } : null,
    metrics: { replies: p.replyCount || 0, reposts: p.repostCount || 0, likes: p.likeCount || 0 },
  };
}
async function bluesky(acct) {
  const r = await fetchJSON(`${BSKY}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(acct.handle)}&limit=15&filter=posts_no_replies`);
  return (r.feed || []).map(normBsky);
}

/* ---------------- Truth Social ---------------- */
// Mastodon-compatible API answers unauthenticated JSON (needs a full browser UA).
// Fallback: the trumpstruth.org archive RSS.
function truthText(html) {
  // keep link targets: <a href="X">…</a> -> X
  const withLinks = String(html || '').replace(/<a\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi, (m, href) => ` ${decode(href)} `);
  return decode(stripTags(withLinks)).replace(/[ ]{2,}/g, ' ').trim();
}
export function normTruth(s) {
  const src = s.reblog || s;
  const a = src.account || {};
  return {
    id: `truth:${s.id}`, platform: 'truthsocial', url: src.url, createdAt: s.created_at, text: truthText(src.content),
    author: { name: a.display_name || 'Donald J. Trump', handle: a.acct || 'realDonaldTrump', avatar: a.avatar || null, url: `https://truthsocial.com/@${a.acct || 'realDonaldTrump'}` },
    media: (src.media_attachments || []).map((m) => ({ type: m.type === 'image' ? 'photo' : m.type, url: m.preview_url || m.url, link: m.url })),
    quoted: src.quote ? { author: { name: src.quote.account?.display_name, handle: src.quote.account?.acct }, text: truthText(src.quote.content), url: src.quote.url } : null,
    card: src.card?.url ? { url: src.card.url, title: src.card.title, image: src.card.image || null } : null,
    repostBy: s.reblog ? { name: s.account?.display_name, handle: s.account?.acct } : null,
    metrics: { replies: src.replies_count || 0, reposts: src.reblogs_count || 0, likes: src.favourites_count || 0 },
  };
}
export function truthFromRss(xml, acct) {
  return parseRSS(xml, 'trumpstruth.org').map((i) => {
    const original = rawTag(i.raw, 'truth:originalUrl').trim() || i.link;
    const html = decode(rawTag(i.raw, 'description').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
    const video = html.match(/href="([^"]+\.mp4)"/)?.[1];
    return {
      id: `truth:${rawTag(i.raw, 'truth:originalId').trim() || i.link}`, platform: 'truthsocial', url: original,
      createdAt: i.published ? new Date(i.published).toISOString() : null,
      text: /^(Video|Image|Photo) post from /.test(i.title) ? truthText(html.replace(/<a\b[^>]*\.mp4[^>]*>[\s\S]*?<\/a>/gi, '')) : truthText(html) || i.title,
      author: { name: acct.name, handle: acct.handle, avatar: null, url: `https://truthsocial.com/@${acct.handle}` },
      media: video ? [{ type: 'video', url: null, link: video }] : [], quoted: null, card: null, repostBy: null, metrics: null, via: 'trumpstruth.org',
    };
  });
}
async function truthsocial(acct) {
  try {
    const list = await fetchJSON(`https://truthsocial.com/api/v1/accounts/${acct.id}/statuses?exclude_replies=true&limit=20`, { timeout: 10000 });
    if (!Array.isArray(list)) throw new Error('unexpected response');
    return list.map(normTruth);
  } catch (e) {
    if (!acct.fallbackRss) throw e;
    const { text } = await fetchText(acct.fallbackRss, { timeout: 12000 });
    return truthFromRss(text, acct).slice(0, 30).map((p) => ({ ...p, fallbackReason: e.message }));
  }
}

/* ---------------- X (official API v2, pay-per-read) ---------------- */
// since_id per user keeps quiet polls free. State lives per function instance.
const xState = new Map(); // handle -> { id, newest, posts }
async function xApi(pathAndQuery) {
  const res = await fetch(`https://api.x.com/2${pathAndQuery}`, { headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }, signal: AbortSignal.timeout(12000) });
  if (res.ok) return res.json();
  const body = await res.text().catch(() => '');
  const hint = { 401: 'token rejected', 402: 'out of X API credits', 403: 'app lacks access (attach it to a Project)', 429: 'rate limited' }[res.status] || body.slice(0, 160);
  throw new Error(`X API ${res.status}: ${hint}`);
}
function normX(t, inc, handle) {
  const user = inc.users.get(t.author_id) || {};
  let text = t.note_tweet?.text || t.text || '';
  for (const u of t.note_tweet?.entities?.urls || t.entities?.urls || []) text = u.media_key || /\/(photo|video)\/\d+$/.test(u.expanded_url || '') ? text.replace(u.url, '') : text.replace(u.url, u.unwound_url || u.expanded_url || u.url);
  const media = (t.attachments?.media_keys || []).map((k) => inc.media.get(k)).filter(Boolean).map((m) => ({ type: m.type, url: m.url || m.preview_image_url, link: null }));
  const ref = (type) => t.referenced_tweets?.find((r) => r.type === type);
  const rt = ref('retweeted'), q = ref('quoted');
  const base = {
    id: `x:${t.id}`, platform: 'x', url: `https://x.com/${user.username || handle}/status/${t.id}`, createdAt: t.created_at, text: text.trim(),
    author: { name: user.name || handle, handle: user.username || handle, avatar: user.profile_image_url || null, url: `https://x.com/${user.username || handle}` },
    media, quoted: null, card: null, repostBy: null, metrics: t.public_metrics ? { replies: t.public_metrics.reply_count, reposts: t.public_metrics.retweet_count, likes: t.public_metrics.like_count } : null,
  };
  if (rt && inc.tweets.get(rt.id)) return { ...normX(inc.tweets.get(rt.id), inc, handle), id: base.id, repostBy: { name: base.author.name, handle: base.author.handle } };
  if (q && inc.tweets.get(q.id)) { const qq = normX(inc.tweets.get(q.id), inc, handle); base.quoted = { author: qq.author, text: qq.text, url: qq.url }; }
  return base;
}
async function x(acct) {
  if (!process.env.X_BEARER_TOKEN) throw new Error('X_BEARER_TOKEN not set');
  const st = xState.get(acct.handle) || { id: acct.id || null, newest: null, posts: [] };
  if (!st.id) { st.id = (await xApi(`/users/by/username/${encodeURIComponent(acct.handle)}`)).data.id; xState.set(acct.handle, st); } // keep the billed lookup even if the timeline call fails
  const q = new URLSearchParams({ max_results: '10', exclude: 'replies', 'tweet.fields': 'created_at,entities,attachments,referenced_tweets,note_tweet,author_id,public_metrics', expansions: 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id', 'user.fields': 'name,username,profile_image_url', 'media.fields': 'url,preview_image_url,type' });
  if (st.newest) q.set('since_id', st.newest);
  const r = await xApi(`/users/${st.id}/tweets?${q}`);
  const inc = { users: new Map((r.includes?.users || []).map((u) => [u.id, u])), media: new Map((r.includes?.media || []).map((m) => [m.media_key, m])), tweets: new Map((r.includes?.tweets || []).map((t) => [t.id, t])) };
  if (r.meta?.newest_id) st.newest = r.meta.newest_id;
  const seen = new Set();
  st.posts = [...(r.data || []).map((t) => normX(t, inc, acct.handle)), ...st.posts].filter((p) => !seen.has(p.id) && seen.add(p.id)).slice(0, 20);
  xState.set(acct.handle, st);
  return st.posts;
}

const PLATFORMS = { bluesky, truthsocial, x };

// Fetch one configured list. Accounts fail independently; the list keeps whatever succeeded.
export async function socialList(list) {
  const res = await pool(list.accounts, 6, async (acct) => {
    const fn = PLATFORMS[acct.platform];
    if (!fn) throw new Error(`unknown platform ${acct.platform}`);
    return fn(acct);
  });
  const posts = [], errors = [];
  res.forEach((r, i) => (r?.error ? errors.push(`${list.accounts[i].platform}:${list.accounts[i].handle}: ${r.error}`) : posts.push(...r.map((p) => ({ ...p, acct: list.accounts[i].handle })))));
  const seen = new Set();
  const out = posts.filter((p) => !seen.has(p.id) && seen.add(p.id)).sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, 80);
  return { name: list.name, posts: out, errors: [...new Set(errors.map((e) => (/X_BEARER_TOKEN not set/.test(e) ? "X accounts skipped: X_BEARER_TOKEN not set" : e)))], fetchedAt: new Date().toISOString() };
}

// The "everyone" feed: every list's stored posts in one stream. A post seen through several lists
// (a person in two lists) appears once, tagged with all of them. `acct` is the tracked account
// that produced the post (older stored posts lack it: the reposter or author then stands in).
export function mergeLists(lists, { limit = 400 } = {}) {
  const byId = new Map(), errors = new Set();
  let ranAt = null, stale = false;
  for (const [id, snap] of Object.entries(lists)) {
    if (!snap) continue;
    for (const e of snap.errors || []) errors.add(/X_BEARER_TOKEN/.test(e) ? e : `${id}: ${e}`);
    if (snap.stale) stale = true;
    if (snap.ranAt && (!ranAt || snap.ranAt > ranAt)) ranAt = snap.ranAt;
    for (const p of snap.posts || []) {
      const acct = p.acct || p.repostBy?.handle || p.author?.handle || '';
      const cur = byId.get(p.id);
      if (cur) { if (!cur.lists.includes(id)) cur.lists.push(id); continue; }
      byId.set(p.id, { ...p, acct, lists: [id] });
    }
  }
  const posts = [...byId.values()].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, limit);
  return { id: 'all', name: 'Everyone', posts, errors: [...errors], ranAt, stale };
}
