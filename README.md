# Stockfolio

A local-first **portfolio management desktop app** (Electron + Next.js + SQLite). Track your
stock holdings, record trades, watch new ideas with live quotes, and test strategies against
real historical market data — no accounts, no cloud, no subscriptions. Your data never
leaves your machine.

## Features

### Portfolio Tracking
- **Holdings** — live positions with FIFO cost-basis lots, average cost, market value,
  unrealized/realized P&L, dividends received, and portfolio weight per symbol.
- **Trade Log** — record buys, sells, dividends, deposits, withdrawals, and fees.
  Full edit/delete with undo/redo (Ctrl+Z / Ctrl+Shift+Z).
- **Cash Ledger** — deposits and withdrawals tracked automatically; cash balance feeds
  total equity alongside market value.
- **Live Quotes** — real-time prices (Yahoo Finance with Stooq fallback), day change,
  and total return computed on every load.
- **Allocation** — visual portfolio allocation donut including cash.

### Analysis
- **Mega Indicator** — one composite 0–100 technical health score per ticker, blending
  trend (50/200 SMA), RSI, MACD, Bollinger position, ATR%, momentum, volume ratio,
  52-week-high distance, Kaufman Efficiency Ratio, and Nadaraya-Watson kernel
  regression (slope + residual), plus the full SMA/EMA 10–200 family. Every indicator
  has an adjustable weight and presets (Everything / Trend / Momentum / Mean Reversion /
  Smooth Trends). Score-over-time history is computed with trailing windows only
  (no look-ahead) and cached in SQLite.
- **Watchlist** — track ideas with live quotes and target-price alerts that show how
  far price is from your entry point.
- **Indicators engine** — SMA, EMA, RSI, MACD, Bollinger Bands, ATR and more
  (`src/lib/ta.ts`).

### Backtesting
- **Famous strategies** — SMA/EMA crossovers, RSI mean reversion, MACD, Bollinger,
  breakout (Turtle), time-series momentum, buy & hold, and the **Mega Score Regime**
  strategy that trades the app's own composite indicator (`src/lib/strategies.ts`).
- **Mega Score weights** — the Mega Score strategy (and its price-chart overlay) can
  use the weights you tuned on the Mega Indicator page; Compare/Optimize/Walk-Forward
  apply them too.
- **Real market data** — daily OHLCV from Yahoo Finance (split/dividend-adjusted,
  multi-host failover) with Nasdaq and Stooq fallbacks, cached in SQLite so repeat
  backtests are instant and work offline.
- **Realistic simulation** — signals execute at next bar's open (no look-ahead bias),
  with commissions, slippage, position sizing, and optional **stop-loss / take-profit**
  exits (gap-aware fills, exit reasons per trade).
- **Benchmark picker** — compare against any ticker's buy & hold (e.g. NVDA vs SPY),
  not just the same symbol.
- **Full metrics** — CAGR, Sharpe, Sortino, Calmar, max drawdown, win rate, profit
  factor, time in market, expectancy, payoff ratio, max loss/win streaks, recovery
  factor, monthly returns, equity curve, per-trade P&L.
- **Mega Score overlay** — the composite score is plotted under the price chart so
  entries/exits are explainable.
- **Strategy comparison** — run every strategy against the same ticker and rank them.
- **Parameter optimization** — sweep strategy parameters over a grid heatmap.
- **Walk-forward optimization** — repeatedly optimize on a rolling training window
  and verify on the unseen data after it; stitched out-of-sample equity curve and
  per-fold overfit flags expose parameter sets that only memorized the past.

### Data
- **Import** — drag & drop broker exports: Excel (.xlsx/.xls), CSV, or PDF statements.
  Columns are auto-detected (symbol, shares, price, side, fees), duplicates skipped.
- **Export** — CSV export for holdings and trade log.
- **Backup / Restore** — one-click JSON export/import of the whole database.

