# AGENTS.md: US Midterms 2026 dashboard

Read this before changing anything. It describes what exists, why it is built this way, and the traps already hit. Companion documents:

- `docs/RESEARCH.md` — every data source researched on 2026-10-25 with URLs, verdicts and live probe results. Check it before adding or guessing any feed URL.
- `docs/PLAN.md` — the migration plan and build order to Nov 3, with a status section.
- `docs/SCRUBBER.md` — the timeline scrubber plan (replay any moment of the night): Supabase time-series schema, bundle format, client clock, transport strip, delivery order.
- `README.md` — the user-facing overview.

## What this is

A live, customisable "second screen" for the **US midterm elections of Tuesday 3 November 2026**: Senate (35 seats up, Democrats need net +4), House (435, 218 for a majority), 36 governors. It started as a one-night dashboard for the B.C. provincial election of 24 October 2026 (git tag `bc-baseline`) and was migrated on 2026-10-25. The owner works against a hard deadline; working, tested increments beat plans.

- **Production:** https://2026-midterms-dashboard.vercel.app (the old https://bc-election-dashboard.vercel.app domain also points here). Vercel project `2026-midterms-dashboard` (renamed from `bc-election-dashboard` on 2026-10-25), team `jmuszkas-projects`, linked through `.vercel/project.json`. Deploy with `npx vercel --prod`.
- **Local:** `npm install && npm start`, then http://localhost:8787. `npm run dev` keeps snapshots/events in `.cache/store.json` across restarts. Add `?sim=1` for the simulated night.
- **Git:** commit small and often. Another agent session has edited this repo concurrently before; re-read a file right before editing it.

## Election-night data flow (decided 2026-10-25)

The owner's machine runs **`scripts/scraper.mjs`**, the only writer: every source task, snapshots, events, the scrubber time series and a heartbeat row per 15 s cycle, into the Supabase project `midterms-2026` (Vercel Marketplace integration, connected to the project). The Vercel site runs with **`READ_ONLY=1`**: it reads Supabase with the publishable key, never fetches an upstream source, refuses `/api/poll`, and shows a red "Live data paused" banner when the heartbeat is older than 3 minutes. Browsers get updates by CDN-cached polling plus a Supabase Realtime subscription to heartbeat inserts (a nudge; refetches carry the heartbeat id as `v=` so the CDN serves each version once). Run the scraper with `node scripts/scraper.mjs` (reads `.env` from `npx vercel env pull .env --yes`) or as the systemd user service in `scripts/scraper.service`. A second machine can run `--standby`. Schema: `db/schema.sql` (apply with `psql "$POSTGRES_URL_NON_POOLING" -f db/schema.sql`; idempotent). Without the scraper running, the production site shows the paused banner over the last data written; `?sim=1` still works.

## Architecture

No build step, no frontend framework, Node 22+ ESM. Static `public/` plus **one** Vercel function, `api/[route].mjs`, which dispatches to `lib/routes.mjs`; `server.mjs` uses the same router locally. Vercel rewrites `/api/x` to `/api/[route]?route=x`, so the handler reads the `route` query parameter first.

```
public/index.html, style.css      shell (bar, desktop, launcher, help, popover, toasts, reader, hatch patterns)
public/js/boot.js                 entry: loads config + manifest, registers window types, starts WM, restores layout
public/js/wm.js                   Hyprland-style tiling WM (ES module, dynamic windows, exposes window.wm)
public/js/layout.js               window instances, settings popover, presets, localStorage + #l= share links
public/js/core.js                 helpers, data hub (polls only what open windows subscribe to), events, selection bus, toasts
public/js/seats.js                seat tallies and hemicycle geometry shared by balance/chamber/map
public/js/reader.js               news reader window (Readability via /api/article)
public/js/views/*.js              window types: balance, map, chamber, feed, race, races, timeline, stream, news, social, markets, trends
public/data/                      districts-2026.json, states-10m.json, counties-10m.json (TopoJSON)
lib/routes.mjs                    all /api routes and their CDN freshness
lib/poll.mjs                      tasks, runPoll() (scheduler path), snapshot() (read path), events, ticks
lib/store.mjs                     memory | file (STORE_FILE) | Supabase (db/schema.sql)
lib/diff.mjs                      snapshot pairs -> events
lib/sim.mjs                       deterministic simulated election night
lib/model.mjs                     party ids, race ids, poll-close times, candidate matching
lib/sources/results.mjs           CNN (AP), NC SBE, Enhanced Voting (VA, GA), Clarity (CO, IA), merge
lib/sources/markets.mjs           Kalshi, Polymarket, PredictIt prices for config/markets.json ids
lib/sources/social.mjs            Bluesky, Truth Social (+ trumpstruth.org RSS fallback), X (token-gated)
lib/sources/streams.mjs           YouTube live-video resolver, Kick, Twitch
lib/sources/news.mjs              RSS lanes + race-call headline tagging, Google Trends
lib/article.mjs, lib/rss.mjs      reader extraction (kept from BC), RSS parsing
config/races.json                 GENERATED manifest (scripts/build-races.mjs); corrections go in config/race-overrides.json
config/markets.json               GENERATED market ids (scripts/build-markets.mjs)
config/sources.json               every feed, stream, social list, interval, and the seat balance (holdovers, current)
config/presets.json               named layouts (first one is the default)
config/parties.json, states.json  party colours/aliases; states with FIPS, seats, poll close, slow-count and runoff notes
scripts/                          build-races, build-markets, build-geo, poller
tests/                            data.test.mjs (offline), smoke.browser.mjs, wm.browser.mjs, fixtures/
```

