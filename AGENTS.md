<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Stockfolio (`ACCUBOOK`) — project guide

> **AI/human orientation.** What this is and **which file to edit**. Feature docs
> are in [`README.md`](./README.md).

## What this is

A **local-first portfolio manager**: record trades and holdings, keep a watchlist,
run backtests and technical analysis, and score ~150 "mega" indicators. Prices are
imported/refreshed from public quote sources; everything else is stored locally in
SQLite. Ships as a web app and an Electron desktop app.

**Stack:** Next.js (App Router) · React · TypeScript · Tailwind 4 · better-sqlite3 ·
Recharts · `xlsx` / `pdf-parse` · Electron.

## Layout

| Path | What it is |
|---|---|
| `src/app/layout.tsx` | Root layout (theme + undo/redo providers + `ErrorLoggerInit`) |
| `src/app/global-error.tsx` | Root error boundary → writes to the shared error log |
| `src/app/dashboard/` | Pages: `page.tsx`, `holdings/`, `trades/`, `watchlist/`, `research/`, `backtest/`, `mega-indicator/`, `settings/` |
| `src/app/strategies/` | Strategy catalogue: `page.tsx` (server shell) + `explorer.tsx` (client list) and `top/page.tsx` (top-5 board) |
| `src/app/api/` | Route handlers: `trades`, `portfolio`, `watchlist`, `research`, `data`, `import`(+`/prices`), `backup`, `live-quote`, `mega-history`, `mega-indicator`, `verify-data`, `layouts` |
| `src/lib/` | Domain logic — see table below |
| `src/components/` | Shared UI: `SortableTable`, `ImportDialog`, `PanelBoard`, `ThemeProvider`, `ErrorLoggerInit` |
| `tests/` | Vitest suite (`npm test`) |
| `electron/`, `scripts/` | Electron shell, packaging, `update-app.js`, `depsymlinks.cjs` |

### `src/lib/` map

| File | Responsibility |
|---|---|
| `db.ts` | **SQLite access** — the storage layer everything else uses |
| `portfolio.ts` | Holdings / trades aggregation |
| `market-data.ts`, `quote-sources.ts`, `live-quotes.ts` | Price fetching & caching |
| `price-import.ts` | Importing prices |
| `ta.ts`, `strategies.ts`, `backtest-engine.ts` | Technical analysis + backtesting |
| `custom-indicators.ts`, `indicator-suggestions.ts` | Indicator definitions |
| `mega-indicator.ts`, `mega-score.ts`, `mega-overrides.ts`, `mega-prefs.ts`, `mega-history.ts` | The "mega indicator" scoring system |
| `backup.ts`, `export.ts` | Backup / export |
| `undo-redo.tsx` | Undo/redo provider |
| `errorLogger.ts` | **Client error logging** (localStorage `stockfolio-error-log`) |
| `research.ts` | **SEC EDGAR company research** — ticker→CIK, annual XBRL statements (10-K/20-F/40-F), IFRS fallback, currency detection + FX, ratios, valuation vs live quote, filings. All pure helpers are testable and exported. |

## Where to edit

| I want to change… | Edit |
|---|---|
| A dashboard screen | `src/app/dashboard/<section>/page.tsx` |
| An HTTP endpoint | `src/app/api/<name>/route.ts` |
| Storage schema / queries | `src/lib/db.ts` |
| Portfolio math | `src/lib/portfolio.ts` |
| Indicator / scoring logic | `src/lib/mega-*.ts`, `src/lib/custom-indicators.ts` |
| Price sources | `src/lib/quote-sources.ts`, `src/lib/live-quotes.ts` |
| Backtesting | `src/lib/backtest-engine.ts`, `src/app/dashboard/backtest/` |
| Shared UI | `src/components/` |
| Error logging | `src/lib/errorLogger.ts`, `src/app/global-error.tsx` |
| Company research (profile, statements, ratios, valuation, filings) | `src/lib/research.ts`, `src/app/api/research/route.ts`, `src/app/dashboard/research/page.tsx` |
| The strategy catalogue (list, filters, top-5 board) | `src/lib/strategies-db.ts` (**generated** — never hand-edit), `src/lib/strategies-catalog.ts` (ranking + horizon), `src/lib/strategies-researched.ts` (sourced additions), `src/app/strategies/`, `scripts/build-strategies.mjs` |

