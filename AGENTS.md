# AGENTS.md: US Midterms 2026 dashboard

Read this before changing anything. It describes what the project is becoming, what already exists, and the traps already hit. Two companion documents hold the detail:

- `docs/PLAN.md` — the migration plan: architecture, window types, store and poller, build order to Nov 3.
- `docs/RESEARCH.md` — every data source researched on 2026-10-25 with URLs, verdicts and live probe results. Check it before adding or guessing any feed URL.

## What this is

A live, customisable "second screen" dashboard for the **US midterm elections of Tuesday 3 November 2026**: Senate (35 seats up, Democrats need net +4), House (435, 218 for a majority, Democrats need net +4), 36 governors. It started life as a one-night dashboard for the B.C. provincial election of 24 October 2026 (git tag `bc-baseline`) and is being migrated panel by panel. The owner is one developer working against a hard deadline; working, deployed increments beat plans.

- **Production (still the BC build until the migration deploys):** https://bc-election-dashboard.vercel.app, Vercel project `bc-election-dashboard`, team `jmuszkas-projects`, linked through `.vercel/project.json`. A rename to a midterms project name is expected.
- **Local:** `npm install && npm start`, then http://localhost:8787.
- **Git:** initialised 2026-10-25. `bc-baseline` tags the pre-migration state. Commit small and often; another agent session may be editing the repo at the same time, so re-read a file before editing it.

## Migration status

| Area | State on 2026-10-25 |
|---|---|
| Window manager (`public/wm.js`) | Done, carries over unchanged. Windows still hard-coded; needs the instance refactor (PLAN §3.1) |
| News feed + reader window | Done, carries over; needs US feed list (RESEARCH §12 gap 1) |
| YouTube stream panel | Works; needs source carousel and live-ID resolver (PLAN §3.7) |
| Results (map, seat bar, table, detail) | BC-specific; to be rebuilt on the US race model (PLAN §3.4–3.5) |
| X feed | Dead without a paid token; replaced by Bluesky-first pundit feed + Truth Social feed (PLAN §3.8) |
| Store + poller + events | Not started (PLAN §3.3) |
| Prediction markets | Not started; Kalshi/Polymarket/PredictIt endpoints verified (RESEARCH §3) |
| Geometry | Not started; TIGER 2026 URLs known, Missouri trap documented (RESEARCH §5) |
| Config split (`config/*.json`) | Not started (PLAN §3.6) |

Until the results rebuild lands, `lib/feeds.mjs` still parses Elections BC and `config.json` still describes BC parties. Do not delete them until the US equivalents exist; the BC build must stay deployable as a fallback.

## Target architecture

No build step, no frontend framework, plain Node 22+ ESM. Static `public/` plus one Vercel function per `api/*.mjs`.

```
public/
  index.html          window markup, Waybar-style bar, launcher and help overlays; d3 7.9 from cdnjs
  dashboard.js        window types and data UI (map, chamber, feed, balance, race, races, stream, news, social, markets, timeline)
  wm.js               Hyprland-style tiling window manager, no dependencies, exposes window.wm
  style.css           dark theme; colour tokens on :root
  data/               simplified GeoJSON/TopoJSON: states, counties, 2026 congressional districts
lib/
  sources/*.mjs       one adapter per upstream (nc, va, ga, ca, clarity, cnn, kalshi, polymarket, predictit, bluesky, rss, youtube)
  model.mjs           race model, normalisation, race_id rules
  diff.mjs            snapshot differ → events
  store.mjs           store client (Supabase/Postgres), read and write helpers
  feeds.mjs           RSS merge/de-dup (kept from BC)
  article.mjs         reader-mode extraction (kept from BC)
api/
  poll.mjs            scheduler-triggered fan-out poll; secret header; writes the store
  races.mjs, events.mjs, markets.mjs, live.mjs, news.mjs, article.mjs, config.mjs
  _respond.mjs        shared CDN cache headers (underscore = not a route)
config/
  races.json          manifest of every contest (ids, candidates, ratings, poll close, source keys)
  sources.json        streams, feeds, social lists, market contracts, intervals
  presets.json        named layouts and window-type defaults
  parties.json        party ids and colours
scripts/
  build-races.mjs     OpenFEC + Wikipedia/270toWin + Downballot → config/races.json
  build-geo.mjs       TIGER 2026 (+ MO from 2025) → simplified, rewound GeoJSON
  replay.mjs          feed saved fixtures through the differ to exercise every event type
server.mjs            LOCAL ONLY: static server + the same /api routes
tests/                headless-browser and mock-API regression scripts
docs/                 PLAN.md, RESEARCH.md
```

