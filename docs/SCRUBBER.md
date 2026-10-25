# Timeline scrubber: replay any moment of election night

Plan written 2026-10-25. Goal: a transport strip under the bar that anyone on the site can drag to any moment from 6 pm ET on Nov 3 onward, during the night and forever after. Every window (balance, maps, seats, feed, race card, browser, markets, news, pundits, and where possible the video) shows the dashboard exactly as it was at that moment. Links can point at a moment ("watch Texas get called"). The clock, not the latest snapshot, becomes the source of truth for what is on screen.

## 0. The principle that makes this cheap

The simulator (`lib/sim.mjs`) is already a scrubber: `simulate(…, { offsetMin })` renders the night at any minute, and `?sim=1&simAt=N` pins it. Every view consumes a plain `results` object and a list of timestamped events. So the feature is:

1. record the real night as a time series the same way the simulator can generate one, and
2. put a **clock** between the data hub and the views, so "what time is it" is a value the viewer controls.

Nothing in `public/js/views/*` needs to know about replay. That also means the whole feature can be built and rehearsed against the simulator this week, and only the recording side is exercised for the first time on Nov 3.

## 1. What has to be stored (Supabase)

Today the store keeps only the **latest** snapshot per task (`kv` table), an append-only `events` table, and market `ticks` for control questions and competitive races. Replay needs the history of race state. Two options were considered:

- *Full snapshot every poll*: 720 polls × ~250 KB = ~180 MB of JSON per night. Simple, but every scrub position is a fresh 250 KB row and the browser cannot hold the night.
- *Per-race change rows* (chosen): write one row per race **only when that race changed** since the last stored row. The differ already compares prev and next, so this is a few lines in `afterRun('results')`.

```sql
-- db/schema.sql additions
create table if not exists public.race_ticks (
  race_id   text not null,
  t         timestamptz not null,          -- poll time (ranAt); the source's own time goes in src_t
  src_t     timestamptz,
  called    boolean not null default false,
  winner    text,                          -- party id when called
  expected  real,                          -- expectedPct 0..100, null if unknown
  prec      int, prec_total int,           -- precincts, null if the source gives none
  votes     jsonb not null,                -- {"James Talarico": 3691513, "Ken Paxton": 3248302, …}
  src       text,                          -- cnn | ncsbe | ev-va | clarity-co …
  primary key (race_id, t)
);
create index if not exists race_ticks_t_idx on public.race_ticks (t);

-- keyframes: the full merged results object every 5 minutes, for rebuilding ticks if the
-- differ ever had a bug, and for debugging. ~36 MB per night. Optional but recommended.
create table if not exists public.snapshots (
  t timestamptz primary key,
  task text not null,
  payload jsonb not null
);

-- append-only content so news and pundit windows can replay too (both already carry timestamps)
create table if not exists public.news_items (
  link text primary key, first_seen timestamptz not null, published timestamptz, source text, title text, lanes text[], description text, image text
);
create table if not exists public.posts (
  id text primary key, list text not null, created_at timestamptz not null, first_seen timestamptz not null, payload jsonb not null
);

-- streams: which video id each channel was showing when, so replay can seek the VOD (§6)
create table if not exists public.stream_ticks (
  stream_id text not null, t timestamptz not null, video_id text, status text, title text, primary key (stream_id, t)
);

-- idempotent bulk insert: skips rows equal to the race's latest stored row, so two function
-- instances polling at the same moment cannot double-write a change
create or replace function public.add_race_ticks(rows jsonb) returns int language plpgsql as $$
declare n int := 0; r jsonb;
begin
  for r in select * from jsonb_array_elements(rows) loop
    if not exists (
      select 1 from public.race_ticks x
      where x.race_id = r->>'race_id'
        and x.t = (select max(t) from public.race_ticks where race_id = r->>'race_id')
        and x.votes = r->'votes' and x.called = (r->>'called')::boolean
        and coalesce(x.expected, -1) = coalesce((r->>'expected')::real, -1)
    ) then
      insert into public.race_ticks (race_id, t, src_t, called, winner, expected, prec, prec_total, votes, src)
      values (r->>'race_id', (r->>'t')::timestamptz, (r->>'src_t')::timestamptz, (r->>'called')::boolean, r->>'winner',
              (r->>'expected')::real, (r->>'prec')::int, (r->>'prec_total')::int, r->'votes', r->>'src')
      on conflict do nothing;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- state of every race at a moment (used by /api/timeline?at= and by tests; the browser normally
-- reconstructs from the bundle instead)
create or replace function public.race_state_at(ts timestamptz) returns setof public.race_ticks language sql stable as $$
  select distinct on (race_id) * from public.race_ticks where t <= ts order by race_id, t desc
$$;
```

Existing tables stay: `events` is already the replayable feed (every row has `t`), `ticks` already holds market history. Market ticks should be extended to **every race with a market** (today only competitive ones), which is a one-line change in `afterRun('markets')`.