## Run it

```bash
npm install
npm run dev            # web dev server
npm test               # vitest (340+ tests)
npm run build          # next build
npm run dev:electron   # Next + Electron together
npm run build:electron # packaged desktop app
npm run release:patch  # bump + commit + tag + push → Release workflow publishes
```

## Cutting a numbered release

`npm run release:patch` (or `release:minor` / `release:major`) runs
`scripts/cut-release.mjs`: it refuses a dirty tree, a branch other than `master`,
commits missing from origin, or an existing tag; runs lint + typecheck + tests;
bumps `package.json` and `package-lock.json`; commits `Release X`; tags `vX`;
pushes branch and tag; then watches the CI and Release runs. `-- --dry-run`
prints the computed number and changes nothing. Never hand-edit the version for a
release — the tag is what triggers `.github/workflows/release.yml`.

A GitHub-hosted "cut release" button would need a new workflow file, and pushing
one requires the `workflow` token scope; the current `gh` login has only
`gist`, `read:org` and `repo`. Grant it once with
`gh auth refresh -h github.com -s workflow` if the numbering step should move
into Actions.

## Error logging

`src/lib/errorLogger.ts` installs global handlers (`window.onerror`, unhandled
rejections, `console.error/warn`), de-duplicates and caps entries, and persists
them to `localStorage['stockfolio-error-log']` — read it with
`JSON.parse(localStorage.getItem('stockfolio-error-log'))`. Server/render crashes
hit `src/app/global-error.tsx`, which logs to the same store and shows a retry UI.
`<ErrorLoggerInit />` is mounted once in `src/app/layout.tsx`.

## Research data rules (do not break)

- **Every statement figure is a filed fact.** `extractAnnualSeries` reads SEC XBRL
  company facts, dedupes a period by its END date (a 10-K repeats the prior year as a
  comparative under the NEW `fy`), keeps the newest filed value, and labels the period
  by its EARLIEST filing. Missing metrics are `null` → “—”, never 0 or an estimate.
- **Taxonomies must not mix.** `extractAnnualSeries(..., taxonomy)` is passed
  `us-gaap` or `ifrs-full`; common tag names (`Assets`, `ProfitLoss`) exist in both.
- **Currency matters.** `detectCurrency` reads the reporting unit (IFRS filers are
  often DKK/EUR/JPY). Multiples divide by market cap converted into the statement
  currency using a real Yahoo FX rate (`fetchFxRate`); without it they stay “—”.
- **No analyst estimates / TTM / ratings.** They are not in the SEC dataset; the UI
  says so instead of inventing them.
- `SEC_USER_AGENT` should carry a real contact address for SEC fair access (defaults
  to a placeholder). Responses are cached in-process (tickers 1h, company data 15m,
  FX 1h); `clearResearchCache()` exists for tests.
- Tests: `tests/research.test.ts` covers period extraction, restatements, IFRS/currency,
  ratio math, valuation with/without FX and filing links. It never hits the network.

## Strategy catalogue (workbook → screens)

`Master_Investment_Strategies.xlsx` (236 rows, 57 columns) is outside this repo
(`../Master_Investment_Strategies.xlsx`). `node scripts/build-strategies.mjs`
reads it and writes `src/lib/strategies-db.ts`; `--check` fails when the checked-in
file is stale. The build is not cosmetic:

