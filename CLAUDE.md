@AGENTS.md

Claude Code notes:
- The BC election dashboard (tag `bc-baseline`) has been migrated to the US midterms dashboard. AGENTS.md describes what exists; docs/PLAN.md has a status table.
- Run `npm test` after touching lib/ or config/, and the browser suites (`npm run test:browser` with the server running) after touching public/. Use `?sim=1` to see populated views before Nov 3.
- Before editing `public/*.js`, `public/index.html` or `public/style.css`, re-read the file: a second Claude session has edited this repo concurrently before. Commit small and often.
- Data-source URLs, tickers, channel ids and legal verdicts live in `docs/RESEARCH.md`. Do not guess a feed URL that is listed there, and do not add NYT results JSON as a source.
- The build order against the Nov 3 deadline is `docs/PLAN.md` §4. Prefer finishing the current day's deliverable over starting the next.
