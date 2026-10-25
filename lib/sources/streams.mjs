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

export async function resolveStreams(list) {
  const res = await pool(list, 6, async (s) => ({ id: s.id, ...(await (RESOLVERS[s.platform] || twitch)(s)) }));
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
