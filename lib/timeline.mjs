// Timeline bundle for the scrubber (docs/SCRUBBER.md §2): everything needed to rebuild the
// dashboard at any moment, in compact columnar form, so the browser downloads the night once
// and then appends with ?since=<iso>.
//
// {
//   from, to, live, simulated,
//   races:   { [raceId]: { cand: [[name, party]], t: [unix s], v: [[votes aligned to cand]], e: [expected %|null],
//                          p: [[reporting, total]|null], c: [0 counting | 1 called | 2 runoff], w: [winner party|null] } },
//   markets: { [key]: { t: [unix s], v: [Democratic probability] } },   key = control:S | control:H | race id
//   events:  [ same rows as /api/events ],
//   news:    [ { t, item } ],  posts: { [list]: [ { t, post } ] },  streams: { [id]: [[t, videoId, status, title]] },
//   videos:  { [videoId]: { stream, title, start, end, length, dvr, live, archived } },   (always the full set)
//   archive: { [streamId]: [videoId, ...] }   curated permanent videos (config/stream-archive.json), preferred in replay
// }
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ARCHIVE = require('../config/stream-archive.json');

// recorded broadcast times, overridden by the curated archive
export function videoIndex(rows = []) {
  const videos = {}, archive = {};
  for (const r of rows) videos[r.video_id] = { stream: r.stream_id, title: r.title, start: r.start_at, end: r.end_at, length: r.length_s, dvr: !!r.dvr, live: !!r.live };
  for (const v of ARCHIVE.videos || []) {
    videos[v.videoId] = { stream: v.stream, title: v.title, start: v.start, end: v.end, length: v.length, dvr: false, live: false, archived: true };
    (archive[v.stream] ||= []).push(v.videoId);
  }
  return { videos, archive };
}
const sec = (iso) => Math.round(Date.parse(iso) / 1000);

export function emptyBundle() { return { races: {}, markets: {}, events: [], news: [], posts: {}, streams: {}, videos: {}, archive: {} }; }

// rows: race_ticks rows ({ race_id, t, called, winner, runoff, expected, prec, prec_total, votes: [[name, party, votes]] })
export function addRaceRows(bundle, rows) {
  for (const r of rows) {
    const b = (bundle.races[r.race_id] ||= { cand: [], t: [], v: [], e: [], p: [], c: [], w: [] });
    const idx = r.votes.map(([name, party]) => {
      let i = b.cand.findIndex(([n]) => n === name);
      if (i < 0) { i = b.cand.push([name, party]) - 1; b.v.forEach((row) => row.push(0)); }
      return i;
    });
    const row = new Array(b.cand.length).fill(0);
    r.votes.forEach(([, , votes], k) => { row[idx[k]] = votes || 0; });
    b.t.push(sec(r.t)); b.v.push(row); b.e.push(r.expected ?? null);
    b.p.push(r.prec_total ? [r.prec ?? 0, r.prec_total] : null);
    b.c.push(r.called ? 1 : r.runoff ? 2 : 0); b.w.push(r.called ? r.winner || null : null);
  }
  return bundle;
}

export async function bundleFromStore(store, { since = null, lastBeat = null } = {}) {
  const [raceRows, ticks, events, news, posts, streams, first, vids] = await Promise.all([
    store.raceTicks({ since }), store.ticksSince(since), store.eventsSince(since), store.newsSince(since), store.postsSince(since), store.streamTicksSince(since),
    since ? null : store.firstBeat(), store.streamVideos().catch(() => []),
  ]);
  const b = addRaceRows(emptyBundle(), raceRows);
  for (const k of ticks) { const m = (b.markets[k.key] ||= { t: [], v: [] }); m.t.push(sec(k.t)); m.v.push(k.v); }
  b.events = events;
  b.news = news.map((i) => ({ t: sec(i.first_seen), item: { link: i.link, title: i.title, source: i.source, published: i.published ? Date.parse(i.published) : null, lanes: i.lanes || [], description: i.description, image: i.image } }));
  for (const p of posts) (b.posts[p.list] ||= []).push({ t: sec(p.first_seen), post: p.payload });
  for (const s of streams) (b.streams[s.stream_id] ||= []).push([sec(s.t), s.video_id, s.status, s.title]);
  Object.assign(b, videoIndex(vids));
  const times = [...raceRows.map((r) => r.t), ...ticks.map((k) => k.t), ...(first ? [first.t] : [])].map(Date.parse).filter(Number.isFinite);
  b.from = times.length ? new Date(Math.min(...times)).toISOString() : null;
  b.to = lastBeat?.t || (times.length ? new Date(Math.max(...times)).toISOString() : null);
  b.since = since;
  b.live = true;
  return b;
}

// Simulation: the same document from the simulated night (3-minute steps), rows only on change.
export function bundleFromSim(series, events, { since = null } = {}) {
  const b = emptyBundle();
  const last = {};
  const rows = [];
  for (const step of series.steps) {
    for (const [id, r] of Object.entries(step.races)) {
      const row = { race_id: id, t: step.t, called: !!r.called, winner: r.called ? r.winner : null, runoff: !!r.runoff, expected: r.expectedPct ?? null, prec: null, prec_total: null, votes: r.candidates.map((c) => [c.name, c.party, c.votes]) };
      const key = JSON.stringify([row.called, row.expected, row.votes]);
      if (last[id] === key) continue;
      last[id] = key;
      if (!since || step.t > since) rows.push(row);
    }
  }
  addRaceRows(b, rows);
  b.events = events.filter((e) => !since || e.t > since);
  b.from = series.from; b.to = series.to; b.since = since; b.live = true; b.simulated = true;
  Object.assign(b, videoIndex([])); // a simulated night has no recorded video; only curated archive entries
  return b;
}
