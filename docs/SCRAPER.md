# The scraper

`scripts/scraper.mjs` is the only program that writes election data. It runs on the owner's machine on election night, polls every source, and writes everything to Supabase. The website at https://2026-midterms-dashboard.vercel.app only reads.

```
 owner's machine                      Supabase (midterms-2026)               Vercel (READ_ONLY=1)        browsers
 scripts/scraper.mjs  ── secret key ─▶ tables below  ◀── publishable key ── /api/* (CDN-cached) ─────▶ dashboard
   every source, every 15 s           heartbeat ─────────── Realtime insert ──────────────────────────▶ "new data, refetch"
```

Why it runs at home rather than on Vercel:

- **One writer.** One previous snapshot and one differ, so events and timeline ticks are consistent. Upstream sources see one client, however many people visit, and X API credits are spent once per new post.
- **A home IP.** YouTube serves Vercel's datacenter addresses the plain channel page instead of the live video, so on Vercel six multi-stream channels could not be detected as live (7 live channels found from Vercel, 14 from home). Truth Social's API also challenges datacenter clients more often.
- **No write access on the site.** Vercel holds only the publishable key, and row-level security limits that key to `SELECT` (verified: a write with it is refused by Postgres).

## Run it

```
npx vercel env pull .env --yes        # once: writes SUPABASE_URL, SUPABASE_SECRET_KEY, … (gitignored)
node scripts/scraper.mjs              # Ctrl-C to stop; it finishes the current cycle first
```

Options:

| Flag | Meaning |
|---|---|
| `--once` | One cycle, then exit (a smoke test) |
| `--tick 15` | Seconds between cycles (default 15). Each task still keeps its own interval |
| `--standby` | Write only while no other scraper's heartbeat is fresh (a backup machine) |
| `--env path` | Read a different env file |

It refuses to start while another machine's heartbeat is less than 3 minutes old, so two writers never run at once by accident. Use `--standby` on a second machine.

Environment (from `.env`; real environment variables win):

| Variable | Needed for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`) | Writing. Required |
| `SUPABASE_PUBLISHABLE_KEY` | The clock check (below) |
| `X_BEARER_TOKEN` | The "Analysts on X" list. Optional, billed per post read. Not in `.env` by default: it is a production-only variable in Vercel, so add the line yourself |
| `YOUTUBE_API_KEY` | Viewer counts on live streams. Optional |

### As a service (recommended for election night)

```
mkdir -p ~/.config/systemd/user
cp scripts/scraper.service ~/.config/systemd/user/midterms-scraper.service
# edit WorkingDirectory in that file if the repo is not at ~/Projects/bc-election-dashboard
systemctl --user daemon-reload
systemctl --user enable --now midterms-scraper
loginctl enable-linger "$USER"          # keep running after logout
journalctl --user -u midterms-scraper -f   # watch it
systemctl --user stop midterms-scraper     # stop
```

The unit restarts the scraper 5 seconds after any crash and wraps it in `systemd-inhibit --what=sleep:idle`, so the machine cannot suspend while it runs. Also: wired network, charger in, and NTP on (`sudo timedatectl set-ntp true`).

## What one cycle does

Every 15 seconds the scraper calls `runPoll({ beat: true })` (`lib/poll.mjs`). Each task runs only when its interval has passed:

| Task | Interval | Source (see `docs/RESEARCH.md`) | Writes |
|---|---|---|---|
| `results` | 60 s | CNN (AP calls) + NC, VA, GA, CO, IA official feeds, merged | `kv` snapshot, `events` (calls, flips, lead changes, vote batches, tight margins), `race_ticks` (only races that changed), a `snapshots` keyframe every 5 min |
| `markets` | 60 s | Kalshi, Polymarket, PredictIt, all 506 races | `kv` snapshot, `events` (moves of 5+ points), `ticks` (only prices that moved, plus a 15-minute keep-alive) |
| `streams` | 120 s | YouTube live detection for 34 channels, Twitch, Kick | `kv` snapshot, `stream_ticks` (which video each channel showed, on change), `stream_videos` (each video's broadcast start, end and archived length) |
| `news` | 120 s | 21 RSS feeds and Google News queries | `kv` snapshot, `news_items` (new headlines) |
| `social:<list>` | 90 s | Bluesky analysts, Truth Social (trumpstruth.org fallback), X | `kv` snapshot, `posts` (new posts) |
| `trends` | 600 s | Google Trends trending RSS | `kv` snapshot |
| `stocks` | 30 s | CNBC quote service: 43 indexes, futures, stocks, yields, commodities, crypto (incl. after-hours prices) | `kv` snapshot, `ticks` keyed `stock:<symbol>` (price, on change) and `stockpc:<symbol>` (previous close, when a new session starts) |
| `stockcharts` | 300 s | CNBC 1-day charts, downsampled to 5-minute closes, last 24 h | `kv` snapshot |

The cycle ends with a `heartbeat` row: time, host, version, and each task that ran with `ok` or its error. That row is what the site uses to show freshness, and its insert is the Realtime nudge that makes browsers refetch.

A failing source never stops the cycle: each adapter fails soft, and the error appears in the heartbeat's task map and in the window that shows that source.

## Safeguards

- **Clock drift.** At start and every 5 minutes the scraper compares its clock with Supabase's (`Date` header) and stamps every write with corrected time. It warns above 2 seconds and records the correction in the heartbeat (`_clock`). This was found the hard way: the owner's laptop had NTP off and ran 98 seconds slow, which made every heartbeat look stale.
- **Stuck cycles.** If a cycle runs longer than 90 seconds (a hung connection), the watchdog logs it and starts the next cycle anyway. Each task still runs at most once at a time.
- **Duplicates.** Race and market ticks are written only on change; inserts into append-only tables ignore duplicates, so a restart or a standby takeover cannot double-write.
- **Paged reads.** Supabase's Data API returns at most 1,000 rows per request; every store read that can exceed that pages through all of them (`pageAll` in `lib/store.mjs`).

## How the site behaves

| Scraper | Site |
|---|---|
| Running | Live data. Realtime nudges trigger immediate refetches; every viewer asks for the same versioned URL (`?v=<heartbeat id>`), so the CDN fetches each update from Supabase once |
| Stopped, or heartbeat older than 3 min | A red **Live data paused since 9:41 PM ET** banner; everything stays on screen as of the last write. The timeline still replays everything recorded |
| Never ran | Windows report "no data yet: the scraper has not written it" (HTTP 503) |

`/api/status` shows the latest heartbeat: `curl https://2026-midterms-dashboard.vercel.app/api/status`.

