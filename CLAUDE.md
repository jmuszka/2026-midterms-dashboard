@AGENTS.md

Claude Code notes:
- The project is mid-migration from the BC election dashboard (tag `bc-baseline`) to the US midterms dashboard. AGENTS.md describes the target; the "Migration status" table says what exists today.
- Before editing `public/*.js`, `public/index.html` or `public/style.css`, re-read the file: a second Claude session has edited this repo concurrently before. Commit small and often.
- Data-source URLs, tickers, channel ids and legal verdicts live in `docs/RESEARCH.md`. Do not guess a feed URL that is listed there, and do not add NYT results JSON as a source.
- The build order against the Nov 3 deadline is `docs/PLAN.md` §4. Prefer finishing the current day's deliverable over starting the next.