**Size and cost.** Worst case is a House race changing on every 60 s poll for six hours: 506 × 360 ≈ 180k rows × ~200 B ≈ 36 MB. Realistic is a third of that. Supabase's free tier (500 MB) is fine. Egress is protected because `/api/timeline` is CDN-cached on Vercel and the browser downloads the night once. A `minTickSeconds` knob per chamber (60 for Senate/governor, 120 for House) coalesces chatter if the row count runs hot.

**Who writes.** `lib/poll.mjs → afterRun('results')`, right after the events diff: for each race whose `candidates` votes, `called`, `winner`, `expectedPct` or `precincts` differ from `prev`, build a tick row; call `add_race_ticks` once with the whole batch. Every 5 minutes also write the keyframe. News and social tasks append unseen items/posts. The stream task appends a `stream_ticks` row when a channel's video id or status changes.

**Scheduler is required for a complete record.** Without one, ticks are written only when a visitor's request happens to refresh a stale snapshot, so quiet minutes leave holes. Run `.github/workflows/poll.yml` or `scripts/poller.mjs` against `/api/poll` from 5 pm ET Nov 3 until the last competitive race is called (CA House seats: days). With `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set, all instances share one `prev`, so the diff is consistent; the RPC above makes concurrent writes harmless.

## 2. The timeline bundle (what the browser downloads)

One endpoint, one compact document, columnar so it compresses well:

```
GET /api/timeline[?since=<iso>][&sim=1]
{
  "from": "2026-11-03T22:00:00Z", "to": "2026-11-04T03:12:00Z", "live": true,
  "races": {
    "S-TX": {
      "cand": [["James Talarico","DEM"],["Ken Paxton","GOP"],["Ted Brown","LIB"]],
      "t":  [1762210800, 1762210920, …],          // unix seconds, ascending
      "v":  [[0,0,0],[12034,15877,311], …],       // votes per candidate, aligned to cand
      "e":  [null, 3.1, …],                       // expected vote %
      "p":  [[0,0],[12,254], …],                  // precincts [reporting,total] or null
      "c":  [0, 0, …, 1]                          // 0 = not called, 1 = called (winner = leader at that tick), 2 = runoff, 3 = uncalled
    }, …
  },
  "markets": { "control:S": { "t": […], "v": […] }, "S-TX": { … } },
  "events":  [ …same rows as /api/events… ],
  "streams": { "nbc": [[t, "aF9neWULq64", "live"], …] }
}
```

- Sizes: ~25 B per tick before compression; a full night ≈ 2–4 MB raw, ~0.6–1 MB gzipped (Vercel compresses responses). `since=` returns only ticks after a time so the live page appends every 60 s instead of re-downloading.
- Cache: `s-maxage=60` while `live` is true; when the night is over the export script writes `public/data/timeline-2026.json` and `/api/timeline` serves that file with a long cache. After that, Supabase can be paused and the replay still works forever, which is the point: the site becomes the permanent record of the night.
- Simulation: `?sim=1` builds the same document from `simulate()` sampled every 3 minutes (the loop that already generates sim events). This is how the feature gets built before any real tick exists.

Builder: `lib/timeline.mjs` with `bundleFromTicks(rows, markets, events, streams)` and `bundleFromSim(…)`; both produce the shape above; `scripts/export-timeline.mjs` writes the static file and a CSV of ticks for anyone who wants the raw data.

## 3. The clock (browser)

`public/js/clock.js`, one object every view already indirectly depends on:

```
clock = { mode: 'live' | 'replay', t: <ms>, playing: false, speed: 1 | 10 | 60 | 300,
          set(t), live(), play(), pause(), step(ms), subscribe(fn) }
```

- `live` mode: `t` follows the wall clock (or the sim clock when `?sim=1`); behaviour is exactly today's.
- `replay` mode: `t` is whatever the user set; `play()` advances it at `speed` × real time. Hitting the right end of the timeline latches back to `live`.
- `public/js/timeline.js` holds the bundle (initial fetch + `since=` appends while live) and exposes `stateAt(t)` → the same `{ [raceId]: result }` object `/api/results` returns, rebuilt by binary-searching each race's `t` array (cached per minute, 506 searches is sub-millisecond); `eventsUntil(t)`; `marketsAt(t)`; `streamAt(id, t)`.
- `core.js` hub: when `clock.mode === 'replay'`, subscribers of `results`, `markets` and the events list are fed from `timeline.stateAt(clock.t)` instead of the network, and are re-notified on every clock change. The `news` and `social:*` keys filter their lists to `published/createdAt <= t` (items come from the append-only tables when replaying, from the live snapshot otherwise). Views stay untouched.
- Toasts are suppressed in replay (the feed window still shows the backlog). The bar gets a **REPLAY · 9:41 PM ET** badge in the same style as the simulation banner, so no one mistakes a replay for live.

## 4. The transport strip (UI)

A strip under the bar (`#transport`), always visible once the timeline has any data, never a window (it must stay put while workspaces slide):