## Tables

All in `public`, created by `db/schema.sql` (idempotent: `psql "$POSTGRES_URL_NON_POOLING" -f db/schema.sql`). Everyone can read; only the secret key can write.

| Table | One row per |
|---|---|
| `kv` | Latest snapshot per task, plus small state (last keyframe, market alert times, video metadata seen) |
| `events` | Feed event |
| `race_ticks` | Race whose counts, call or expected vote changed, per cycle |
| `ticks` | Prediction-market price change (Democratic probability) per race or chamber; stock price (`stock:<symbol>`) and previous close (`stockpc:<symbol>`) changes |
| `snapshots` | Full merged results every 5 minutes (rebuild/debug hedge) |
| `news_items`, `posts` | Headline / social post, when first seen |
| `stream_ticks` | Channel whose live video or status changed |
| `stream_videos` | Video: broadcast start, end, archived length, DVR |
| `heartbeat` | Scraper cycle |

## Election-night checklist

1. **Days before:** `npm run build:races` and `npm run build:markets` (candidates and markets keep changing), commit, deploy.
2. **Afternoon of Nov 3:** `systemctl --user start midterms-scraper`; check `/api/status` shows a heartbeat seconds old and no `_clock` warning.
3. **5 pm ET:** confirm Georgia's 2026 results slug (see AGENTS.md runbook).
4. **When the official streams are announced:** add each one to the permanent archive (below) so replays survive after YouTube trims or privatises the live recordings.
5. **After the night:** leave the scraper running at a slower cadence (`--tick 60`) while California and Alaska count, or stop it; the site keeps serving everything recorded.

## Stream archive

`config/stream-archive.json` lists official election-night videos the timeline plays in sync, permanently. They take precedence over what the scraper recorded.

```
node scripts/stream-archive.mjs add cbs 'https://www.youtube.com/watch?v=<id>'   # reads start, end, archived length
node scripts/stream-archive.mjs add cspan '<id>' --start 2026-11-03T23:00:00Z    # when the video does not start at the broadcast start
node scripts/stream-archive.mjs list
node scripts/stream-archive.mjs remove <id>
```

Commit and deploy after editing it. Run `add` again once a stream has ended, to record its end time and how much YouTube archived (archives keep about the first 12 hours).
