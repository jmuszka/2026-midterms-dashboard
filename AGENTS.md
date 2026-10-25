# AGENTS.md: BC Election Night dashboard

Handoff notes for the next agent session. Read this before changing anything. It records what was built, why each decision was made, and the traps already hit.

## What this is

A live election-night dashboard for the **B.C. provincial general election of 24 October 2026**: 93 seats, 47 for a majority. The user built it on the night itself, so speed and reliability mattered more than polish. Each feature was requested one at a time in short messages, and the user expects working results, not plans.

- **Production:** https://bc-election-dashboard.vercel.app (Vercel project `bc-election-dashboard`, team `jmuszkas-projects`; this folder is already linked through `.vercel/project.json`).
- **Local:** `npm install && npm start`, then open http://localhost:8787.

## Panels (windows)

Each panel is a window in the Hyprland-style window manager described below. The `data-tile` id names the window.

| Window id | Content | Data source |
|---|---|---|
| `seats` | Seat bar with majority line, plus party tiles (elected / leading / vote share) | Elections BC CSV |
| `map` | Riding map with Metro Vancouver and Greater Victoria insets; hover for tooltip, click to pin | Elections BC CSV + 2023 boundary GeoJSON |
| `detail` | The pinned riding's candidates and boxes reported | same |
| `ridings` | Filterable table of all 93 ridings | same |
| `video` | YouTube embed of CBC's "B.C. Votes 2026" stream; accepts a pasted URL; "Channel live" button | YouTube |
| `news` | Merged news feed; clicking a headline opens a reader window over the page | Google News RSS + CBC BC RSS |
| `x` | @JJ_McCullough timeline | X API v2 when a token is set, otherwise fallbacks |

## Architecture

There is no build step and no frontend framework. The server is plain Node 22 ESM.

```
public/            static site (Vercel outputDirectory)
  index.html       window markup, Waybar-style bar, launcher/help overlays; loads d3 7.9.0 from cdnjs
  dashboard.js     data UI: map, seat bar, feeds, reader window
  wm.js            Hyprland-style tiling window manager (no dependencies)
  style.css        dark theme; colour tokens on :root
  data/bc-electoral-districts-2023.geojson
lib/feeds.mjs      shared feed logic: results CSV parse + riding calls, RSS, X
lib/article.mjs    reader-mode extraction (Google News decode + Readability)
api/*.mjs          one Vercel function per route; thin wrappers over lib/
api/_respond.mjs   shared CDN cache headers (underscore = not a route)
server.mjs         LOCAL ONLY: static server + the same /api routes
config.json        every tunable: parties/colours, feeds, handle, video, thresholds
tests/             headless-browser and mock-API regression scripts
```

Routes: `/api/config`, `/api/results`, `/api/news`, `/api/tweets`, `/api/article?url=`.

## Data sources and their quirks

- **Elections BC results.** `https://electionsbcenr.blob.core.windows.net/electionsbcenr/GE-2026-10-24_Candidate.csv`; the container is publicly listable with `?restype=container&comp=list`. Elections BC republishes it about every 3 minutes. Quirks:
  - The file starts with a byte-order mark (BOM).
  - Each riding has a pseudo-candidate named `Rejected Ballots`.
  - An empty affiliation means Independent.
  - Box counts are strings like `25 of 80 (Not Verified)`.
  - Times are labelled PST but are actually Pacific time.
  - Riding codes such as `ABM` match the GeoJSON's `ED_ABBREVIATION` exactly; all 93 were verified.
  - There's also a `_Party.csv` and HTML result pages, which aren't used.
  - **elections.bc.ca itself timed out from this machine.** Don't depend on it.
