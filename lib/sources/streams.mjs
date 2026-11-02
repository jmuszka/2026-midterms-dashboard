// Live-stream resolver. For each configured channel, work out which video is live
// right now so the stream window can embed a concrete video id (the
// embed/live_stream?channel= trick fails whenever a channel runs two streams,
// which most outlets do on election night — docs/RESEARCH.md §9).
//
// YouTube: fetch /channel/<id>/live (zero API quota). The canonical link names the
// current or next video; videoDetails says whether it is live or only upcoming.
// The page is ~1.5 MB, so reading stops once videoDetails has been seen.
// With YOUTUBE_API_KEY set, one videos.list call (1 unit per 50 ids) adds viewer counts.
import { UA, pool, fetchJSON } from '../http.mjs';

// what counts as election coverage in a stream title (election-only channels, scripts/find-election-streams.mjs)
export const ELECTION_TITLE = /\belection|midterm|decision desk|decision 20|america decides|\bresults\b|\bvote\b|ballot|race calls?\b|balance of power/i;

// Read the page only until the canonical link AND the videoDetails marker have both been
// seen. Page variants differ in size (Vercel's datacenter IPs get a larger one), so the
// cap is generous; typical reads stop around 0.8 MB.
async function readUntil(url, marker, max = 3_000_000) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1' }, signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let s = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    s += dec.decode(value, { stream: true });
    const at = s.indexOf(marker);
    if ((at >= 0 && s.length > at + 4000 && s.includes('rel="canonical"')) || s.length > max) { reader.cancel().catch(() => {}); break; }
  }
  return s;
}

export function parseYouTubeLive(html) {
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || '';
  const videoId = canonical.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] || null;
  if (!videoId) return { status: 'offline', videoId: null };
  const vd = html.slice(html.indexOf('"videoDetails"'), html.indexOf('"videoDetails"') + 6000);
  const upcoming = /"isUpcoming":true/.test(vd);
  const live = /"isLive":true/.test(vd) && !upcoming;
  const title = (vd.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] || html.match(/<meta name="title" content="([^"]*)"/)?.[1] || '').replace(/\\u0026/g, '&').replace(/\\"/g, '"');
  const sched = html.match(/"scheduledStartTime":"(\d+)"/)?.[1];
  const scheduledStart = sched ? new Date(+sched * 1000).toISOString() : null;
  // channels leave abandoned "upcoming" placeholders around for months (WaPo: an August event in October)
  if (upcoming && sched && +sched * 1000 < Date.now() - 12 * 3600e3) return { status: 'offline', videoId: null, staleUpcoming: videoId };
  return { status: live ? 'live' : upcoming ? 'upcoming' : 'vod', videoId, title, scheduledStart };
}

// The live embed page (~150 KB) carries an escaped player response naming the live video.
// It is served normally to datacenter IPs, unlike /channel/<id>/live, which Vercel gets as
// the plain channel page. It only resolves when the channel has exactly one live stream.
export function parseYouTubeEmbed(html) {
  const lit = html.match(/"embedded_player_response":("(?:[^"\\]|\\.)*")/)?.[1];
  if (!lit) return null;
  let o; try { o = JSON.parse(JSON.parse(lit)); } catch { return null; }
  const ps = o.previewPlayabilityStatus || {};
  const videoId = ps.liveStreamability?.liveStreamabilityRenderer?.videoId;
  if (ps.status !== 'OK' || !videoId) return null;
  return { status: 'live', videoId, title: o.embedPreview?.thumbnailPreviewRenderer?.title?.runs?.map((r) => r.text).join('') || '', via: 'embed' };
}
async function youtube(s) {
  try {
    const res = await fetch(`https://www.youtube.com/embed/live_stream?channel=${s.channel}`, { headers: { 'user-agent': UA, referer: 'https://2026-midterms-dashboard.vercel.app/', 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(10000) });
    const hit = res.ok && parseYouTubeEmbed(await res.text());
    if (hit) return hit;
  } catch { /* fall through to the channel page */ }
  // several live streams at once, scheduled streams, or nothing live: ask the channel's /live page
  const html = await readUntil(`https://www.youtube.com/channel/${s.channel}/live`, '"isLiveContent"');
  const r = parseYouTubeLive(html);
  r.via = 'live-page';
  return r;
}
// Broadcast times for one video, from its watch page (no API quota). Used to map a timeline
// moment to a position in the video: while live, back from the live edge (DVR); once ended,
// seconds since start, within the archived length (YouTube keeps about the first 12 hours).
export function parseVideoMeta(html, videoId) {
  const lb = html.match(/"liveBroadcastDetails":\{([^}]*)\}/)?.[1];
  if (!lb) return null;
  const get = (k) => lb.match(new RegExp(`"${k}":"?([^",]+)"?`))?.[1];
  const vd = html.slice(Math.max(0, html.indexOf('"videoDetails"')), html.indexOf('"videoDetails"') + 6000);
  const length = +(vd.match(/"lengthSeconds":"(\d+)"/)?.[1] || 0);
  return {
    video_id: videoId,
    title: (vd.match(/"title":"((?:[^"\\]|\\.)*)"/)?.[1] || '').replace(/\\u0026/g, '&').replace(/\\"/g, '"') || null,
    start_at: get('startTimestamp') || null, end_at: get('endTimestamp') || null,
    live: get('isLiveNow') === 'true', dvr: /"isLiveDvrEnabled":true/.test(html), length_s: length || null,
  };
}
export async function videoMeta(videoId) {
  const html = await readUntil(`https://www.youtube.com/watch?v=${videoId}`, '"liveBroadcastDetails"', 3_000_000);
  return parseVideoMeta(html, videoId);
}

