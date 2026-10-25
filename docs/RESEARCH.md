# US Midterms 2026 — data-source research

Compiled 2026-10-25, nine days before election day (Tuesday 3 November 2026). This is the merged output of several research passes (web search plus live `curl` probes from a Linux box). It is the reference for every feed the dashboard will consume.

Legend: **[live]** = the endpoint returned real data on 2026-10-25. **[docs]** = read from the vendor's own documentation. **[secondhand]** = from news coverage or a third-party write-up. **[unverified]** = could not be confirmed this session; treat as a lead, not a fact.

Two research passes (news RSS feeds and current X API pricing) were cut off by a rate limit before reporting. Their topics are listed under "Open gaps" at the end.

---

## 1. Quick verdicts

| Source | Verdict | Why |
|---|---|---|
| Kalshi REST | free, easy, legal | Public read endpoints, no key, 2026 control + per-race markets live |
| Polymarket Gamma + CLOB | free, easy, legal | Public read endpoints, no key, official iframe embed |
| PredictIt `marketdata/all` | free, easy | One JSON blob, no auth, needs a browser-like UA |
| Manifold v0 | free, easy | Public search API |
| NC `er.ncsbe.gov` JSON | free, easy, legal | Already live for 2026-11-03 with zero counts |
| VA Enhanced Voting API | free, easy, legal | 2026-November-General already published |
| GA Enhanced Voting API | free, easy once slug exists | 2024 slug live; 2026 slug not yet published |
| CA `api.sos.ca.gov` | free, documented, legal | Official media API, test runs Oct 28 and 31 |
| CO / IA Clarity JSON | free, stable, undocumented | Verified on CO |
| OH NIST XML | fragile | Cloudflare 403 to curl; pattern unconfirmed |
| TX `results.texas-election.com` | fragile | JSON exists; Cloudflare 403 from datacenter IPs |
| AZ, FL, MT, KS, NV state sites | fragile | 403 or Incapsula to curl; test from Vercel region |
| PA, MI, WI, ME, NH state sites | no feed | County-level or PDF only |
| CNN `politics.api.cnn.io` | free, fragile, grey | Unauthenticated AP-sourced JSON; 2026 keys already exist |
| NYT `static01.nyt.com` JSON | free, fragile, ToS violation | Richest schema; NYT ToS and robots.txt forbid scraping |
| AP Elections API | not obtainable | Enterprise sales only, no hobbyist tier |
| Decision Desk HQ API | not obtainable | Enterprise from ~$5k; $24.99 Votes Pro is a dashboard, not an API |
| Edison / NEP | not obtainable | Never public; networks moved to AP for 2026 |
| Google results | no API | Civic Information API has no results endpoint |
| YouTube embeds | free | Channel IDs below; see quota and multi-stream caveats |
| Twitch player + chat embed | free, easy | Needs `parent` param per host |
| Kick player embed | free, undocumented | `player.kick.com/<slug>` |
| Rumble embed | fragile | Scrape embed ID from channel page |
| Google Trends RSS | free, easy | `trends.google.com/trending/rss?geo=US` |
| Google Trends API | not feasible | Alpha, application-only, 48h lag |
| OpenFEC | free with key | 1,000 req/hr; doubles as candidate roster |
| Cook / Sabato / Inside Elections | manual or mirror | Cook 403s scripts; use 270toWin and Wikipedia tables |
| UF Election Lab early vote | manual | No export; CC BY-NC-ND |
| Ballotpedia data | paid | Contact sales |

---

## 2. Live results

### 2.1 Not obtainable in time