- it repairs the workbook's cp1252-mangled text (`â†”` → `↔`, `ðŸŸ…` → emoji);
- it drops the 6 emoji section headings that are stored as if they were
  strategies, and the one row the workbook calls a duplicate;
- it merges 43 spelling variants (`Sentiment Arb` = `Sentiment Arbitrage`), leaving
  186 strategies;
- it re-files the **156-row “General Arbitrage” catch-all** into the category each
  row actually trades in, because that bucket is 66% of the sheet and a top-5
  board on it would only ever show arbitrage.

`src/lib/strategies-catalog.ts` owns the ranking: the workbook's own `Overall Rank`
(17 rows) first, then **RAR** = annualised midpoint of the sheet's own return
range ÷ the sheet's own risk level, then evidence, then name. Monthly figures are
annualised ×12 *for ordering only* and labelled so on the card. Blank sheet fields
stay `null` → “—”. `tests/strategies-catalog.test.ts` pins all of it, including
that no mangled text or duplicate name survives.

### Three layers of strategy research

| Layer | File | Rule |
|---|---|---|
| The workbook's own cells | `src/lib/strategies-db.ts` (generated) | Facts repeated on 15+ rows are marked `template: true`. They are kept, but the drawer hides them behind a disclosure because the sheet applied one template to the whole long tail — “Sample size: 1000+ protocols” sits on a **betting** strategy. |
| Mechanism research | `src/lib/strategy-research.ts` | 28 families covering all 186 rows. Every figure is inside a sentence starting “Typical:” — industry range, not this row's data. Enforced by `tests/strategy-research.test.ts`. |
| Sourced deep dives | `src/lib/strategy-deep-dives.ts` | Per strategy, with a source **that was actually opened**. If a page could not be read, the dive says so in `caveat` rather than quoting a snippet as fact. |`src/lib/strategy-adjacent.ts` lists5 more methods per category that the workbook
does not carry (ground leases, land banking, rolling funds, options market making …).
They are named for completeness and deliberately carry **no** return, risk or score,
because nobody has assessed them.

### Researched additions (outside the workbook)

`src/lib/strategies-researched.ts` is **hand-written**:51 strategies ordinary
investors actually use (index cores, factor tilts, cash/bond ladders, options
income, real-estate methods, allocation frameworks, a few speculative crypto
methods), curated in Oct2026 from pages that were actually opened during research
(every figure has a `sources[]` entry; reddit threads informed the scope but
could not be fetched, so they are not cited). Each row carries risk (0–1, banded
exactly like the workbook's), a **viability** verdict + note, a **horizon**
(short < ~1yr · medium ~1–5yr · long5+yr) and, where one honestly exists, a return
figure — otherwise the row explains why it has none. The catalog merges them into
`STRATEGIES` (`WORKBOOK_STRATEGIES` stays exported for the sheet-arithmetic test)
and `horizonOf` parses the workbook's own “Minimum horizon” field for sheet rows so
short/long-term sorting and filtering work across the whole catalogue.
`tests/strategies-researched.test.ts` pins all of it, including the “Typical:/
Historical:/As of” figure-labelling rule and the no-guarantee-language rule. When
adding a row: a citation needs a page you opened, and an unmeasured method keeps a
blank figure rather than an estimate.

When adding a row or a dive: a figure needs the “Typical:” prefix unless it is
sourced, a citation needs a page you opened, and an unassessed method stays
unranked. Do not fill a blank by inference — the drawer already explains a blank
more honestly than a guess would.

## Gotchas

- **Native module.** `better-sqlite3` is a compiled dependency; if `npm install`
  leaves `node_modules` incomplete (missing `next`, empty `.bin/`), re-run
  `npm install` — a partial install breaks both `npm test` and `npm run build`.
- `/api/data` and `/api/verify-data` are the integrity endpoints — keep the UI in
  step with them when changing the DB shape.
- Keep market data honest: if a quote source fails, surface it rather than
  substituting a stale/estimated price silently.