async function kick(s) {
  // unofficial endpoint; the official one needs an OAuth app token
  const j = await fetchJSON(`https://kick.com/api/v2/channels/${encodeURIComponent(s.channel)}`, { timeout: 8000 });
  return { status: j.livestream ? 'live' : 'offline', title: j.livestream?.session_title || null, viewers: j.livestream?.viewer_count ?? null };
}
async function twitch() {
  // Helix needs a client id + app token; without them the player itself shows offline/live.
  return { status: 'unknown' };
}
const RESOLVERS = { youtube, kick, twitch };

// Election-only (config/election-streams.json): a channel shows its election broadcast, never its
// everyday feed. Per channel, in order: its live video when the title is about the election (a new
// one is returned as `learned`, for the caller to pin); else a pinned video that is live or
// scheduled; else the latest pinned video as a recording, so the night's links stay after it; else
// offline. Pinned videos are checked on their watch page.
// Watch pages are what YouTube rate-limits first, so results are cached: an ended video never
// changes, a broadcast more than an hour away is rechecked every 15 minutes.
const pinCache = new Map(); // videoId -> { until, value }
async function pinnedStatus(videoId) {
  const c = pinCache.get(videoId);
  if (c && Date.now() < c.until) return c.value;
  const r = parseYouTubeLive(await readUntil(`https://www.youtube.com/watch?v=${videoId}`, '"isLiveContent"'));
  const value = r.staleUpcoming ? { status: 'upcoming', videoId, pinned: true } : !r.videoId ? { status: 'unavailable', videoId, pinned: true } : { ...r, videoId, pinned: true };
  const far = value.status === 'upcoming' && value.scheduledStart && Date.parse(value.scheduledStart) - Date.now() > 3600e3;
  pinCache.set(videoId, { until: value.status === 'vod' ? Infinity : far ? Date.now() + 15 * 60e3 : 0, value });
  return value;
}
export async function electionOnly(s, r, pins) {
  const own = [pins[s.id] || []].flat();
  if (r.videoId && (r.status === 'live' || r.status === 'upcoming') && ELECTION_TITLE.test(r.title || '')) {
    return { ...r, pinned: own.includes(r.videoId), learned: r.status === 'live' && !own.includes(r.videoId) ? r.videoId : undefined };
  }
  if (s.platform !== 'youtube') return r.title && !ELECTION_TITLE.test(r.title) ? { status: 'offline', note: 'not election coverage' } : r;
  const checked = [];
  for (const vid of own.slice().reverse()) { // newest pin first
    const p = await pinnedStatus(vid).catch((e) => ({ status: 'error', videoId: vid, error: e.message }));
    if (p.status === 'live' || p.status === 'upcoming') return { ...p, via: 'pinned' };
    checked.push(p);
  }
  const rec = checked.find((p) => p.status === 'vod');
  if (rec) return { ...rec, via: 'pinned' };
  // could not check (YouTube rate limit): still embed the newest pin; its player shows its state
  const unchecked = checked.find((p) => p.status === 'error');
  if (unchecked) return { status: 'unknown', videoId: unchecked.videoId, pinned: true, via: 'pinned', note: `pin not checked: ${unchecked.error}` };
  return { status: r.status === 'error' ? 'error' : 'offline', videoId: null, error: r.error, note: r.videoId ? 'not election coverage' : undefined };
}

export async function resolveStreams(list, { pins = null } = {}) {
  const res = await pool(list, 6, async (s) => {
    const r = pins ? await (RESOLVERS[s.platform] || twitch)(s).catch((e) => ({ status: 'error', error: e.message })) : await (RESOLVERS[s.platform] || twitch)(s);
    return { id: s.id, ...(pins ? await electionOnly(s, r, pins) : r) };
  });
  const out = {};
  res.forEach((r, i) => { out[list[i].id] = r?.error ? { id: list[i].id, status: 'error', error: r.error } : r; });

  const key = process.env.YOUTUBE_API_KEY;
  const ids = Object.values(out).filter((r) => r.videoId && r.status === 'live').map((r) => r.videoId);
  if (key && ids.length) {
    try {
      const j = await fetchJSON(`https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${ids.slice(0, 50).join(',')}&key=${key}`);
      const viewers = new Map(j.items.map((v) => [v.id, +v.liveStreamingDetails?.concurrentViewers || null]));
      for (const r of Object.values(out)) if (viewers.has(r.videoId)) r.viewers = viewers.get(r.videoId);
    } catch (e) { /* viewer counts are optional */ }
  }
  return { streams: out, fetchedAt: new Date().toISOString() };
}