```
[ LIVE ]  6pm ─┬──────┬───┬──────────●────────────────┬─────── 1am   ▶ 10×   9:41 PM ET
               7  7:30 8   9 (poll-close ticks)        now
               ▲ ▲   ▲▲  (markers: calls, flips, markets moves; height = count per minute)
```

- Drag or click to scrub; scroll wheel for fine steps; `,` / `.` nudge 1 min, `Shift` 10 min (Alt is the WM's modifier, plain keys are free). Hover shows the time and the nearest event.
- Markers come from `events` (flip and call density per minute) so the "interesting" minutes are visible before scrubbing.
- Play / pause with speed 1×, 10×, 60×, 300×. **LIVE** jumps back and re-latches.
- The strip's range is `from` (6 pm ET) to `max(to, now)` while live; after the night it is `from` to the last tick.
- Feed rows get a "jump to" affordance: clicking the time of an event sets the clock to that moment. The race card gets a mini sparkline of margin over time from the bundle (cheap and very readable).
- Share links: `layout.js` adds `t` to the `#l=` document when the clock is in replay, so a shared link opens at that moment. The hash stays self-contained.

## 5. Delivery order

Everything up to step 4 is testable this week against the simulator.

| Step | Work | Done when |
|---|---|---|
| 1 | Supabase project (Vercel Marketplace integration injects `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, or supabase.com directly) and the schema above; `lib/store.mjs` gains `addRaceTicks`, `raceTicks(since)`, `addSnapshot`, `addNewsItems`, `addPosts`, `addStreamTicks` | `npm test` has a store contract test that runs against memory and, when env is set, Supabase |
| 2 | Poller writes: ticks + keyframes + news/posts/streams appends in `afterRun`; market ticks for every mapped race | Running the local poller against `?sim=1` data fills the tables |
| 3 | `lib/timeline.mjs` bundle builder (sim and real) and `/api/timeline` with `since=`; `scripts/export-timeline.mjs` | Offline test: bundle from sim → `stateAt(t)` equals `simulate(…, t)` for 20 random t; bundle round-trips through `since=` appends |
| 4 | `clock.js`, `timeline.js`, hub integration, transport strip, bar badge, keyboard, event jump, link `t` | Browser test: scrub to 240 min in sim, balance tallies and feed match `/api/results?sim=1&simAt=240`; share link with `t` lands on the same moment |
| 5 | News and social replay from the append-only tables; race-card margin sparkline | Browser test in sim at two moments shows different headline sets |
| 6 | Dress rehearsal: run the real scheduler for 24 h before Nov 3 with real (empty) feeds; confirm ticks, keyframes and `since=` appends arrive; check Supabase row counts and Vercel function time | Runbook entry in AGENTS.md |
| 7 (stretch) | Stream VOD seek (§6) | NBC/C-SPAN replay seeks to the same minute |
| After the night | `export-timeline.mjs` → `public/data/timeline-2026.json`, `/api/timeline` serves the file, pause Supabase | Site replays the night with no backend |

Estimated effort: steps 1–4 are one long day, 5–6 another. It fits before the Nov 2 freeze if started Oct 26.

## 6. Replaying the video (stretch)

YouTube keeps most live streams as VODs under the **same video id**, and the embed accepts `start=<seconds>`. With `stream_ticks` recording which video id each channel showed when, plus the stream's actual start time (`liveStreamingDetails.actualStartTime`, 1 quota unit per 50 ids with `YOUTUBE_API_KEY`), replay at time `t` can embed `https://www.youtube.com/embed/<id>?start=<t − actualStart>`. Works for event-style streams (C-SPAN, PBS, The Hill, DDHQ, streamers); the rolling 24/7 channels (NBC News NOW, ABC) do not archive, so those fall back to a "not available in replay" card. Twitch VODs have different ids (`videos/<vodId>?t=1h2m`) and need the Helix API; leave for later.

## 7. Risks and decisions

- **Time base.** Ticks use poll time, not the source's vote timestamp, so the replay shows what the dashboard knew, when it knew it. Source times are kept in `src_t` for honesty in the race card ("reported 9:37 pm, seen 9:38 pm").
- **Corrections.** Vote totals can go down (precinct corrections) and calls can be withdrawn; ticks store whatever the source said, `c = 3` marks an uncalled race, and the differ already emits `race_uncalled`.
- **Holes.** If the scheduler dies, ticks stop; the strip shows a gap marker from `snapshots` cadence so viewers know the record is thin there. The staleness banner in the plan covers the live side.
- **Memory on phones.** The bundle is one object of ~3 MB; fine. Reconstruction is lazy per minute.
- **Not storing the full merged snapshot every poll** is the one irreversible choice; the 5-minute keyframes are the hedge.
- **Hobby-plan limits.** Vercel function time is fine (one bulk RPC per poll). Supabase free pauses after a week of inactivity: export the static file promptly after the night.