### App
- **Desktop app** — packaged with Electron (Windows NSIS/portable, macOS DMG, Linux AppImage)
  with optional **auto-updates** via GitHub Releases (see [Updating](#updating)).
- **Portable data** — in packaged builds the database lives in a `data/` folder next to
  the app (move it with the app; falls back to the OS userData folder when the install
  directory is read-only).
- **6 themes** — Dark, Light, Midnight, Ocean, Forest, Sunset.
- **Command palette** — Cmd/Ctrl+K to jump anywhere.
- **Undo/redo** — global Ctrl+Z / Ctrl+Y for trade edits.
- **Keyboard + mobile friendly** — responsive drawer navigation.

## Getting Started

On Windows, just double-click **`start.bat`** — it goes straight into the Electron desktop
app. On a fresh clone it automatically runs `npm install` first. Optional arguments:

- `start.bat` — desktop app (Electron, default — no menu)
- `start.bat browser` — browser mode on http://localhost:3000
- `start.bat update` — check GitHub Releases for updates
- `start.bat test-updates` — self-test of the update flow

Manual setup (any OS):

```bash
npm install
npm run dev              # browser mode on http://localhost:3000
npm run dev:electron     # desktop mode (Electron + Next dev server)
```

### Fresh clone on another computer

1. Install [Node.js](https://nodejs.org) (LTS).
2. `git clone https://github.com/Richardnajem/ACCUBOOK.git && cd ACCUBOOK`
3. Double-click `start.bat` (Windows) or run `npm install && npm run dev:electron`.

`package-lock.json` is committed, so `npm install` reproduces the same dependency tree
everywhere. The SQLite database (`portfolio.db`) is **not** in git — a demo portfolio is
seeded on first run, and you can restore your own data via in-app Backup / Restore.

## Packaging

```bash
npm run dist             # build + electron-builder installer
```

## Updating

**Dev installs:** pull the repo, `npm install`, re-run — the SQLite schema and caches
migrate on the fly.

**Packaged app (auto-update):** the Electron shell ships `electron-updater` wired to
GitHub Releases. To make it live:

1. Create a GitHub repo and set `build.publish` in `package.json`
   (`owner` / `repo` — replace the `SET-ME-*` placeholders).
2. Bump `version` in `package.json`, run `npm run dist`.
3. Draft a GitHub release tagged `v<version>` and upload the installer **plus** the
   generated `latest.yml` (and blockmap) files.

Installed apps then check GitHub on every launch: an in-app notice offers the update,
it downloads in the background and installs on quit. With the placeholders unset — or
offline — the whole check silently no-ops.

**Your data survives updates** (trades, watchlist, price cache, mega-history cache):
portable builds keep it in `data/` next to the app; installed builds in the OS userData
folder. As with any update, use the in-app **Backup / Restore** (one-click JSON export)
first for a belt-and-braces copy.

## Tech Stack

- Next.js 16 (App Router) + React 19
- better-sqlite3 (local database, WAL mode)
- Tailwind CSS 4 + Recharts
- Electron 44
- Yahoo Finance / Stooq (keyless market data)

## Project Layout

```
src/
  app/
    dashboard/            # UI pages (dashboard, holdings, trades, watchlist, mega-indicator, backtest)
    api/                  # Route handlers (trades, portfolio, watchlist, backtest, mega-indicator, import, data)
  components/             # SortableTable, ImportDialog, ThemeProvider
  lib/
    db.ts                 # SQLite schema + queries (trades, watchlist)
    portfolio.ts          # FIFO portfolio engine (positions, P&L, cash)
    market-data.ts        # Yahoo/Nasdaq/Stooq OHLCV fetch + SQLite price cache
    live-quotes.ts        # Real-time quote API (3s TTL)
    backtest-engine.ts    # Event-driven backtest simulator (SL/TP, walk-forward)
    strategies.ts         # Strategy catalog (incl. Mega Score regime)
    ta.ts                 # Technical indicators
    mega-indicator.ts     # Composite scoring engine (live snapshot)
    mega-score.ts         # Look-ahead-safe composite score time series
    mega-history.ts       # Cached score-over-time (SQLite)
    mega-prefs.ts         # Bridges saved Mega Indicator weights into the backtest
```

## Database

Stored at `portfolio.db` (project root in dev; portable `data/` folder next to the app
when packaged, falling back to Electron `userData`).
Tables: `trades`, `watchlist`, `price_bars`, `price_meta`, `mega_history_cache`.
A small demo portfolio is seeded on first run so the UI isn't empty — delete the trades
to start fresh.