Key decisions (reasoning in `docs/PLAN.md`):
- **Read endpoints serve from the store, never from upstream.** An external scheduler (GitHub Actions or the owner's Home Assistant box; Vercel Cron if the Pro plan is bought) calls `/api/poll` every 30–60 s. Vercel Hobby cron runs once a day and cannot do this.
- **Events are first-class.** The differ writes `race_called`, `lead_change`, `vote_batch`, `margin_tight`, `flip_called`, `runoff`, `market_move`, `poll_close` rows. The live feed, ticker, toasts and flips counter all read that table; nothing else computes them.
- **Windows are instances of types** with their own settings, so two maps or three pundit feeds can coexist. Layout plus instances serialise to localStorage and to a `#l=` URL hash for sharing. Cookies are not used for layout.
- **Calls come from sources (CNN/AP editorial status), never from this code.** Any in-house margin rule is an optional "unofficial lean" badge, off by default. The BC `callRiding` heuristic is retired.

## Data sources and their quirks (short form; full detail in RESEARCH.md)

- **Results, legal and free:** NC `er.ncsbe.gov/enr/20261103/data/results_0.txt` (JSON, already live); VA and GA Enhanced Voting `/results/public/api/elections/{State}/{slug}/ballot-items` (GA 2026 slug not published yet); CA `api.sos.ca.gov` (test feeds Oct 28 and 31, 8am–noon PT); CO/IA Clarity (`elections.json` → `current_ver.txt` → `json/en/summary.json`, refetch only on version change). OH, TX, AZ, FL, NV, MT, KS returned 403 to curl; test from a deployed function before relying on them. PA, MI, WI, ME, NH have no usable statewide feed.
- **Results, grey:** CNN `politics.api.cnn.io/results/national-races/2026-{SG,HG,GG}.json` and `race/`, `county-races/` files. AP-sourced, unauthenticated, includes `editorialStatus: "called"`. Poll at 60 s, server-side, attribute, never archive raw. **NYT `static01.nyt.com` JSON is not used**: its ToS and robots.txt forbid it.
- **Not obtainable:** AP Elections API, DDHQ API, Edison/NEP, Google. Spend no time on them.
- **Markets:** Kalshi `api.elections.kalshi.com/trade-api/v2` (`CONTROLS-2026-D/R`, `CONTROLH-2026-D/R`, `SENATE{ST}-26-*`, `GOVPARTY{ST}-26`, `HOUSE{ST}{N}-26`; `cache-control` 15 s), Polymarket Gamma `gamma-api.polymarket.com` + CLOB `clob.polymarket.com/midpoint` (`balance-of-power-2026-midterms`, `which-party-will-win-the-senate-in-2026`, `…-house-…`; official iframe embed at embed.polymarket.com), PredictIt `predictit.org/api/marketdata/all/` (needs a browser-like UA; 8155 Senate, 8157 House). All no-auth for reads.
- **Geometry:** Census TIGER 2026 `tl_2026_{FIPS}_cd120.zip` per state, released Oct 14. **Missouri's 2026 file encodes the blocked HB1 map; use the 2025 `cd119` file for MO.** Nine states have new maps (AL, CA, FL, LA, NC, OH, TN, TX, UT). us-atlas for states/counties. Rewind rings for d3-geo (the BC map rendered as a globe-filling blob until this was done).
- **Timing:** poll closes run 6 pm ET (IN, KY) to 1 am (AK Aleutians); full table in RESEARCH §6. Slow: CA (mail through Nov 10), AK (RCV Nov 18), NV (Nov 7), PA (no pre-canvass), ME (RCV). Runoffs: GA Dec 1, LA House Dec 12. Exit polls (The Voter Poll by SSRS) release at 5 pm ET and at poll close.
- **Streams:** YouTube `search.list` is capped at 100 calls/day; resolve live video ids by fetching `youtube.com/channel/ID/live` and parsing the canonical link plus `isLiveNow`, confirm with one `videos.list` batch. `embed/live_stream?channel=` works only for single-stream channels and needs a Referer. Channel ids for ~45 outlets are in RESEARCH §9. Twitch needs `parent=` per host. Fox, CNN TV and MS NOW main feeds are not free.
- **Social:** X free paths are dead (429/410/451 on Oct 25); keep X token-gated with `since_id`. Bluesky public API (`public.api.bsky.app/xrpc/app.bsky.feed.*`) is the pundit backbone; verify endpoints before building. Truth Social source for the Trump feed is an open gap.
- **Candidates and finance:** OpenFEC (`api.open.fec.gov/v1/candidates/search/`, 1,000 req/hr with a free key). Ballotpedia is paid. The Downballot's 2024-presidential-by-2026-district Google Sheet is the baseline for swing columns.
- **News:** the BC RSS merger works as-is; the US feed list still needs building (open gap).

## Kept from the BC build: things that are true and should stay true

- **Reader window** (`lib/article.mjs`): decodes Google News links in two steps (`news.google.com/articles/<id>` for `data-n-a-sg`/`data-n-a-ts`, then POST to `/_/DotsSplashUi/data/batchexecute` rpc `Fbv4je`), runs Readability on linkedom, sanitises server-side, renders in a `srcdoc` iframe with no `allow-scripts`. SSRF guard rejects IP literals, localhost, `.local`, `.internal`. "Original page" tab only when response headers allow framing. Cached 10 min in memory, 15 at the CDN.
- **Window manager** (`public/wm.js`): dwindle tree per workspace (`{id}` leaves, `{dir:'h'|'v', ratio, a, b}` splits); gaps_in 5, gaps_out 20, 2px border, 10px rounding, cyan→green active gradient; focus follows real mouse movement only (Chrome fires fake pointer events on layout change); workspaces move windows with `transform`, never re-parenting (re-parenting an iframe reloads the video); main modifier is Alt because the owner's compositor owns Super; keybinds follow Hyprland defaults (arrows focus, Shift+arrows swap, Ctrl+arrows resize, 1–9 workspaces, S special, V float, F fullscreen, J split, C close, R launcher, / help); state in localStorage `bc-dash-wm-v1` (rename when the instance refactor lands). Under 900px nothing tiles; windows stack. **Do not reintroduce GridStack, `--split-*` or `.gutter`.**
- **Vercel traps:** the project preset is "Node", which once ran a browser script as the server for every route. Keep `"framework": null` and `"buildCommand": ""` in `vercel.json`, never name a browser file `app.js`/`index.js`/`server.js`, keep `server.mjs` in `.vercelignore`, and check `npx vercel inspect <url>` lists one function per `api/*.mjs` and no catch-all. Functions read config via `createRequire`, which file tracing follows. Env changes need a redeploy.
- **CDN caching is deliberate.** `s-maxage` plus `stale-while-revalidate` so all viewers share one upstream fetch. Failed responses cache for 15 s only.
- **Design:** dark, dense, calm. Text uses text tokens, never party colours; a chip carries party identity. Validate any new party palette with the dataviz skill's palette checker for colour-blind separation on the dark surface. No emoji icons. Leading = hatched/faint, called = solid, no results = neutral grey.

## Working philosophy

1. **Probe the real data first, then build.** Every adapter starts with a saved fixture from a real fetch. NC, Kalshi, Polymarket, PredictIt, VA and CNN 2024 are fetchable today.
2. **Verify in a real browser before claiming success.** Drive headless Chromium via `tests/*.browser.mjs` and look at screenshots. Several BC bugs only appeared that way.
3. **Degrade gracefully.** Keep last good data, mark it stale, say why in the UI. On Nov 3 feeds will change shape; adapters must fail soft and log.
4. **Be cost- and quota-aware.** YouTube 100 searches/day, OpenFEC 1,000/hr, Kalshi ~20 req/s, X pay-per-read. Batch and cache. Warn before adding anything that costs money.
5. **Be legal by default.** Official feeds and market APIs freely; CNN slowly and attributed; NYT not at all; embeds only via official embed URLs.
6. **Small reversible commits.** `node --check` edited files, run the relevant test, deploy, re-probe production. Re-read before editing: another session may have touched the file.
7. **Be honest about anything unverified.** RESEARCH.md marks every claim as live-tested, from docs, secondhand or unverified. Keep that discipline in code comments and commit messages.

## Tests

Browser tests need `chromium` on PATH and a scratch directory. Start `npm start` first for local runs.

```
node tests/wm.browser.mjs     /tmp/scratch [url]  # window-manager checks with real Alt-key and mouse input
node tests/reader.browser.mjs /tmp/scratch [url]  # opens a headline in the reader, next, Esc
node tests/x-api.mock.mjs                         # mocks api.x.com: parsing, retweets, since_id, 402 handling
```

To add as the migration lands: adapter fixture tests per source, differ tests (every event type from a replayed pair of snapshots), a layout-hash round-trip test.

## Nov 3 runbook (fill in on the day)

- 5:00 pm ET: exit-poll characteristics released; GA 2026 Enhanced Voting slug should exist by now (check https://results.sos.ga.gov/results/public/Georgia/elections); set it in `config/sources.json`.
- 6:00 pm ET: CNN `2026-SG.json` / `2026-GG.json` should populate; confirm the poller sees them. Resolve live video ids for every configured channel and spot-check the carousel.
- Every hour: check scheduler liveness (staleness banner), error counts per adapter, Kalshi/Polymarket rate-limit headers.
- Keep the BC build's deploy URL as a fallback until the US build has survived the first hour of results.

## Open items

See `docs/RESEARCH.md` §12 for the research gaps (news RSS inventory, X pricing, Truth Social source, Bluesky handles, Reddit access, blocked-state feed URLs, a few landscape facts to double-check). See `docs/PLAN.md` §4 for the day-by-day build order.