Key decisions:
- **Read path never depends on a scheduler.** `snapshot(task)` serves the stored copy and refreshes inline when it is older than the task interval (3 intervals on Supabase), keeping the stale copy if the refresh fails. With no store configured this behaves like the BC build: per-instance memory plus CDN `s-maxage`. Events then exist per function instance only; a shared, complete event history needs Supabase plus a scheduler hitting `/api/poll` (`POLL_SECRET`), via `.github/workflows/poll.yml`, `scripts/poller.mjs`, or Vercel Cron (Pro only: Hobby crons are daily and a more frequent schedule fails the deploy).
- **Events are first-class.** `lib/diff.mjs` emits first_votes, vote_batch, lead_change, margin_tight, race_called, flip_called, race_uncalled, runoff, market_move; poll_close events are synthesised from the clock on read. The feed, ticker, toasts and flips counter all read events.
- **Calls come only from sources.** CNN's `editorialStatus` (AP) is the only source that sets `called`. State feeds contribute counts and precinct progress and override CNN's counts only when they have counted at least as many votes. There is no in-house projection; the BC `callRiding` heuristic is gone.
- **Windows are instances.** `{ type, settings }` keyed `type-n`; the WM tree holds instance ids. Layout + instances save to localStorage `us-dash-layout-v1` (previous copy in `-backup`) and to `#l=<deflate-raw base64url>` share links. Cookies are not used.
- **Simulation is a pure function** of (clock, seed). `?sim=1` (30× speed, 12-hour night loop) and `simAt=<minutes after 17:45 ET>` to pin it. Output is flagged `simulated`, calls read "SIMULATED", and the UI shows a red banner. Never present simulated data as real.

## Data sources and their quirks (short form; RESEARCH.md has the detail)

