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
| `src/app/dashboard/` | Pages: `page.tsx`, `holdings/`, `trades/`, `watchlist/`, `backtest/`, `mega-indicator/`, `settings/` |
| `src/app/api/` | Route handlers: `trades`, `portfolio`, `watchlist`, `data`, `import`(+`/prices`), `backup`, `live-quote`, `mega-history`, `mega-indicator`, `verify-data`, `layouts` |
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

## Run it

```bash
npm install
npm run dev            # web dev server
npm test               # vitest (180 tests)
npm run build          # next build
npm run dev:electron   # Next + Electron together
npm run build:electron # packaged desktop app
```

## Error logging

`src/lib/errorLogger.ts` installs global handlers (`window.onerror`, unhandled
rejections, `console.error/warn`), de-duplicates and caps entries, and persists
them to `localStorage['stockfolio-error-log']` — read it with
`JSON.parse(localStorage.getItem('stockfolio-error-log'))`. Server/render crashes
hit `src/app/global-error.tsx`, which logs to the same store and shows a retry UI.
`<ErrorLoggerInit />` is mounted once in `src/app/layout.tsx`.

## Gotchas

- **Native module.** `better-sqlite3` is a compiled dependency; if `npm install`
  leaves `node_modules` incomplete (missing `next`, empty `.bin/`), re-run
  `npm install` — a partial install breaks both `npm test` and `npm run build`.
- `/api/data` and `/api/verify-data` are the integrity endpoints — keep the UI in
  step with them when changing the DB shape.
- Keep market data honest: if a quote source fails, surface it rather than
  substituting a stale/estimated price silently.
