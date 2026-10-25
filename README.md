# BC Election Night 2026 dashboard

Live dashboard for the October 24, 2026 B.C. provincial election.

```
npm install
npm start          # local: http://localhost:8787
```

## Deploy to Vercel

The repo is already laid out for Vercel: `public/` is served as static files and each file in `api/` is a serverless function. No build step.

```
npx vercel login
npx vercel --prod
```

Accept the defaults when prompted (framework: Other, no build command). API responses carry `s-maxage` headers, so Vercel's CDN shares one upstream fetch per window across every viewer instead of hitting Elections BC per visitor.

## Panels

The panels are windows in a Hyprland-style tiling window manager: dwindle tiling, workspaces, floating windows, a scratchpad, and Hyprland's default keybinds with **Alt** as the modifier. Press Alt+/ for the full list. See AGENTS.md for details.


| Panel | Source | Refresh |
|---|---|---|
| Results map + seat projection | Elections BC election-night CSVs (`GE-2026-10-24_Candidate.csv`) on `electionsbcenr.blob.core.windows.net`; Elections BC updates them every ~3 min | 60 s |
| CBC live stream | YouTube embed of CBC's *B.C. Votes 2026* stream (`youtube.videoId` in config); "Channel live" button switches to whatever the CBC News channel is streaming | — |
| News | Google News RSS search for "BC election" + CBC British Columbia RSS, merged and de-duplicated | 120 s |
| News reader window | Clicking a headline opens it in a pop-up reader view: `/api/article` decodes Google News redirect links, fetches the publisher page, and extracts the text with Mozilla Readability. Shown in a script-free sandboxed iframe. Sites that allow framing also get an "Original page" tab. Ctrl/Cmd-click opens the real site in a new tab | on demand, cached 15 min |
| @JJ_McCullough on X | Server tries X's syndication endpoint and any `twitter.rssMirrors`; if those are blocked the page falls back to X's official embedded timeline widget | 120 s |

Riding boundaries: BC Data Catalogue, *Provincial Electoral Districts – Electoral Boundaries Redistribution 2023* (`data/bc-electoral-districts-2023.geojson`, simplified).

## X API (for the @JJ_McCullough panel)

Without a token the panel falls back to X's embed widget, which X often blocks. With the official API:

1. Sign in at https://console.x.com, create a Project and App, and buy a few dollars of credits (reads are pay-per-use).
2. Copy the App's **Bearer Token** (Keys and tokens tab).
3. Add it and redeploy:
   ```
   npx vercel env add X_BEARER_TOKEN production
   npx vercel --prod
   ```
   Locally: `X_BEARER_TOKEN=... npm start`.

The function polls every 2 minutes with `since_id`, so it only pays for posts it hasn't seen. Errors such as running out of credits show in the panel's tooltip while the last posts stay on screen.

## Projection

Elections BC does not call ridings. The "Projected" badge is an unofficial heuristic computed in `server.mjs` (`callRiding`) with thresholds in `config.json → projection`: a riding is projected when the runner-up would need more than 80% of the estimated remaining votes, or when the margin exceeds a threshold at a given share of ballot boxes reported. Ridings whose initial count is complete show "Elected · count complete". All numbers are preliminary initial-count figures; mail-in and absentee ballots are counted in the final count (Nov 6–10).

## Config

Everything lives in `config.json`: port, Elections BC event prefix, party colours, news feeds, X handle, YouTube video/channel, refresh intervals, projection thresholds. Restart the server after editing.
