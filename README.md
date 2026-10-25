# Midterms 2026 Live

A live, customisable dashboard for the **US midterm elections of Tuesday 3 November 2026**: Senate, House and governor results, maps, seat charts, a live event feed, news streams, news, pundits, Trump's Truth Social posts and prediction markets. Everything sits in a Hyprland-style tiling window manager, and a whole layout can be shared as a link.

```
npm install
npm start                 # http://localhost:8787  (polls every source in the background)
open http://localhost:8787/?sim=1   # simulated election night at 30x speed, for trying every view
```

## What's on screen

Every window is an instance of a type with its own settings (the gear in its title bar). Open new ones from **Panels** (or Alt+R); presets replace the whole layout.

| Window | What it shows | Data |
|---|---|---|
| Balance of power | Senate, House and governor seat bars: won, leading, not up, not reporting; majority line, net change, flips, market odds | results + `config/sources.json → balance` |
| Results map | States (Senate, governor) or the 435 districts as drawn for 2026; colour by live result, ratings consensus, market odds, flips, or shift vs the 2024 presidential vote; zoom and pan | results, markets, `public/data/*` |
| Chamber seats | Aerial hemicycle of all 100 Senate seats, 435 House seats or 50 governorships | results |
| Live feed | Calls, flips, lead changes, vote batches, tight margins, market moves and poll closings, newest first; ticker mode; toasts for big calls | `/api/events` |
| Race card | One race in depth: candidates, expected vote, every rater's rating, each market's odds, 2024 baseline, counties | results, manifest, markets |
| Race browser | Every contest, filterable (competitive, toss-ups, counting, margin under 2, flips) and sortable | results, manifest |
| Poll closings | 6 pm–1 am ET timeline, countdown, slow-count and runoff states | manifest, `config/states.json` |
| Live stream | Carousel over ~34 channels (networks, independents, international, local); live status and the live video id resolved server-side; Twitch and Kick; paste any YouTube link | `/api/streams` |
| News | Lanes: national, analysis, battleground states, race calls; click a headline for the reader window | RSS feeds in `config/sources.json` |
| Social | Election analysts (Bluesky), Donald Trump on Truth Social, analysts on X (needs `X_BEARER_TOKEN`) | `/api/social?list=` |
| Prediction markets | Senate and House control on Kalshi, Polymarket and PredictIt, 48-hour history, both-chambers combo, race odds | `/api/markets` |
| Google Trends | What the US is searching | trending RSS |
| Stock market | Indexes, overnight futures, big tech, conglomerates, policy-sensitive stocks, yields, dollar, oil, gold, crypto: overview (headline tiles, heatmap, movers), tiles with sparklines, small-multiple charts, table; trading session per symbol; replays with the timeline | CNBC quotes (30 s) and intraday charts (5 min) |

**Sharing:** the **Share** button copies a link whose `#l=` fragment carries the full layout and every window's settings. Your own layout is remembered in this browser.

## Where the numbers come from

Full research with URLs and verdicts: [`docs/RESEARCH.md`](docs/RESEARCH.md).

- **Results and race calls:** CNN's results JSON (AP data) for every race, plus the official feeds from North Carolina, Virginia, Georgia, Colorado and Iowa, whose counts take over when they are ahead. **Calls are only shown when a source makes them.**
- **Markets:** Kalshi, Polymarket and PredictIt public APIs, mapped to all 506 races by `scripts/build-markets.mjs`.
- **Stocks:** CNBC's quote and chart services (no key), groups and symbols in `config/sources.json → stocks`.
- **Races, candidates, ratings:** Wikipedia's 2026 election and ratings pages plus The Downballot's 2024 presidential results on 2026 lines, compiled by `scripts/build-races.mjs`.
- **Maps:** Census TIGERweb 120th-Congress districts (Missouri uses its 2022 lines, because the Census file still holds the blocked HB1 map), us-atlas states and counties, built by `scripts/build-geo.mjs`.

## How it runs

```
public/                  static site: index.html, style.css, js/ (ES modules, no build step), data/ (TopoJSON)
api/[route].mjs          the one Vercel function; routes live in lib/routes.mjs
lib/poll.mjs             the poller: runs due tasks, writes snapshots, diffs them into events
lib/store.mjs            memory, file (STORE_FILE) or Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
lib/sources/*.mjs        one adapter per upstream
lib/sim.mjs              the simulated election night (?sim=1)
config/                  races.json (generated), markets.json (generated), sources.json, presets.json, parties.json, states.json
scripts/                 build-races, build-markets, build-geo, poller
server.mjs               local server + background poll loop
```

**Election night:** the owner's machine runs `node scripts/scraper.mjs`, the only writer to Supabase, and the deployed site runs with `READ_ONLY=1`, reading Supabase and never calling upstream sources. How to run it, what it writes and how the site behaves without it: [`docs/SCRAPER.md`](docs/SCRAPER.md).

**Timeline:** a strip under the bar scrubs the whole recorded night; every window, including the live streams, shows that moment. See [`docs/SCRUBBER.md`](docs/SCRUBBER.md).

Without any setup, read endpoints refresh from upstream when their copy is stale and the CDN shares each response between viewers, as the BC build did. For one shared copy and a complete event history across serverless instances, connect Supabase (run `db/schema.sql`, set the two env vars) and run a scheduler against `/api/poll` with `POLL_SECRET` set: `.github/workflows/poll.yml`, `npm run poller`, or Vercel Cron on the Pro plan. Vercel Hobby crons run only once a day.

## Deploy

```
npx vercel --prod
```

Optional environment variables: `X_BEARER_TOKEN` (X analysts list; billed per post read), `YOUTUBE_API_KEY` (viewer counts), `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (shared store), `POLL_SECRET` (protects `/api/poll`).

## Tests

```
npm test                      # offline: parsers on saved real responses, merge, differ, simulator, social
npm start & npm run test:browser   # headless Chromium: every view, reader, share link, phone width, window manager
```

## Refreshing the generated config

```
npm run build:races     # re-pull Wikipedia + Downballot (candidates and ratings change until election day)
npm run build:markets   # re-map market ids (new House markets get listed)
npm run build:geo       # only if district lines change
```
