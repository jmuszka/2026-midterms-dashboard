# US Midterms 2026 dashboard — migration plan

Written 2026-10-25. Election day is Tuesday 3 November 2026. This document turns the BC Election Night demo (git tag `bc-baseline`) into the "ultimate" US midterms second screen. Data-source facts live in `docs/RESEARCH.md`; this file is about what to build and in what order.

## 1. Vision

One page, many windows, everything about the midterms in one place: live results across the Senate, House and governors; a national map, an aerial chamber view and a live event feed over the same data; a wall of free live streams; a news feed with reader mode; pundit feeds; a dedicated Trump/Truth Social feed; prediction-market odds; poll-closing timeline. Everything is config-driven, every window is an instance with its own settings, and a whole dashboard layout can be shared as a URL.

## 2. What carries over from BC unchanged

- The hosting model: static `public/` plus one Vercel function per route, no build step, no framework, CDN caching with `s-maxage` and `stale-while-revalidate`.
- The Hyprland-style window manager (`public/wm.js`): dwindle tiling, workspaces 1–9, special workspace, floating, fullscreen, launcher, keybinds. This is the customization layer; it does not need replacing.
- The news pipeline: RSS merge and de-dup (`lib/feeds.mjs`), Google News redirect decoding and Readability extraction (`lib/article.mjs`), the sandboxed reader window.
- The YouTube embed panel mechanics.
- The in-memory stale-on-error cache, the SSRF guard, the dark theme tokens.
- The browser-driven test approach (`tests/*.browser.mjs`).

## 3. What changes

### 3.1 Panels become window types with instances

Today each window is a fixed `<div class="win" data-tile="map">` with hard-coded content and one global state. The US version needs two map windows (Senate and House) side by side, three pundit windows for three lists, a stream wall. So:

- A **window type** registry: `map`, `chamber`, `feed`, `balance`, `race`, `races`, `stream`, `news`, `social`, `markets`, `timeline`, `trends`. Each type has a `create(el, settings)` function and a `settings` schema with defaults.
- A **window instance** is `{id, type, settings}`. The WM tree holds instance ids. The launcher creates new instances (pick a type, then settings).
- Settings UI: a small gear in each `.panel-head` opens a popover generated from the schema (chamber: Senate/House/Gov; stream: source; social: list; markets: which contracts).

This is the single biggest frontend refactor and it comes first, because every other feature plugs into it.

### 3.2 Shareable layouts

The WM already serialises its full state (`{ws, special, floating, active, focus, mod}`) to localStorage. Add the instance list and settings to that state and:

- `#l=<base64url(deflate(JSON))>` in the URL carries the entire dashboard. Copy link = share dashboard. Loading a page with `#l=` offers "Load shared layout / keep mine".
- localStorage keeps the last layout per browser (already done).
- `presets.json` ships named layouts: Senate Watch, House Watch, Stream Wall, Pundit Row, Kitchen Sink. The launcher lists them.
- Later, optional: a `layouts` table in the store and `/d/<short>` for short links.

Cookies are not used for layout. They only travel between one browser and the server and cannot be shared.

### 3.3 Backend: poller, store, events

Vercel functions cannot run persistent workers, so polling moves to a scheduled job that writes to a store, and the read endpoints serve from the store only.

```
[scheduler] ──every 30–60 s──> POST /api/poll (secret header)
                                  ├─ fan out: state feeds, CNN, Kalshi, Polymarket, PredictIt, Bluesky, RSS
                                  ├─ normalise to the race model
                                  ├─ diff against previous snapshot → events
                                  └─ write races, candidates, markets, events, snapshots

[browser] ── GET /api/races, /api/events?since=, /api/markets ── served from store, CDN-cached 10–30 s
          └─ optional: Supabase Realtime subscription on `events` for push instead of poll
```

- **Scheduler options:** Vercel Cron (per-minute needs the Pro plan; Hobby is once a day, useless here), GitHub Actions on a schedule, cron-job.org, or the Home Assistant box curling a secured URL. Decision: external trigger (free, plan-independent), with Vercel Cron as a one-line switch if Pro is bought for the month.
- **Store:** Supabase (Postgres + Realtime) is the preferred pick because the browser can subscribe to the `events` table. Upstash Redis or Neon through the Vercel Marketplace are acceptable alternatives. Provision through the Vercel Marketplace flow so env vars land in the project automatically.
- **Tables:** `snapshots(source, fetched_at, payload jsonb)`, `races(race_id pk, chamber, state, district, status, called_by, expected_pct, precincts_reporting, precincts_total, updated_at, source)`, `candidates(race_id, candidate_id, name, party, incumbent, votes, pct)`, `markets(market_id pk, venue, label, race_id nullable, yes_price, fetched_at)`, `market_ticks(market_id, t, price)`, `events(id, t, type, race_id, chamber, state, payload jsonb)`, `layouts(short, state jsonb, created_at)`.
- **Event types** produced by the differ: `race_called`, `race_uncalled`, `lead_change`, `vote_batch` (threshold-based: ≥ N votes or ≥ X points of expected vote), `margin_tight` (crossed under 1 or 0.5 points), `flip_called`, `runoff`, `market_move` (≥ 5 points in 10 minutes), `poll_close`.
- **The live feed window, the ticker, toasts and the flips counter all read `events`.** Nothing else computes them.