- **CNN** `politics.api.cnn.io/results/national-races/2026-{SG,S2G,HG,GG}.json`: S2G is a second Senate seat (the OH and FL specials); at-large House seats are `-1`; 404 until populated, which the adapter treats as "not yet". `county-races/<ecKey>.json` powers the race card's county table. Grey area: poll at 60 s, server-side, attributed.
- **NYT** results JSON is deliberately not used (ToS and robots.txt forbid it).
- **NC** `er.ncsbe.gov/enr/20261103/data/results_0.txt` is live with zero counts. **VA** Enhanced Voting slug `2026-November-General` is live. **GA** slug `2026NovGen` is a guess: confirm on election day. **CO/IA** Clarity: the adapter picks the Nov 3 2026 entry from `elections.json` once it appears; Clarity 403s without a browser User-Agent.
- **Markets**: Kalshi `tickers=` batches of 100, Polymarket Gamma `id=` batches of 50, PredictIt one blob (needs a browser UA). Prices are renormalised per venue so the parties shown sum to 1. Combo market keys are `D/D`, `R/D`, `R/R`, `D/R` (Senate/House).
- **Streams**: never use YouTube `search.list` (100 calls/day). The resolver reads `/channel/<id>/live` only up to `videoDetails` (~0.8 MB), takes the canonical video id, and treats `isLive && !isUpcoming` as live. Channels leave stale "upcoming" placeholders (WaPo's August event): anything scheduled more than 12 h ago counts as offline. Twitch embeds need `parent=<hostname>`.
- **Social**: X free paths are dead; X lists only run with `X_BEARER_TOKEN` and keep `since_id`. Bluesky handles were checked for activity: Nate Cohn, Wasserman, Nate Silver, Jessica Taylor and Amy Walter are effectively inactive there, and `ap-news.bsky.social` is a parody. Truth Social's Mastodon API answers unauthenticated JSON only with a full browser UA and is sometimes challenged; the trumpstruth.org RSS fallback lags a few hours and has no avatars.
- **News**: checked feeds are in `config/sources.json`; dead ones are listed in its `_dead` note. Race-call tagging requires a past-tense outcome verb plus an office word and rejects hedged headlines (unit-checked).
- **Geometry**: Missouri's Census 120th file encodes the blocked HB1 map, so `build-geo.mjs` takes Missouri from the 119th layer and verifies the two differ. Rings are rewound for d3-geo (the BC map once rendered as a globe-filling blob). `ZZ` water placeholders are dropped.
- **Manifest**: `build-races.mjs` must produce 35 / 435 / 36 and every state's seat count or it exits non-zero. Downballot and Wikipedia disagree on some redistricted incumbents (TX, UT, FL-25); the script warns and keeps Wikipedia.

## Kept from the BC build

- **Reader window**: Google News links decoded in two steps (`news.google.com/articles/<id>` for `data-n-a-sg`/`data-n-a-ts`, then POST `/_/DotsSplashUi/data/batchexecute` rpc `Fbv4je`), Readability on linkedom, sanitised server-side, rendered in a `srcdoc` iframe with no `allow-scripts`; SSRF guard; focus stays on the dialog, not the iframe, so Esc and arrows work.
- **Window manager behaviour**: dwindle tree, gaps 5/20, 2px gradient border, focus follows *real* mouse movement only, workspaces move windows with `transform` (never re-parent: it reloads iframes), Alt as the modifier (the owner's compositor owns Super), Hyprland keybinds, title-bar drag after 5 px, under 900 px everything stacks. Do not reintroduce GridStack, `--split-*` or `.gutter`.
- **Vercel traps**: keep `"framework": null` and `"buildCommand": ""`; never name a browser file `app.js`/`index.js`/`server.js`; `server.mjs`, tests, scripts and docs are in `.vercelignore`. `npx vercel build --prod` works locally without logging in; check `.vercel/output/functions/api` holds only `[route].func`, with `config/*.json` inside it.
- **CDN caching**: `s-maxage` + `stale-while-revalidate` per route (results and events 10–15 s, markets 30 s, news 60 s, manifest 1 h); failures are `no-store`.
- **Design**: dark, dense, calm. Text never wears party colours; a chip or bar carries identity. Party marks are DEM `#3A7BE0`, IND `#2BA6A0`, GOP `#E0453A`, validated with the dataviz skill's `validate_palette.js` on both dark surfaces in seat-bar order; minor parties fold into neutral grey and are always text-labelled. Re-run the validator before changing a colour. Leading = hatched, won = solid, not up = muted, no votes = neutral grey. Rating ramps are one hue per side with a neutral grey midpoint.

## Working philosophy

1. **Probe the real data first, then build.** Every adapter was written against a saved real response (`tests/fixtures/`).
2. **Verify in a real browser.** `tests/smoke.browser.mjs` caught five real bugs on its first runs; look at the screenshots, not just the PASS lines.
3. **Degrade gracefully.** Keep last good data, mark it stale, say why in the window.
4. **Be quota- and cost-aware.** YouTube search 100/day, OpenFEC 1,000/hr, Kalshi ~20 req/s, X pay-per-read. Warn before adding anything that costs money.
5. **Be legal by default.** Official feeds and market APIs freely; CNN slowly and attributed; NYT not at all; streams only through official embeds.
6. **Be honest about anything unverified**, in code comments, commit messages and the UI.

## Tests

```
npm test                                   # offline, <1 s: parsers, merge, differ, simulator, social, read-only mode
node tests/live.browser.mjs <dir> <url>    # with a scraper running and a READ_ONLY server: Realtime nudge (add --paused for the banner)
npm start & npm run test:browser           # needs chromium: smoke (31 checks) + window manager (all checks), simulation mode
node tests/smoke.browser.mjs <dir> <url>   # screenshots ws1-4, reader, phone into <dir>
```

## Nov 3 runbook

- **Days before:** `npm run build:races` and `npm run build:markets` (candidates, ratings and House markets keep changing), commit, deploy. Re-check stream channels for scheduled election-night streams (`/api/streams`).
- **Oct 28 and Oct 31, 8 am–noon PT:** California runs SOS API test feeds. A CA adapter is not written yet; this is the window to write and test one if wanted.
- **From 4 pm ET:** start the scraper on the election-night machine (`systemctl --user start midterms-scraper`), wired network, charger in; confirm `/api/status` shows a fresh heartbeat.
- **5 pm ET:** confirm Georgia's 2026 slug at https://results.sos.ga.gov/results/public/Georgia/elections and fix `config/sources.json` if it is not `2026NovGen`.
- **6 pm ET:** check `/api/results` → `sources` lists cnn with a non-zero count once CNN populates `2026-SG.json`.
- **Hourly:** adapter errors appear in `/api/results` `sources[].errors` and in each window's meta line; Kalshi/Polymarket errors in `/api/markets` `meta.errors`.
- Keep the BC deployment as a fallback until the US build has survived the first hour of real results.

## Open items

- No California adapter yet (CNN covers CA); no OH/TX/AZ/FL/NV/MT/KS adapters (blocked to curl; test from a deployed function before writing them).
- Supabase is supported in code (`lib/store.mjs`, `db/schema.sql`) but not provisioned; the browser polls rather than subscribing to Realtime.
- Short share links (`/d/<id>`) are not built; `#l=` links are long but self-contained.
- Race-level early-vote data (UF Election Lab) is manual-only; not shown.
- See `docs/RESEARCH.md` §12 for research gaps.