- **Boundaries.** From the BC government ArcGIS service, `delivery.maps.gov.bc.ca/.../bcgw_pub_whse_admin_boundaries/MapServer/74` ("Electoral Boundaries Redistribution, 2023"), fetched as GeoJSON with `maxAllowableOffset=0.002` and stored at about 500 KB. **The polygon rings were rewound so exterior rings run clockwise, which is the convention d3-geo expects.** Without that, d3 fills the whole globe, and the map renders as one giant orange blob. If the file is ever refetched, rewind it again.
- **News.** Two RSS feeds: a Google News search for "BC election" and CBC British Columbia. They're merged, de-duplicated by normalised title, sorted newest first, and capped at 80 items.
- **Reader window.** Google News links are encoded redirects. `lib/article.mjs` decodes them in two steps: it fetches `news.google.com/articles/<id>` to read the `data-n-a-sg` and `data-n-a-ts` attributes, then POSTs to `/_/DotsSplashUi/data/batchexecute` (rpc `Fbv4je`). The publisher page is then parsed with `@mozilla/readability` on `linkedom`. Design choices:
  - Most publishers send `X-Frame-Options` or `frame-ancestors`, so the reader view is the default. The "Original page" tab only appears when the response headers allow framing.
  - Content is sanitised server-side, then rendered in an iframe with `srcdoc` and **no `allow-scripts`**.
  - An SSRF guard rejects IP literals, localhost, `.local` and `.internal` hosts. It doesn't resolve DNS, which was judged acceptable here.
  - Results are cached in memory for 10 minutes and at the CDN for 15.
- **CBC stream.** CBC Vancouver's YouTube channel is `UCiKE6mqbKmGGlNAtccn04MA`, and the default video id is `ZelFrdivB2c` (both in config). After the special ends, "Channel live" uses `embed/live_stream?channel=` to show whatever the channel is streaming.
- **X / Twitter.** This is the problem feed.
  - With `X_BEARER_TOKEN` set in Vercel env (production), `lib/feeds.mjs` calls the X API v2 `/users/30800681/tweets`. The user id is stored in config, which saves a lookup call.
  - **It uses `since_id`** because X has been pay-per-use since February 2026, at roughly $0.005 per post read. Re-reading 10 posts every 2 minutes would cost about $1.50 an hour, while `since_id` makes quiet polls free. Keep any new X features cost-aware, and warn the user before adding broad searches.
  - Errors pass X's own `title / reason / detail` through to the panel tooltip, and the last good posts stay on screen.
  - **Status at the end of the session:** the token is set, but X returns `403 client-not-enrolled`. The user's app wasn't attached to a Project in console.x.com. The user was told to move the app into a Project and probably regenerate the token. Verify with `curl https://bc-election-dashboard.vercel.app/api/tweets`.
  - Fallbacks without a token: the `syndication.twitter.com` timeline returns 429; nitter.net, xcancel, poast and twiiit mirrors are dead; X's `widgets.js` embed is the last resort and usually blocked.

## Riding calls ("Projected")

Elections BC doesn't call ridings, so the dashboard uses its own unofficial rule, `callRiding` in `lib/feeds.mjs`. The thresholds live in `config.json → projection`. A riding counts as projected when either condition holds:

- the runner-up would need more than 80% of the estimated remaining votes, with at least 25% of boxes in; or
- a `(minFrac, minMargin)` rule passes: 50% of boxes and an 8-point margin, 35% and 15 points, or 85% and 3 points.

A riding whose count is complete shows "Elected · count complete". All figures are preliminary initial counts. Mail-in and absentee ballots are counted from 6 to 10 November, with final results on 18 November. The UI must keep presenting projections as unofficial.

## Window manager: Hyprland clone (`public/wm.js`)

The user asked for the UI to "work exactly like Hyprland", the tiling Wayland compositor they run on Arch. The layout went through three versions, and only the last remains in the code:

1. Drag dividers between fixed panels.
2. A GridStack drag-and-drop grid.
3. This window manager.

**Don't bring back GridStack, `--split-*` or `.gutter`.** The window manager has no dependencies: one file of about 550 lines, wrapped in an IIFE, exposing `window.wm` for tests.