### 3.4 Results sources (see RESEARCH §2)

Adapters, each one file in `lib/sources/`:
- `nc.mjs` (er.ncsbe.gov JSON), `va.mjs` and `ga.mjs` (Enhanced Voting), `ca.mjs` (api.sos.ca.gov), `clarity.mjs` (CO, IA, counties), `cnn.mjs` (national gap-filler + race calls), `kalshi.mjs`, `polymarket.mjs`, `predictit.mjs`, `bluesky.mjs`, `rss.mjs`, `youtube.mjs` (live-ID resolver).
- Each adapter returns the common race model and is independently testable against saved fixtures. NC is live now with zero counts; CA runs test feeds Oct 28 and Oct 31; Kalshi and Polymarket are live now.
- Race identity: `{chamber}-{state}-{district|class}` e.g. `S-TX`, `H-CA-22`, `G-GA`, `S-OH-special`. The manifest (§3.6) is the join key for every source's native id.
- Call status comes from CNN's `editorialStatus`/AP. The dashboard never invents a call. An optional "unofficial lean" badge may be shown from a margin-and-expected-vote rule, always labelled unofficial, off by default.
- NYT JSON is deliberately not shipped (ToS). The CNN adapter polls at 60 s, server-side, with attribution in the UI footer.

### 3.5 The three results views

All three are window types over the same `races` data.

1. **Map** (`map`, settings: chamber, colour mode = margin|winner|flip|expected-vote). States for Senate and governors; 2026 congressional districts for the House (TIGER 2026 per state, Missouri from the 2025 file); counties on drill-in for Senate/governor races where a source provides county rows (NC, VA, GA, CA, CNN county files). Insets for the Northeast and for city clusters, reusing the BC inset code. Hover tooltip and click-to-pin as today.
2. **Chamber** (`chamber`, settings: chamber). Aerial seat view: a hemicycle for the Senate (100 seats, 65 not-up seats greyed as holdovers, 35 fill in) and the House (435). Seats are solid when called, hatched when leading, hollow when not reporting. Click a seat for its race card. Pure SVG from a generated seat-position table. Optional hex cartogram mode for the House using the Daily Kos 2022 layout relabelled.
3. **Live feed** (`feed`, settings: chambers, states, event types, competitiveness filter, compact/ticker mode). Reverse-chronological events, each linking to its race card. A one-row ticker variant for the bar.

Plus the smaller ones:
- **Balance of power** (`balance`): the BC seat bar generalised to three bars (Senate 100/51, House 435/218, governors 50) with called/leading/not-reporting segments, net change vs today, and rater-by-rater pre-election totals until results exist.
- **Race card** (`race`): candidates with vote bars, expected vote %, margin, incumbent flag, rating, 2024 presidential baseline from the Downballot sheet, market odds for that race, county mini-map where data exists.
- **Race browser** (`races`): the BC ridings table with filters for chamber, state, status, flips, margin under 2 points, toss-ups only.
- **Timeline** (`timeline`): poll-close strip across the top from 6 pm to 1 am ET with a now-marker, counts of races closing at each step, and slow-count badges (CA, AK, NV, PA, ME, LA/GA runoffs).

### 3.6 Config layers

`config.json` splits into:
- `config/races.json` — the manifest: every Senate, House and governor contest with `race_id`, chamber, state, district, poll-close time, candidates (name, party, incumbent, FEC id), rating per rater, 2024 presidential margin on 2026 lines, source ids (CNN key, state-feed contest name, Kalshi ticker, Polymarket slug, PredictIt id), slow-count flag, runoff rule. Generated by a script from OpenFEC + Wikipedia/270toWin tables + the Downballot sheet, then hand-checked for the ~60 competitive races.
- `config/sources.json` — stream sources (platform, channel id, handle, fixed video id), news feeds and Google News queries, Bluesky lists and accounts, Truth Social source, market contracts to track, poll intervals.
- `config/presets.json` — named layouts and window-type defaults.
- `config/parties.json` — DEM, GOP, IND, LIB, GRN, OTH with colours validated for colour-blind separation on the dark surface.

### 3.7 Streams