- **AP Elections API.** Key required even for the Query Explorer; contact `elections_api_info@ap.org`; no published pricing, no free or hobbyist tier. All major networks switched to AP data for 2026, Kalshi licenses AP calls, Google's search module is AP-powered. Overview PDF: https://developer.aptechlab.com/ap-elections-api/AP_Elections_API_Overview.pdf. Coverage: https://www.thewrap.com/top-news-networks-shift-to-ap-data-for-2026-2028-elections/, https://www.axios.com/2026/03/02/kalshi-ap-elections-data. **[docs]**
- **Decision Desk HQ.** API is OAuth, licensed, enterprise plans from about $5,000 (docs at https://docs.decisiondeskhq.com/). Consumer product DDHQ Votes: free tier (5-race watchlist), Votes Pro $24.99 one-time for the 2026 cycle (dashboard only), https://votes.decisiondeskhq.com/pricing. Free race pages are viewable, e.g. https://votes.decisiondeskhq.com/races/2026-11-03/michigan-us-senate-general-election. Forecast page https://votes.decisiondeskhq.com/forecast/2026. **[secondhand, pricing page sits behind a bot checkpoint]**
- **Edison Research / National Election Pool.** Edison acquired by SSRS; data never public. **[docs]**
- **Google.** No results API. Civic Information API covers polling places and candidates only; its `representatives` endpoints shut down 2025-04-30. **[docs]**

### 2.2 Official state feeds

**North Carolina [live]** — best state feed in the country. Static JSON on S3-style hosting, already published for 2026-11-03 with zero counts.
- Statewide: `https://er.ncsbe.gov/enr/20261103/data/results_0.txt` (JSON despite the extension, ~182 KB today)
- Counties: `results_1.txt` … `results_100.txt`, alphabetical; mapping in `data/county.txt`; also `data/contest.txt`, `data/office.txt`
- Fields: `cnm` contest, `bnm` candidate, `pty` party, `vct` votes, `pct`, `prt`/`ptl` precincts reporting/total, `evc` early, `ovc` election-day, `avc` absentee, `pvc` provisional, `ogl` office group (FED/NCS/NCH/JUD/LOC)
- Portal refreshes every 5–10 min: https://er.ncsbe.gov/?election_dt=11/03/2026. Docs: https://www.ncsbe.gov/results-data/election-results

**Virginia [live]** — Enhanced Voting platform.
- Meta: `https://enr.elections.virginia.gov/results/public/api/elections/Virginia/2026-November-General` (returns `precinctsReporting`, `lastUpdated`, `nextUpdateAt`)
- Contests: `…/2026-November-General/ballot-items` (~255 KB: `{data:[{name, voteFor, voteTotal, reportingStatus, summaryResults, isCloseRace, contestType}], totalRecordCount}`)
- Also `/localities` (per-county, ~1 MB), `/stats`, `/turnout`, `/vr`. Portal https://www.elections.virginia.gov/results/

**Georgia [live for 2024, 2026 slug pending]** — same Enhanced Voting platform (GA left Clarity after June 2024).
- `https://results.sos.ga.gov/results/public/api/elections/Georgia/2024NovGen` and `/ballot-items` (295 items). `2026NovGen` returned 404 on Oct 25; watch https://results.sos.ga.gov/results/public/Georgia/elections for the slug.
- GA runs a Dec 1 runoff for any race under 50%.

**California [live, officially documented]**
- `https://api.sos.ca.gov/returns/status` (per-county precincts reporting); contest endpoints like `https://api.sos.ca.gov/returns/secretary-of-state/county/los-angeles` (some returned 500 between elections)
- Docs: https://www.sos.ca.gov/media, API doc v21 https://cms.cdn.sos.ca.gov/media/3-api-documentation-v21.pdf, media guide https://cms.cdn.sos.ca.gov/media/1-media-guide-v21.pdf
- **Test runs Oct 21, 28, 31, 8am–noon PT** — use Oct 28 and 31 to validate the parser. No auth. Also pipe-delimited files (`C26GG.txt`, `V26GG.txt`).

**Colorado and Iowa [CO live]** — Clarity/Scytl. Iowa serves the identical Clarity bundle (not individually tested).

**Ohio [unverified]** — https://liveresults.ohiosos.gov/ is Cloudflare-403 to curl. Site text says results are in NIST 1500-100 XML updated every three minutes. URL pattern unconfirmed.

**Texas [partially live]** — Angular app at https://results.texas-election.com/. Pattern: `/static/data/election/{electionId}/Version.json` (verified: `.../44144/Version.json` → `{"___versionNo":262,"elecDate":"11032020"}`), then `/election/{id}/{version}/StateWide.json|Federal.json|Districted.json|County.json|Race.json|OfficeSummary.json|Lookups.json`. Most paths return Cloudflare 403 from a datacenter IP. Risky from Vercel.

**Blocked to curl on Oct 25 (test from the Vercel region before relying on them):** AZ https://results.arizona.vote/, FL https://floridaelectionwatch.gov/ (legacy https://results.elections.myflorida.com/), MT https://electionresults.mt.gov/, KS https://ent.sos.ks.gov/kssos_ent.html, NV https://silverstateelection.nv.gov/ (Incapsula). NE https://electionresults.nebraska.gov/ returned HTML and references XML (not explored).

**No usable statewide feed:** PA (Incapsula ASP.NET site, bulk files only after the election), MI (county/clerk level; statewide page unreachable), WI (WEC publishes nothing on election night; AP compiles), ME and NH (spreadsheets later). **Unverified:** AK, NJ, NY, MN (MN has documented semicolon-delimited "media results" files but the 2026 index was not located).

A 2026 hobby repo with a 50-state feed registry worth mining: https://github.com/earlsimms/mo-election-night-2026 (`registry/state_feeds_all50.json`; adapters for `nc_enr, ga_ev, mn_txt, pa_api, fl_dos, wa_sos, clarity`). **[unverified contents]**

### 2.3 Vendor platform patterns

**Clarity (`results.enr.clarityelections.com/{ST}/…`)** — CO, IA, many counties. **[live on CO]**
1. `GET /{ST}/elections.json` → gzip JSON `[{State, EID, ElectionName, Date, County, CountyId}]`, newest first
2. `GET /{ST}/{EID}/current_ver.txt` → version integer
3. `GET /{ST}/{EID}/{ver}/json/en/summary.json` → `[{C: contest, CH: [candidates], P: [party ids], V: [votes], PCT, T: total, PR: precincts reporting, TP: total precincts, W: [winner flags], IsRCV}]`
4. `json/sum.json`, `json/details.json` (county/precinct), `json/en/electionsettings.json`, `reports/detailxml.zip`, `reports/summary.zip`
Poll `current_ver.txt` and refetch only on change. Some jurisdictions return nginx 403 (AR, old GA EIDs). Parsers: https://github.com/openelections/clarify, https://github.com/courierjournal/clarity-elections-finder.

**Enhanced Voting (GA, VA)** — base `/results/public/api`. `/elections/{State}/{slug}` meta, `/ballot-items`, `/localities`, `/stats`, `/turnout`, `/vr`. CORS unknown, so proxy through a function. Vendor https://www.enhancedvoting.com/.

### 2.4 News-organisation JSON (grey area)

**CNN `politics.api.cnn.io` [live, no auth]**
- National: `https://politics.api.cnn.io/results/national-races/2024-SG.json` (35 Senate races), `2024-HG.json`, `2024-PG.json`, `2022-SG.json`. **`2026-HG.json` already returns 200** with six special-election House races, so the 2026 keys are `2026-SG`, `2026-HG`, `2026-GG` (SG/GG 404 until populated).
- Per race: `/results/race/2024-PG-PA.json`; counties: `/results/county-races/2024-PG-PA.json` (67 counties). Expect `race/2026-SG-GA.json`, `county-races/2026-SG-GA.json`.
- Fields: `editorialStatus` ("called"), `winnerBopPartyId`, `isSwitch`, `percentReporting`, `totalVote`, `raceEmbargo{pollsClosed, callsReleased}`, `candidates[{fullName, candidatePartyCode, voteNum, votePercentNum, winner, isIncumbent}]`, `voteTimestamp`.
- No robots.txt on that host; CNN ToS not reviewed. It is CNN's licensed AP data. Poll at 60 s or slower, server-side, attribute, do not archive or redistribute raw files.

**NYT `static01.nyt.com/elections-assets/pages/data/{YYYY-MM-DD}/results-{slug}.json` [live for 2024 and 2025]**
- 2024 `results-president.json`, `results-senate.json`, `results-house.json`, `results-governor.json`, per-state `results-georgia-president.json` (159 county reporting units) all 200. 2025 `results-new-jersey-governor.json`, `results-virginia-governor.json` 200. **2026 paths 404 until NYT publishes**, historically around 6 pm ET on election day; expect `/2026-11-03/results-senate.json`, `results-house.json`, `results-governor.json`, plus per-state files.
- Schema: top-level `races[]`, `pageConfig` (polling interval 10 s), `resultsMeta`, `partyControlData` (seats, to_win, flips), `pollClosingTimes[]`, `partyControlTimeseriesData`. Per race: `nyt_id` (`PA-G-S-2024-11-05`), `rating`, `outcome{won[], called_by:["ap"]}`, `candidate_metadata`, `reporting_units[]` with `eevp` (expected vote %), `precincts_reporting/total`, `total_expected_vote`, `candidates[].votes.total`, `nyt_model_estimates` (null when the needle is off), `historical_2020_pres`. Per-state files add `precincts`, `timeseries`.
- **NYT ToS §2.1/§3.2 and `static01.nyt.com/robots.txt` explicitly prohibit automated collection and caching of their data.** Prior art exists (https://github.com/alex/nyt-2024-election-scraper, https://simonwillison.net/2020/Nov/6/nyt-2020-election-scraper/) and nobody was sued, but a public Vercel app re-serving NYT data is the riskiest profile. Decision for this project: **do not ship NYT as a source.** Keep the loader shape compatible so it could be switched on privately if ever wanted.
- A 2026 PWA targeting exactly these URLs, useful as a schema reference: https://github.com/toogreen/midterms2026.

**Politico, WaPo, NBC, Fox, ABC, CBS, Guardian, Reuters, Bloomberg:** no public endpoint found or verified; Politico 403s non-browser clients. All run on AP data, so they add nothing over CNN.

### 2.5 Recommended results stack

1. **Prediction markets as the headline "who is winning" layer** (section 3). Legal, free, live now.
2. **Official state feeds where they exist:** NC, VA, GA, CA, CO, IA, plus OH/TX/AZ/FL/NV/MT/KS if they turn out to be reachable from Vercel's region. Real vote counts and precinct percentages, no ToS issue (public records).
3. **CNN JSON as the national gap-filler and race-call source** for the states without feeds (PA, MI, WI, ME, NH, AK, NJ, NY, MN, NE and the blocked ones). Grey area, mitigated by slow polling and attribution.
4. **No AP, DDHQ, Edison, Google.** Zero time spent.

Normalize everything to one race model borrowed from `elex`: `{race_id, chamber, state, district, candidates[{name, party, votes, incumbent}], precincts_reporting, precincts_total, expected_pct, called, called_by, updated_at, source}`.

---

## 3. Prediction markets

### Kalshi [live, no auth for reads]
- Hosts: `https://api.elections.kalshi.com/trade-api/v2` works; docs name `https://external-api.kalshi.com/trade-api/v2` as canonical. Responses carry `cache-control: public, max-age=15`, so poll every 15–30 s.
- Unauthenticated: `GET /series/{ticker}`, `GET /markets?series_ticker=X&status=open`, `GET /events/{event_ticker}?with_nested_markets=true`, `GET /markets/{ticker}`, `GET /markets/{ticker}/orderbook`, `GET /series?category=Elections&limit=2000` (2,325 series). Cursor pagination. Docs: https://docs.kalshi.com/getting_started/quick_start_market_data
- Rate limits: token bucket, Basic 200 read tokens/s, most calls 10 tokens (~20 req/s); 429 on excess. https://docs.kalshi.com/getting_started/rate_limits
- Websocket needs an RSA-signed API key at handshake; poll REST instead.
- **Tickers (prices on Oct 25):**
  - Senate control: `CONTROLS-2026-D` 0.63 / `CONTROLS-2026-R` 0.37. House control: `CONTROLH-2026-D` 0.907 / `CONTROLH-2026-R` 0.097. (`KXSENATE` and `KXHOUSE` series exist but have zero markets.)
  - Combo: `KXBALANCEPOWERCOMBO-27FEB` (DD 0.64, DR 0.25, RR 0.094); `KXSAMEPARTYCONGRESS-27FEB01` 0.79
  - Seat counts: `KXRSENATEWON-26NOV03-AL{n}`, `KXDHOUSEWON-26NOV03-AL{n}`, `KXDSENATESEATS-27`, `KXDHOUSESEATS-27`, `RSENATESEATS-27`
  - Senate races: `SENATE{ST}-26-D/-R` (e.g. `SENATETX-26-D` 0.65 Talarico, `SENATEME-26-D` 0.60 Jackson), `KXMISENATE-26-AELS/-MROG` (El-Sayed 0.69), `SENATEOHS-26`, `SENATEPARTY-OH`, `SENATENES`, `SENATEAZ`, `KXSENATELA`, `KXGARSENMATCHUP`, `KXAKSENATE-26NOV03`, `KXAKSENADVANCE`. NC Senate appeared absent.
  - Governors: `GOVPARTY{ST}-26` (GA, PA, MI, WI, AZ, NV, OH, FL, TX, CA, NY, MN, IA, CO, ME; KS is `-27`), by person `KXGOVCA-26`, `KXGOVAK-26`
  - House: `HOUSE{ST}{N}-26` (~80 competitive seats, e.g. `HOUSENC1-26-D`, `HOUSEPA7-26`, `HOUSEAZ1-26`), `KXHOUSERACE-{ST}{NN}-26` for the rest
  - Fun: `KXAPCALLSENATE-26AUG20` and `KXAPCALLHOUSE-26AUG20` (when AP calls the majority; modal outcome after midnight ET), `KXAPCALLCAGOV`, `KXCLOSESTSENATE`, exit-poll markets `KXTRUMPEXITAPPROVE`, `KXDEMMENVOTE`, `KXGOPYOUTHVOTE`
- No embed widget. Kalshi settles 2026 markets on AP data. Hub: https://kalshi.com/category/elections/midterms

### Polymarket [live, no auth for reads]
- Gamma: `https://gamma-api.polymarket.com/events?slug=…`, `/events?tag_slug=midterms&closed=false&limit=200&order=volume&ascending=false`, `/tags/slug/midterms` (tag 102289; `house-races` 100344), `/public-search?q=…`. `cache-control: public, max-age=300`. Each market has `outcomePrices` (JSON-encoded string array) and `clobTokenIds`. OpenAPI https://docs.polymarket.com/api-spec/gamma-openapi.yaml
- CLOB: `https://clob.polymarket.com/midpoint?token_id=T` (verified `{"mid":"0.665"}`), `/price?token_id=T&side=buy`, `/book`, `/prices-history`, batch `POST /prices`. Data API `https://data-api.polymarket.com`.
- Websocket (no auth): `wss://ws-subscriptions-clob.polymarket.com/ws/market`, subscribe `{"assets_ids":["<token>"],"type":"market"}`, send text `PING` every 10 s. https://docs.polymarket.com/market-data/realtime-data.md
- Rate limits: Gamma `/events` 500 req/10 s, `/markets` 300/10 s; CLOB `/midpoint` and `/price` 1,500/10 s; IP-based. https://docs.polymarket.com/quickstart/introduction/rate-limits
- **Slugs/IDs (Oct 25):**
  - `balance-of-power-2026-midterms` (event 32228, $36.9M volume): markets `2026-balance-of-power-d-senate-d-house-949` 0.665, `…-r-senate-d-house-444` 0.255, `…-r-senate-r-house-537` 0.075, `…-d-senate-r-house-692` 0.0075
  - `which-party-will-win-the-senate-in-2026` (event 32224): market 562793 `will-the-democratic-party-control-the-senate-after-the-2026-midterm-elections`, YES token `113287701564209339913693347405685749986285999146352375265161592243948562084773` (0.665)
  - `which-party-will-win-the-house-in-2026` (event 32225): market 562802, YES token `83247781037352156539108067944461291821683755894607244160607042790356561625563` (0.915)
  - Races: `texas-senate-election-winner`, `maine-…`, `michigan-…`, `ohio-…`, `alaska-…`, `georgia-…`, `iowa-…`, `kansas-…`, `nebraska-…`, `new-hampshire-…`, `minnesota-…`, `north-carolina-…` (use the tag query); governors `ohio-governor-winner-2026`, `wisconsin-…`, `nevada-…`, `michigan-…`, `georgia-…`, `california-governor-election-2026`; `republican-senate-seats-after-the-2026-midterm-elections-927`, `republican-house-seats-after-the-2026-midterm-elections`, `how-many-republican-governors-after-the-2026-midterm-elections`
- **Official iframe embed:** generator at https://embed.polymarket.com/ → `<iframe src="https://embed.polymarket.com/market?…">` (400×400 default; chart, volume, dark mode options; single markets only). Web component `@polymarket/embeds` 1.3.0 at `https://unpkg.com/@polymarket/embeds@1.3.0/dist/index.js`. Help: https://help.polymarket.com/en/articles/13364174-how-to-use-embeds

### PredictIt [live]
- `GET https://www.predictit.org/api/marketdata/all/` (498 KB, 223 markets, needs a browser-like User-Agent); per market `/api/marketdata/markets/{id}`. Fields `contracts[].lastTradePrice`, `bestBuyYesCost`, `timeStamp`. ~60 s cadence.
- IDs: 8155 Senate control, 8157 House control, 7589 GOP House seats, 8163 GOP Senate seats; Senate 8156 GA, 8158 MI, 8159 ME, 8160 NC, 8161 NH, 8162 MN, 8172 NE, 8173 TX, 8175 OH, 8228 FL, 8271 AK, 8274 IA, 8375 SC; governors 8211 AZ, 8212 MI, 8213 WI, 8214 KS, 8215 NY, 8297 MN, 8378 IA, 8166 CA; House 8177 ME-02, 8183 NE-02, 8184 NC-01, 8185 NM-02, 8186 NY-04, 8187 NY-17, 8188 WA-03, 8189 AZ-01, 8190 AZ-06, 8191 CO-08, 8192 IA-01, 8193 MI-07, 8194 PA-07, 8195 PA-10, 8196 WI-03
- Operating under CFTC no-action letter 25-20 (July 2025). **[secondhand]**

### Others
- **Manifold [live]:** `https://api.manifold.markets/v0/search-markets?term=2026%20senate%20control&limit=5`, no auth, returns `probability`. Docs https://docs.manifold.markets/api
- **Metaculus [unverified]:** 403 without a token; register for a free API token.
- **Robinhood, Crypto.com, Betfair, Smarkets:** no public API or geo-blocked.
- **electionbettingodds.com:** aggregator, scrape only. https://electionbettingodds.com/Senate-Control-2026.html

---

## 4. The 2026 landscape (as of Oct 20–25)

### Senate
- Current: 53 R, 45 D, 2 I (caucus D). 35 seats up (33 Class 2 + specials in FL (Moody) and OH (Husted)); 22 R-held, 13 D-held. Democrats need **net +4** for 51.
- **Cook toss-ups (Oct 20), 7:** AK (Sullivan-R vs Peltola-D), IA (open: Hinson-R vs Turek-D), KS (Marshall-R vs Adam Hamilton-D), ME (Collins-R vs Dem nominee, listed as Troy Jackson — **verify**), MI (open: Rogers-R vs El-Sayed-D), OH special (Husted-R vs Sherrod Brown-D), TX (open: Paxton-R vs Talarico-D; UH Hobby poll Talarico 48–46).
- Lean D: NH (Pappas vs Sununu), MN (Flanagan vs Tafoya). Likely D: GA (Ossoff vs Mike Collins), NC (Cooper vs Whatley). Lean R: SC (Graham vs Annie Andrews). Likely R: MS, NE (Ricketts vs Osborn), FL special (Moody vs Angie Nixon). Also LA (Letlow-R after Cassidy lost primary), open seats AL, KY, IL, MT, WY, OK (appointed Armstrong not running).
- Rater totals (D+I / R / toss-up): Cook 47/46/7; Inside Elections 48/48/4; Sabato 49/46/5; DDHQ 49/47/4; Economist 49/47/4; Silver Bulletin 53/46/1; Split Ticket 52/47/1; RCP 46/46/8. **Show rater-by-rater, not a single consensus.**
- Control odds: DDHQ 56% D, Split Ticket 65%, Silver Bulletin ~74%, Kalshi 63–66% D, Polymarket 66.5% D, Economist ~49% D (outlier).
- Sources: https://en.wikipedia.org/wiki/2026_United_States_Senate_elections, https://www.270towin.com/2026-senate-election/cook-political-report-2026-senate, https://www.cookpolitical.com/ratings/senate-race-ratings

### House
- Current: 218 R, 214 D, 1 I, 2 vacancies (FL-20, TX-23). Democrats need **net +4** for 218.
- **Cook (Oct 23): 220 D / 198 R / 17 toss-ups:** CA-22 Valadao(R), FL-14 Castor(D), FL-22 (new seat), IA-2 (open R), KY-6 (open R), MI-4 Huizenga(R), MI-7 Barrett(R), MI-10 (open R), MT-1 (open R), NY-17 Lawler(R), NC-1 Don Davis(D), OH-7 Max Miller(R), OH-9 Kaptur(D), PA-8 Bresnahan(R), TX-15 De La Cruz(R), TX-35 (new seat), VA-1 Wittman(R). Cook's likely outcome: D +9 to +19.
- Other raters (D/R/toss): Inside Elections 212/205/18 (adds AZ-6, CO-8, FL-25, NC-11, PA-10, TX-34, VA-2, WA-3, WI-3); Sabato 223/200/12; Economist 230/190/15; Split Ticket 225/197/13; DDHQ 223/203/9; Silver Bulletin 230/196/9.
- Control odds: Kalshi 91% D, Polymarket ~92%, DDHQ 80%, Silver Bulletin ~93%. Generic ballot average ≈ **D+8.7** (DDHQ D+7.9, Silver Bulletin D+9.1, NBC D+9.0, RCP D+8.1).
- Sources: https://pressgallery.house.gov/party-breakdown, https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_election_ratings, https://votes.decisiondeskhq.com/polls/generic-ballot/national

### Governors (36 races)
- Open: AL, AK, CA, CO, FL, GA, IA, KS, ME, MI, MN, NM, OH, OK, SC, TN, WI, WY (+ RI incumbent lost primary).
- Consensus toss-ups: **GA** (Bottoms vs Rick Jackson, all 8 raters), **NV** (7 of 8). WI toss-up or Lean D. **OH Lean D flip** (Acton vs Ramaswamy). AK Lean D flip, IA Lean D flip, KS Lean R flip. Lean D holds AZ, MI, OR. Lean R holds FL, TX.
- Sources: https://en.wikipedia.org/wiki/2026_United_States_gubernatorial_elections, https://centerforpolitics.org/crystalball/2026-rating-changes/, https://www.cookpolitical.com/ratings/governor-race-ratings

### Ballot measures and legislatures
- Notable: AK Measure 2 (repeal top-4/RCV, second attempt); MO abortion-rights repeal; CA billionaire wealth tax plus 14 props; CO Amendment 86 (congressional maps); MD Question 3; voter-ID in CA, CO, NV, AZ, NC, OH; ND 60% threshold; MA 9 measures. https://ballotpedia.org/2026_ballot_measures **[secondhand]**
- Legislatures: 88 chambers in 46 states; Sabato toss-ups AZ Senate, AZ House, WI Senate, WI Assembly, MI House, NH House (R-held); MI Senate, MN Senate (D-held); MN House (tied). https://en.wikipedia.org/wiki/2026_United_States_state_legislative_elections

### Cheat sheets
- Bolts "Cheat Sheet to the 2026 General Elections" (650+ races): https://boltsmag.org/whats-on-the-ballot/guide-to-2026-general-election/
- CBS races to watch (10 Senate + 42 House): https://www.cbsnews.com/news/2026-midterm-election-races/
- Cook/NYT/WaPo/Politico/DDHQ election-night guides not yet published on Oct 25; expect them the weekend before.
- 2022 bellwether counties (Semafor): Perry IN, Kenton KY, Lake IN, Rockingham NH, Loudoun VA, Mahoning OH, Clark/Washoe NV, Clackamas OR, Pierce WA. https://www.semafor.com/article/11/07/2022/how-to-watch-election-night-like-a-pro-an-hour-by-hour-guide

---

## 5. Redistricting and map geometry

### States with NEW congressional maps for Nov 2026 (Census authoritative list, nine states)
Source: https://www.census.gov/programs-surveys/decennial-census/about/rdo/congressional-districts.120th_Congress.html **[docs]**

| State | Status |
|---|---|
| TX | New 2025 legislature map; SCOTUS stayed the injunction Dec 4, 2025. Up to R+5 |
| CA | New (Prop 50, Nov 2025); injunction denied Jan 2026. ~D+5 |
| NC | New (Oct 22, 2025); targets NC-1 |
| OH | New commission map (Oct 31, 2025), ~12R-3D |
| UT | New court-ordered map with a safe-D Salt Lake seat |
| FL | New (signed May 4, 2026; potential 24-4); FL Supreme Court denied injunction |
| LA | New (SB 121, May 29, 2026) after *Callais*; **House races are a jungle primary Nov 3 with a Dec 12 runoff** |
| AL | Legislature's 2023 map restored by SCOTUS (June 2, 2026); 2024 used a court-drawn map, so this counts as new vs 2024 |
| TN | New (May 7, 2026); splits Memphis TN-9 |

**NOT new:** MO (2022 map in force; HB1 blocked by MO Supreme Court Sept 3, 2026 and SCOTUS Sept 23), VA (amendment voided May 2026), IN (Senate rejected map), KS, MD, NY, GA, SC, WI, AR, NE, KY, MS. No state changed its number of districts.

Trackers: https://ballotpedia.org/Redistricting_ahead_of_the_2026_elections, https://redistrictingonline.org/mid-decade-redistricting-tracker/

### Geometry downloads
- **Census TIGER/Line 2026, released Oct 14, 2026, per-state only:** `https://www2.census.gov/geo/tiger/TIGER2026/CD/tl_2026_{STATEFIPS}_cd120.zip` (e.g. `tl_2026_48_cd120.zip` TX, `tl_2026_06_cd120.zip` CA, ~4 MB each). **[live directory listing]**
- **MISSOURI TRAP:** `tl_2026_29_cd120.zip` still encodes the blocked HB1 map. Use the 2025 vintage `https://www2.census.gov/geo/tiger/TIGER2025/CD/tl_2025_29_cd119.zip` for Missouri **[pattern unverified]**, or rebuild from the regenerated block equivalency file: https://www.census.gov/geographies/mapping-files/2027/dec/rdo/120-congressional-district-bef.html
- TIGERweb REST (GeoJSON queries, no unzip): https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Legislative/MapServer/0 — check its Missouri layer before trusting it.
- Redistricting Data Hub (free account): national 120th CD file https://redistrictingdatahub.org/dataset/120th-congressional-districts-and-block-assignment-file-nov-2026-election-active-jan-2027-jan-2029/ and per-state approved plans (FL, LA, AL, TN).
- States and counties: us-atlas TopoJSON `https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json`, `counties-10m.json`. **[memory, stable]**
- FIPS: `https://www2.census.gov/geo/docs/reference/state.txt`, counties `https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt`. CT planning regions replaced counties in Census geography but AP may still report old CT counties.
- **Hex cartogram:** Daily Kos Elections hexmap v3.0 (Sept 2022, SVG, 5 hexes per district, CC BY-SA 4.0) https://www.dailykos.com/stories/2124157. No 2026 update found. Since no state changed seat counts, reuse the 2022 layout and relabel; intra-state hex placement is stale only in the nine redrawn states.
- Legacy sources NOT updated for 2026: github.com/unitedstates/districts, kml.house.gov/current.
- Simplify shapefiles with mapshaper before shipping; the BC GeoJSON needed ring rewinding for d3-geo and the same will apply here.

---

## 6. Timing

### Poll closing times, Nov 3 2026, Eastern (270toWin and Green Papers agree; identical to NYT 2024 `pollClosingTimes`)
| ET | States |
|---|---|
| 6:00 PM | IN (most), KY (east) |
| 7:00 PM | GA, SC, VT, VA, FL (peninsula), IN (Central), KY (west), NH (most towns) |
| 7:30 PM | NC, OH, WV |
| 8:00 PM | AL, CT, DE, DC, FL (panhandle), IL, KS (east), ME, MD, MA, MI (most), MS, MO, NH (rest), NJ, ND (most), OK, PA, RI, SD (east), TN, TX (most) |
| 8:30 PM | AR |
| 9:00 PM | AZ, CO, IA, KS (west), LA, MI (CD-1 Central sliver), MN, NE, NM, NY, ND (west), SD (west), TX (El Paso/Hudspeth), WI, WY |
| 10:00 PM | ID (south), MT, NV, OR (Malheur), UT |
| 11:00 PM | CA, ID (north), OR (rest), WA |
| 12:00 AM | HI, AK (most) |
| 1:00 AM | AK (Aleutians) |
Sources: https://www.270towin.com/poll-closing-times/, https://www.thegreenpapers.com/G26/PollingHours.phtml

### Counting speed (for UI expectations)
- **Fast:** FL (pre-scans ~25 days), GA (~95% visible by ~10 pm; **Dec 1 runoff** under 50%), NC (weekly pre-scan; provisionals later), VA.
- **Medium:** MI (AV counting boards 8 days pre), AZ (scan on receipt, late drop-offs and 5-day signature cure slow it), NV (mail postmarked Nov 3 accepted until 5 pm **Nov 7**).
- **Slow:** PA (no pre-canvass before 7 am election day; HB 37 stalled), WI (Milwaukee central count late), CA (mail accepted through **Nov 10**; county certification Dec 3; close House seats take 1–3 weeks), OR/WA (postmark rules), AK (**RCV tabulation Nov 18**, certification Nov 25; Senate is top-4 RCV regardless of Measure 2), ME (RCV adds about a week), NY (affidavit/late ballots linger).
- **LA House runoff Dec 12.** Six states incl. NC and OH newly stopped counting mail arriving after election day.
- Authoritative pre-processing table: https://electioninnovation.org/research/pre-processing-timelines/

### Race-call norms
- AP calls at poll close only for uncontested or historically lopsided races; otherwise waits until the trailing candidate has no mathematical path. Expect VA/GA/SC safe seats at 7:00–7:30 pm, competitive NC/OH/MI/PA/WI/AZ/NV hours to days, CA House up to a week. Kalshi's market puts the modal AP Senate-majority call after midnight ET.
- **Any in-house heuristic must be labelled "unofficial lean" and never "called."** The BC ballot-box rule does not transfer: US feeds give expected-vote percentages that vary by vendor, and late mail skews blue in AZ/NV/PA/CA.

### Exit polls
- **The Voter Poll by SSRS** replaces both the Edison/NEP exit poll and AP VoteCast for 2026 (partners AP, ABC, CBS, CNN, Fox, MS NOW, NBC). Release: broad characteristics at **5:00 pm ET**, state candidate breakdowns at each state's poll close, national survey at **8:00 pm ET**. No public feed; link to network pages. https://ssrs.com/ssrs-solutions/voter-poll/ **[secondhand]**

---

## 7. Polls, forecasts, ratings

| Source | Access | Verdict |
|---|---|---|
| Cook Political Report | cookpolitical.com 403s scripted fetches (curl got the governor table once) | Mirror via 270toWin |
| 270toWin mirrors | Clean HTML tables for every rater + consensus: https://www.270towin.com/2026-senate-election-predictions/, https://www.270towin.com/2026-house-election-predictions/, https://www.270towin.com/2026-house-election/cook-political-report-2026-house-ratings | **Best scrape target** |
| Wikipedia rating tables | Dated wikitables, all raters | **Best free structured source** |
| Sabato's Crystal Ball | HTML; 403 to some fetchers | Scrape or manual |
| Inside Elections | https://insideelections.com/ratings/senate/ (curl 200), `/ratings/house/`, `/ratings/governor/` | Scrape |
| Split Ticket (now at The Argument) | HTML only https://www.theargumentmag.com/p/split-ticket-2026-midterms-model | Manual |
| Silver Bulletin | Generic-ballot and approval poll databases downloadable (XLSX); model outputs paywalled | Partial |
| DDHQ | Public forecast and polling-average pages | Scrape |
| VoteHub | Free beta REST API https://votehub.com/polls/api/ (`/polls`; race-level coverage unconfirmed) | Likely scriptable |
| RealClearPolling | HTML only | Scrape |
| FiftyPlusOne (G. Elliott Morris) | https://www.fiftyplusone.news; downloads not located | Unconfirmed |
| NYT polls database (538 successor, CC BY 4.0 claimed) | Download URL not located | Unconfirmed |
| 538 archive | https://github.com/fivethirtyeight/data | Static, historical |
| Harvard ElectIt (Gary King) | https://gking.harvard.edu/electit | Check for CSV |

**Baselines**
- **The Downballot: 2024 presidential results by congressional district, computed on the 2026 lines.** Google Sheet https://docs.google.com/spreadsheets/d/1eZfaFI-c-PFOoKx1-zZA2MP0_dxRq_LVK0re3BOQqy0/ (CSV via `/export?format=csv&gid=620838163`). No license stated. **The single most useful baseline file** for a "swing vs 2024" column. **[live]**
- MIT Election Data + Science Lab county and House returns via Dataverse (API key for scripted pulls): https://electionlab.mit.edu/data. Watch the `mode` column pitfall (rows split by vote mode in 2020+).
- OpenElections historical: https://github.com/openelections

**Open-source live models:** WaPo `elex-live-model` https://github.com/washingtonpost/elex-live-model (quantile regression; needs own county baselines), WaPo 2020 model https://github.com/washingtonpost/2020-election-night-model. Out of scope for Nov 3 but the right reference if a "lean" model is ever built.

---

## 8. Candidates, campaign finance, early vote

**OpenFEC** (free key at api.data.gov; ~1,000 req/hr per key) **[docs]**
- Candidate roster per race (the best free list): `GET https://api.open.fec.gov/v1/candidates/search/?api_key=KEY&cycle=2026&office=H&state=CA&district=22&candidate_status=C`
- Totals per race: `GET /v1/candidates/totals/?cycle=2026&office=S&state=TX&election_full=true&is_active_candidate=true` (add `district=` for House)
- Race summary: `GET /v1/elections/?cycle=2026&office=house&state=CA&district=22&election_full=true`
- Per candidate: `GET /v1/candidate/{id}/totals/?cycle=2026&election_full=true`
- Totals lag (pre-general reports Oct 22). Docs https://api.open.fec.gov/developers/

**Candidate lists elsewhere:** Google Civic `voterInfoQuery` nominally still supported, operational status unverified; Ballotpedia API and bulk data paid; Democracy Works VIP partner-only; OpenStates covers legislators not candidates. Practical path: OpenFEC + Wikipedia race pages + a hand-curated JSON for the ~60 competitive races.

**Early vote:** UF Election Lab (Michael McDonald) https://election.lab.ufl.edu/early-vote/2026-early-voting/ is live and current but has no export and is CC BY-NC-ND. TargetEarly is clients-only. State raw feeds worth scripting **[memory]**: NC SBE absentee CSVs, GA SOS absentee file, TX SOS daily early-vote reports, FL DOE VBM reports, PA mail-ballot dataset (data.pa.gov), NV SOS, MI SOS, AZ county recorders.

---

## 9. Live video

### Technical findings **[live tests Oct 25]**
1. **YouTube Data API quota changed.** `search.list` is capped at **100 calls per day** regardless of unit cost (https://developers.google.com/youtube/v3/determine_quota_cost). It is unusable for polling dozens of channels.
2. **Zero-quota live detection:** fetch `https://www.youtube.com/channel/UC…/live` (or `/@handle/live`) with a desktop UA and `Accept-Language: en-US`; parse `<link rel="canonical" href="https://www.youtube.com/watch?v=…">`. If nothing is live or scheduled the canonical is the channel URL. **Pitfall:** it also resolves to *upcoming* streams (C-SPAN pointed at a debate four days out; WaPo at a stale 2020 event), so also parse `"isLiveNow":true` / `"isUpcoming":true` from the page JSON.
3. **Confirm cheaply:** `videos.list?part=liveStreamingDetails,snippet&id=…` costs 1 unit for up to 50 IDs; `snippet.liveBroadcastContent` is `live|upcoming|none`; `liveStreamingDetails.concurrentViewers` available. Uploads playlist `playlistItems.list?playlistId=UU<channelId minus UC>` is 1 unit and lists recent live entries.
4. **`youtube.com/embed/live_stream?channel=ID`** still works but **only when the channel has exactly one currently-live public stream**, and the embed now **requires an HTTP Referer** (otherwise "Video player configuration error / Error 153", https://support.google.com/youtube/answer/171780). On election night 2024 most big outlets ran two or more simultaneous streams (NBC, PBS+ASL, Sky, C-SPAN, Reuters, CBC), so the channel trick fails for exactly the channels that matter. **Resolve a concrete video ID server-side and embed `youtube.com/embed/<videoId>?autoplay=1&mute=1`.**
5. RSS `youtube.com/feeds/videos.xml?channel_id=` does not reliably include the current live stream. oEmbed `youtube.com/oembed?url=…&format=json` is free and labels a known video ID.
6. **Twitch:** player `https://player.twitch.tv/?channel=hasanabi&parent=yourdomain.com&muted=true`, chat `https://www.twitch.tv/embed/<channel>/chat?parent=<domain>` (+`&darkpopout`), one `parent` per host (production, preview, localhost). Live check via Helix `GET https://api.twitch.tv/helix/streams?user_login=…` with an app token (client credentials). https://dev.twitch.tv/docs/embed/video-and-clips/
7. **Kick:** `https://player.kick.com/<slug>` embeds with no auth; official status API `GET https://api.kick.com/public/v1/channels?slug=…` needs an OAuth app token; unofficial `kick.com/api/v2/channels/<slug>` returned JSON to curl but is intermittently challenged. https://docs.kick.com/apis/channels
8. **Rumble:** iframe `https://rumble.com/embed/<embedId>/`, embedId from the video page JSON-LD `embedUrl`; no channel-live URL or API; scrape `https://rumble.com/c/<Channel>` for `videostream__status--live`. Fragile.
9. **YouTube live chat embed:** `https://www.youtube.com/live_chat?v=VIDEO_ID&embed_domain=yourdomain.com`; exact domain match; not on mobile web.

### Outlets (YouTube channel IDs read from each channel page's `externalId` on Oct 25)

| Outlet | Handle | Channel ID | 2024 night free on YT | Notes / verdict |
|---|---|---|---|---|
| C-SPAN | @cspan | UCb--64Gl51jIEVE-GLDAVTg | Yes (DhSz4PusLhg, plus Part 1/2) | Multi-stream; streamed 2026 primaries. Resolve video ID |
| NBC News NOW | @NBCNews | UCeY0bbntWzzVIaj2z3QigXg | Yes (eFCiva4m3Zk + second) | 24/7 feed live, embed OK; expect 2+ streams Nov 3 |
| ABC News Live | @ABCNews | UCBi2mrWuNuyYy4gbM6fU18Q | Yes (via 24/7) | 24/7 live, embed OK |
| CBS News 24/7 | @CBSNews | UC8p1vwvWtl6T73JiExfWs1g | Yes (LS8amqeDbS8) | YT live is event-based; 24/7 feed is on cbsnews.com |
| PBS NewsHour | @PBSNewsHour | UC6ZFN9Tx6xh-skXCuRHCDpQ | Yes (woOXa1KHTZE + ASL) | Two streams on the night |
| The Hill / DDHQ | @thehill | UCPWXiRWZ29zrxPFIQT7eHSA | Yes (EQkC2rRlH_4) | Has an upcoming "Decision Desk '26" preview; strong Nov 3 signal |
| Decision Desk HQ | @DecisionDeskHQOfficial | UC0zIez_iBFIOvJumpyKm7yA | Yes (3eIxarWjuXE) | Streamed 2026 primaries; near-certain Nov 3 stream |
| Bloomberg TV | @BloombergTelevision | UCdK2BueKxC9VxXh7e1Ne4oQ | Yes (k3cNq_DV91c) | Event-only; @business 24/7 has embedding disabled |
| Reuters | @Reuters | UChqUTb7kYRX8-EiaN3XFrSQ | Yes (two streams) | Fragile |
| Washington Post | @WashingtonPost | UCHd62-u_v4DvJ8TCFtpi4GA | Yes (si7El1YDI5o) | `/live` points at a stale 2020 event |
| USA Today | @USATODAY | UCP6HGa63sBC7-KHtkme-p-g | Yes (f4TCKV0C5YM) | Fragile |
| CNN | @CNN | UCupvZG-5ko_eiXAupbDfxWw | No (clips only) | 24/7 "CNN Headlines" loop (GotlA1KKWoo) is embeddable; real coverage is paid |
| Fox News | @FoxNews | UCXIJgqnII2ZOINSWNOGFThA | No | Not free on YT |
| MS NOW (ex-MSNBC, rebranded Nov 15 2025) | @MSNOW | UCaXkIU1QidjPwiAYu6GcHjg | Kornacki Cam only (LIV9HM5Yj80) | Main feed paid |
| Al Jazeera English | @aljazeeraenglish | UCNye-wNBqNL5ZzHSJj3l8Bg | 24/7 | Embed OK |
| Sky News | @SkyNews | UCoMdktPbSTixAyNGwb-UYkQ | Yes (6AyQ9-xwIUM + second) | 24/7 live but multi-stream; use video ID |
| DW News | @DWNews | UCknLrEdhRCp1aegoMqRaCZg | Yes (Otv4TX8YW5U) | 24/7, embed OK |
| France 24 English | @France24_en | UCQfwfsi5VrQ8yKZ-UWmAEFg | Clips | 24/7, embed OK |
| CBC News | @CBCNews | UCuFFtHWoLl5fauMMD5Ww2jA | Yes (d8fuJLr9FvU + second) | Daily stream; embed OK |
| Global News | @GlobalNews | UChLtXXpo4Ge1ReTEboVvTDg | Yes (zHkmDhdfikI) | Embed OK |
| BBC News | @BBCNews | UC16niRr50-MSBwiO3YDb3RA | No | Not feasible |
| Newsmax | @NewsmaxTV | UCx6h-dWzJ5NpAlja1YsApdg | Yes (haqHHk5aYLA) | NEWSMAX2 24/7 but multi-stream |
| Real America's Voice | @RealAmericasVoice | UCMGZ8pfQHgZ6Yj0-92PMENg | Yes (F3DTAqpEagg) | Multiple 24/7 feeds; channel trick fails |
| Breaking Points | @breakingpoints | UCDRIjKy6eZOvKtOELtTdeUA | Yes (yEiLtc_XwK0) | Free, easy |
| Daily Wire | @DailyWire | UCaeO5vkdj5xOQHp4UmIN6dw | Yes (VEP1bDYBra4) | Also @BenShapiro UCnQC_G5Xsjhp9fEJKuIcrSw |
| MeidasTouch | @MeidasTouch | UC9r9HYFxEQOBXSopFS61ZWg | 2025 night yes (AZmBfHuvQ1g) | Free, easy |
| David Pakman | @thedavidpakmanshow | UCvixJtaXuNdMPUGdOPcY8Ag | Yes (jl7kO7WC_SM) | Free, easy |
| Brian Tyler Cohen | @briantylercohen | UCQANb2YPwAtK-IQJrLaaUFw | Yes (g34CFjEFZts) | Free, easy |
| Timcast IRL | @TimcastIRL | UCLwNTXWEjVd2qIHLcXxQWxA | Yes (k2Sg-aS4U2c) | Free, easy |
| Majority Report | @TheMajorityReport | UC-3jIAlnQmbbVMV6gR7K8aQ | Yes (8MwqbNut8Lo) | Free, easy |
| Zeteo | @zeteo | UCVG72F2Q5yCmLQfctNK6M2A | Yes (11M4-HvIWUE) | Streamed Aug 2026 MI primary |
| TYT | @TheYoungTurks | UC1yBKRuGpC1tSM73A0ZjYjQ | Unclear | Fragile |
| Steven Crowder | @StevenCrowder | UCIveFvW-ARp_B_RckhweNJw | Archived on YT (AU9Lh4BErPw) | Rumble-first |
| Hasan Piker | @hasanabi | UCtoaZpBnrd0lhycxYJ4MNOQ | No (Twitch) | Use Twitch embed `hasanabi`; also on Kick |
| Destiny | @destiny | UC554eY5jNUfDq3yDOJYirOQ | Upload only | Kick/own site; fragile |
| Charlie Kirk Show (TPUSA) | @RealCharlieKirk | UCfaIu2jO-fppCQV_lchCRIQ | Not found | Unconfirmed |
| Bannon's War Room | — | — | Rumble only | https://rumble.com/c/BannonsWarRoom |
| Lincoln Project | @TheLincolnProject | UCpYCxV51bykhMY-wSUozQRg | Short stream | Fragile |
| Local: WPLG Miami | @WPLGLocal10 | UCgVZ0mrM3liHNhRYC5Mchgg | 24/7 | Embed OK |
| Local: FOX 5 Atlanta | @FOX5Atlanta | UCjHWv2DU5-HLpogAAr386DQ | 24/7 | Embed OK |
| Local: ABC7 Chicago | @ABC7Chicago | UC_vFLohxs5PkAxlk7Y6jEtw | Yes (0QLZB6djGAA) | Carried ABC network feed |
| Local: WCCO | @WCCO | UCry2gCVdntv6r661sKUiKXw | Yes (3DkORlydHn0) | Fragile |
| Local: 11Alive Atlanta | @11Alive | UCzF4Ryn8TKn64md77gS5Q5Q | 2026 primary yes | Fragile |
| Local: News4JAX | @News4JAX | UC_YFbvKedjnVjqrZqBR4L8Q | Yes (OBYWOub4ILk) | Fragile |

No outlet had a 2026 election-night stream scheduled on YouTube as of Oct 25. Re-run the channel check (`https://www.youtube.com/@handle/search?query=election%20night`) on Nov 1–2.

---

## 10. Social and ambient content

- **X / Twitter.** Dead for free use as of Oct 25: `syndication.twitter.com` timeline 429, nitter.net 410, xcancel 451, other mirrors down, `widgets.js` embed usually blocked. The official API is pay-per-use (reads roughly $0.005 per post per the BC-era notes); the existing `since_id` logic keeps quiet polls free. Current pricing research was cut off. Keep X as an optional, token-gated source only.
- **Bluesky [memory, verify before building].** Public AT Protocol endpoints at `https://public.api.bsky.app/xrpc/…`: `app.bsky.feed.getAuthorFeed?actor=handle`, `app.bsky.feed.getListFeed?list=at://…`, `app.bsky.feed.searchPosts?q=…`, `app.bsky.feed.getFeed?feed=at://…` for custom feed generators; unauthenticated for public data; Jetstream websocket for firehose filtering. The pundit tile should be built on this. Handles for election analysts were not collected (open gap).
- **Truth Social.** No official API. Options to research: mirror sites and RSS bridges for the presidential account. Open gap; needed for the dedicated Trump feed tile.
- **Reddit.** `.json` suffix on subreddit and thread URLs; current server-side rate limits and auth requirements unverified. Open gap.
- **Google Trends.** Trending RSS `https://trends.google.com/trending/rss?geo=US` **[live]** (20 KB, `ht:approx_traffic`, `ht:news_item_*`). Explore-widget embed via `https://ssl.gstatic.com/trends_nrtr/4622_RC01/embed_loader.js` works client-side only (server-side 429). Election hub https://trends.withgoogle.com/trends/us-midterm-elections-2026/. Official API is alpha, 48h lag: not feasible. `pytrends` is archived.
- **Twitch chat / YouTube live chat embeds:** see section 9.
- **Wikipedia MediaWiki API** on the 2026 election pages as a "what just got called" signal: not tested this session. **[idea]**
- **Election-day weather** and poll-close countdowns appear on several hobby sites and are cheap ambient tiles.

---

## 11. Open-source inspiration

- https://github.com/toogreen/midterms2026 — 2026 PWA polling NYT result JSON; clean data layer
- https://github.com/earlsimms/mo-election-night-2026 — GitHub Actions fetch job, state-feed adapters, 50-state registry
- https://github.com/alex/nyt-2024-election-scraper — minimal git-scraper pattern (cron + curl + jq)
- https://github.com/newsdev/elex — AP loader, archived Nov 2023; borrow its race/reporting-unit/candidate model
- https://github.com/newsdev/apfake and https://github.com/newsdev/replay-ap — fake and replayed AP JSON for testing
- https://github.com/washingtonpost/elex-live-model — outstanding-vote model
- https://github.com/openelections/clarify — Clarity parser
- https://github.com/MinnPost/election-night-api — state-feed scraper framework
- https://github.com/nwfella/us-election-tracker — single-file county map UI to borrow from
- https://github.com/keithschipper/election-night-2026 — bellwether-county model
- https://github.com/neelismail01/kalshi-election-dashboard — small Kalshi dashboard

---

## 12. Open gaps (not researched or cut off)

1. News RSS inventory: AP, Reuters alternatives, NYT/WaPo/Politico/Hill/Axios/NPR/Guardian politics feeds, swing-state papers, Google News per-state query strings. (The existing Google News + RSS merger will work; this is a list-building task.)
2. Current X API read pricing and whether buying credits is worth it for one or two accounts.
3. Truth Social mirror or RSS bridge for the Trump feed tile.
4. Bluesky handles for the pundit list (Nate Cohn, Dave Wasserman, Nate Silver, Jon Ralston, Jessica Taylor, Kyle Kondik, Lakshya Jain, G. Elliott Morris, Michael McDonald, Tom Bonier, Taniel, Dave Weigel, and others).
5. Reddit JSON access rules in 2026.
6. Exact feed URLs for FL, AZ, MT, NJ, NY, MI, AK, MN; whether OH/TX/AZ/FL/NV/MT/KS are reachable from the Vercel region.
7. Maine Democratic Senate nominee name; whether MO Prop A is on the Nov 3 ballot; identity of the House Independent; NYT polls database URL; VoteHub race-level coverage; RDH login requirement.