**Behaviour copied from Hyprland's defaults:**
- **Dwindle layout.** Each workspace is a binary tree whose nodes are either `{id}` (a window) or `{dir: 'h'|'v', ratio, a, b}`, where `h` means side by side. A new window splits the target window along its longer side. When it's dropped with the mouse, the side of the window the cursor is on decides which half it takes.
- **Geometry.** `gaps_in` is 5 per side (10px between windows), `gaps_out` is 20, the border is 2px and corners are rounded to 10px. The focused window's border is the gradient `rgba(51,204,255,.93) → rgba(0,255,153,.93)` at 45°. Inactive borders are `rgba(89,89,89,.67)`. Animations use the "myBezier" curve `cubic-bezier(.05,.9,.1,1.05)` from the default hyprland.conf. These values are `CFG` at the top of `wm.js` plus `--hypr-*` variables in the CSS.
- **Focus follows the mouse, but only on real movement.** The code compares pointer coordinates with the previous position. Chrome fires fake pointer events when the layout changes under a stationary cursor, and those used to steal focus after a float, swap or close. Don't switch back to `pointerenter` or `movementX`, because headless Chrome reports zero movement.
- **Workspaces 1 to 9.** Switching slides them horizontally. The bar shows workspaces that are occupied plus the active one. Windows on other workspaces are moved off-screen with `transform`, **never moved to a different parent element**. Moving an iframe in the DOM reloads it, which would restart the CBC video.
- **Special workspace (scratchpad).** Shown as an overlay with a dimmed background.
- **Floating windows.** Positions are stored as fractions of the desktop. Clicking a floating window raises it.
- **Fullscreen** covers the bar too, like Hyprland's fullscreen mode 0.
- **Close** removes the window from its tree. Closing the video window blanks its iframe, and reopening restores it. The **launcher** (wofi-style, mod+R or the bar's "Panels" button) reopens or jumps to any panel.
- **Title-bar drag (user request, not Hyprland):** dragging a window's `.panel-head` with no modifier also moves it. The move only starts after 5px of travel (`R.pending`), so clicks still work. Presses on inputs, buttons, links or forms inside the header never start a drag. It's disabled on phones.
- **Mouse:** mod+left-drag moves a window (dropping it on another window splits that one) and mod+right-drag resizes from the nearest edge. Dragging a gap between windows resizes that split, like Hyprland's `resize_on_border`. mod+scroll cycles workspaces.
- **Default workspaces.** Workspace 1 has seat projection above the map on the left, and the CBC stream above News and X on the right. Workspace 2 has the ridings table and riding detail.

**Keybinds** use Hyprland's default letters: arrows move focus, Shift+arrows swap windows, Ctrl+arrows resize (Alt mode only), 1–9 switch workspaces, Shift+1–9 move a window to one, S toggles the special workspace, Shift+S sends a window there, V toggles floating, F is fullscreen, J toggles split direction, C closes, R opens the launcher and / opens help.
- **The modifier is Alt, not Super.** The user's real compositor captures Super before the browser sees it. The help overlay can switch the modifier to Ctrl+Alt, which disables keyboard resize.
- **Browser caveat (not verified in a real browser):** Chrome and Firefox on Linux use Alt+1–8 to switch tabs. The page calls `preventDefault`, but the browser may still take those keys. Clicking the workspace buttons in the bar always works.
- **Iframes.** While Alt is held, `body.mod-down` turns off pointer events on iframes, so mod+drag works over the video. If focus ends up inside an iframe, moving the pointer back onto the page blurs it so the keybinds work again.

**Other details:**
- **Saved state** lives in `localStorage` key `bc-dash-wm-v1`: `{ws, special, floating, active, focus, lastFocus, mod}`, one copy per viewer. Reset is in the help overlay.
- **Phones (under 900px):** no tiling. Every window stacks in a fixed order and the page scrolls.
- **Tooltip:** the map tooltip is `position: fixed` on `<body>`, so window edges don't clip it.

## Vercel deployment

- Deploy with `npx vercel --prod`, or with `npx vercel build --prod && npx vercel deploy --prebuilt --prod` to inspect `.vercel/output` first.
- **Big trap, already hit once:** the project's saved preset is "Node", which auto-detects a server entrypoint. It once picked the browser script `public/app.js` and ran it as the server for every route, which crashed with `document is not defined`. The fixes:
  - `vercel.json` sets `"framework": null` and `"buildCommand": ""`.
  - The browser script is named `dashboard.js`, not `app.js`, `index.js` or `server.js`.
  - `.vercelignore` excludes `server.mjs`.
  - After any config change, check `npx vercel inspect <url>`. It must list one function per `api/*.mjs` and no catch-all `index` function.
- Function bundles read `config.json` via `createRequire`, which Vercel's file tracing follows.
- CDN caching is deliberate. `s-maxage` is 30s for results and 90s for news and X, with stale-while-revalidate, so all viewers share one upstream fetch. Failed X responses are cached for only 15s, so the panel recovers quickly.
- Environment variable: `X_BEARER_TOKEN` (production). Vercel only picks up env changes on a redeploy.

## Design and colour

- Dark theme, dense but calm. Text uses text tokens, never party colours; a colour chip beside the text carries party identity.
- Party colours: CON `#4A8BE8`, NDP `#E06C10`, GRN `#3DA35D`, OneBC `#A66BD6`, CentreBC `#BD8F22`. The first five were checked with the dataviz skill's palette validator for colour-blind separation on the dark surface, and adjacent pairs passed. Run the validator again before changing them.
- On the map, elected or projected ridings are solid. Leading ridings are fainter when fewer boxes are in (opacity runs from 0.3 to 0.8). Ridings with no results are neutral grey. On the seat bar, leading seats are hatched and elected seats solid.
- No emoji icons. The legend and the table view keep identity from depending on colour alone.

## Working philosophy (how this session operated)

1. **Verify in a real browser before claiming success.** Every feature was driven in headless Chromium via the DevTools protocol (`tests/*.browser.mjs`) and checked from screenshots. Several bugs only showed up that way: the globe-fill map, hidden resize handles, centred titles, the toggle shown despite `hidden`, and focus being stolen when the layout changed.
2. **Probe the real data first, then build.** Feed URLs, CSV columns and API responses were all fetched and inspected before writing parsers.
3. **Read the logs and fix the root cause.** The Vercel failure was diagnosed from `vercel logs`, not guessed. X errors surface X's own message.
4. **Degrade gracefully.** Every feed keeps its last good data if a refresh fails, marks it stale, and states its failure in the UI.
5. **Be cost-aware and secure by default.** Keep caching, `since_id`, the sandboxed reader and the SSRF guard. Secrets go into Vercel through `vercel env add`, never through chat or files.
6. **Make small, reversible changes and test each one.** Run `node --check` on edited files, run the relevant test, then deploy and re-probe production.
7. **Be honest about anything unverified.** For example, the YouTube embed can't play in headless Chromium, and the X API path was only tested against a mock.

## Tests

The browser tests need `chromium` on PATH and a scratch directory for the browser profile and screenshots. Start `npm start` first to test locally.

```
node tests/wm.browser.mjs     /tmp/scratch [url]  # 34 window-manager checks with real Alt-key and mouse input; all must PASS
node tests/reader.browser.mjs /tmp/scratch [url]  # opens a headline in the reader, next, Esc
node tests/x-api.mock.mjs                         # mocks api.x.com: parsing, retweets, since_id, 402 handling
```

## Open items / ideas not yet built

- The X panel is waiting on the user's console.x.com Project fix.
- The user was offered more X panels: other accounts, a hashtag search (expensive), or an X List feed. Only build these if asked, and warn about cost first.
- `public/data` boundaries are simplified. The two insets can show clipped neighbouring ridings as context, which is intentional.
- There's no git repository yet. If you initialise one, `.gitignore` already excludes `node_modules` and `.vercel`.