- Keep the YouTube embed. Add a source carousel: previous/next buttons, keyboard shortcut, optional auto-cycle, and a picker from `sources.json`.
- Server-side live-ID resolver (`/api/live`): for each configured channel fetch `/live`, parse canonical + `isLiveNow`, confirm in one `videos.list` batch (1 quota unit), cache 60–120 s. Fall back to `embed/live_stream?channel=` only for single-stream 24/7 channels (NBC, ABC, Al Jazeera, DW, France 24, CBC). Never use `search.list` (100 calls/day cap).
- Twitch (`player.twitch.tv` with `parent` for every host), Kick (`player.kick.com/<slug>`), Rumble (embed id scraped) as additional platforms in the same source model.
- A "Stream Wall" preset opens four stream windows with one unmuted.
- Optional chat window: Twitch chat embed or YouTube live chat for the active stream.

### 3.8 Feeds

- **News:** same pipeline; `sources.json` carries national, per-battleground-state and per-chamber Google News queries plus publisher RSS. Lanes: All, Wires, Called (headlines matching race-call language), by state.
- **Pundits (`social`, settings: list):** Bluesky public API as the backbone; X only when `X_BEARER_TOKEN` is set, keeping `since_id`. Curated lists in config.
- **Trump feed:** a dedicated `social` instance with its own adapter for Truth Social (mirror or RSS bridge, to be chosen; open gap) and distinct styling.
- **Markets (`markets`):** Senate and House control from Kalshi, Polymarket and PredictIt side by side with sparklines from `market_ticks`; per-race odds surface in race cards.
- **Trends:** Google Trends trending RSS as a ticker; explore-widget embeds client-side only.

## 4. Build order (Oct 26 → Nov 3)

Each day ends with a deploy that works. Things later in the list can be dropped without breaking earlier ones.

| Day | Deliverable |
|---|---|
| Sun Oct 26 | Window types + instances refactor of `dashboard.js`/`wm.js`; settings popover; URL-hash layout sharing; presets. Existing BC panels keep working as instances. |
| Mon Oct 27 | Store provisioned (Supabase via Marketplace); `/api/poll` skeleton with secret; external scheduler hitting it; `races.json` generator script (OpenFEC + Wikipedia/270toWin + Downballot). Kalshi + Polymarket + PredictIt adapters live → `markets` window. |
| Tue Oct 28 | Results adapters: NC (live), VA, GA (2024 slug for schema), CA (test feed 8am–noon PT), Clarity CO/IA, CNN 2026 keys. Differ + `events` table. Race model normalised. |
| Wed Oct 29 | Geometry: TIGER 2026 per state + MO from 2025, simplified and rewound; us-atlas states/counties. Map window with chamber setting and insets. Balance-of-power bars. |
| Thu Oct 30 | Chamber (hemicycle) window; race card; race browser; poll-close timeline. |
| Fri Oct 31 | Live feed window + ticker + toasts from `events`; CA second test feed; replay harness that feeds 2024 CNN/NYT-shaped fixtures through the differ to exercise every event type. |
| Sat Nov 1 | Streams: live-ID resolver, carousel, Twitch/Kick/Rumble, Stream Wall preset; re-check which outlets have scheduled Nov 3 streams. Pundit feed on Bluesky; Trump feed adapter. |
| Sun Nov 2 | Polish: mobile stacking, error states, attribution footer, rate-limit audit of every poller, load test the CDN path. Freeze config. Write the Nov 3 runbook (slugs to fill in at 6 pm ET: GA 2026 slug, CNN SG/GG keys, stream video ids). |
| Mon Nov 3 | Watch mode. Fill the runbook slugs as they appear, keep the scheduler alive, fix adapters as feeds change shape. |

## 5. Legal and etiquette stance

- Official state feeds and prediction-market APIs: public, use freely with normal politeness (respect `cache-control`, 15–60 s intervals).
- CNN JSON: grey; server-side only, 60 s, attributed, never archived or re-served raw.
- NYT JSON: not used.
- Streams: embeds only, through each platform's official embed URL; never re-stream.
- No vote counts are ever presented as "called" unless a source called them. The BC "Projected" heuristic is retired.

## 6. Risks

- **Nine days.** Days 1–3 are the load-bearing ones; if the instance refactor slips, everything else slips. Keep BC panels working as instances so there is always a shippable page.
- **Feeds changing shape on the night.** Every adapter must fail soft (keep last good data, mark stale, log the error) exactly as the BC feeds do.
- **Vercel region blocks.** OH/TX/AZ/FL/NV/MT/KS may 403 from Vercel's IPs. Test on Oct 27 from a deployed function, not from a laptop.
- **Scheduler dies.** Have two triggers (GitHub Actions and the Home Assistant box) and a staleness banner in the UI when the newest snapshot is older than 3 minutes.
- **Quota traps.** YouTube `search.list` 100/day; OpenFEC 1,000/hr; Kalshi 20 req/s. The poller must batch.
- **Concurrent editing.** Two Claude sessions have edited this repo at once before. Now that git exists, commit small and often and re-read files before editing.
