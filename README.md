# Stockfolio

A local-first **portfolio management desktop app** (Electron + Next.js + SQLite) **by Richard Najem**. Track your
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
  52-week-high/low distance, Kaufman Efficiency Ratio, and Nadaraya-Watson kernel
  regression (slope + residual), plus the full SMA/EMA 10–200 family and the
  Connors RSI / Coppock / PMO / DPO / Ease of Movement / ATR-stop catalogue.
  The default composite is **research-weighted to 100 points** (RSI and Bollinger
  20 each, MACD 10, the SMA/EMA family 0.5 each …); every indicator still has an
  adjustable weight and presets (Balanced / Everything / Trend / Momentum / Mean
  Reversion / Smooth Trends). The score drives a baseline decision shown beside
  the gauge — **Buy ≥ 65 · Hold 35–65 · Sell < 35** — and score-over-time
  history is computed with trailing windows only (no look-ahead) and cached in
  SQLite.
- **Watchlist** — track ideas with live quotes and target-price alerts that show how
  far price is from your entry point.
- **Indicators engine** — SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Connors RSI,
  Coppock, PMO, DPO, Ease of Movement and more (`src/lib/ta.ts`).

### Company Research
- **SEC fundamentals** — search any SEC filer by ticker or CIK: company profile,
  five annual income-statement, balance-sheet and cash-flow statements read from
  **filed XBRL facts** (10-K / 20-F / 40-F), with the exact concept behind each line.
- **Ratios & growth** — margins, ROE/ROA, debt/equity, current ratio, FCF margin and
  year-over-year revenue/EPS/FCF growth, computed from the filed statements.
- **Valuation** — market cap, enterprise value, P/E, P/S, P/B, EV/EBITDA, earnings,
  FCF and dividend yield against the live quote. Multiples use the latest **filed**
  fiscal year (not invented TTM numbers).
- **Foreign filers** — IFRS reporters (e.g. 20-F in DKK/EUR) keep their own currency;
  a real USD FX rate converts price and net debt so the multiples are comparable.
- **Filings** — recent 10-K/10-Q/8-K/20-F/40-F/6-K with direct SEC EDGAR links.
- **Honest coverage** — anything the filer did not report is shown as “—” and named
  in the coverage notes; analyst estimates and ratings are not in the SEC dataset and
  are not fabricated.

  Set `SEC_USER_AGENT` to a string with your contact address (SEC's fair-access
  policy) before using this in production.

### Backtesting
- **Famous strategies** — SMA/EMA crossovers, RSI mean reversion, MACD, Bollinger,
  breakout (Turtle), time-series momentum, buy & hold, and the **Mega Score Regime**
  strategy that trades the app's own composite indicator (`src/lib/strategies.ts`).
- **Mega Score weights & base score** — the Mega Score strategy (and its price-chart
  overlay) can use the weights you tuned on the Mega Indicator page; Compare/Optimize/
  Walk-Forward apply them too. Its buy/sell score levels are editable in the backtest
  (defaults: the Mega Indicator baseline, buy ≥ 65 / sell ≤ 35).
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

### Importing price-history workbooks

Settings → **Import Data → Price History** accepts any Excel/CSV workbook with daily OHLCV rows
(Nasdaq-style "Date / Close/Last / Volume / Open / High / Low" exports, technical-analysis sheets
with extra indicator columns, or bare headerless tables). It is deliberately flexible:

- every sheet in the workbook is scanned (Indicator columns are ignored)
- the header row is auto-detected, and headerless sheets are parsed by data shape
- the ticker is inferred from the sheet or file name (or a Symbol/Ticker column)
- **mixed date formats in one column are resolved automatically** (e.g. `9/16/26` next to
  `11/9/26` reading as Sep 11) by anchoring each ambiguous date to its unambiguous neighbours
- imported tickers are stored in the same local cache as live market data, so they work in
  Backtesting, the Mega Indicator, and the Watchlist — even offline

### Fresh clone on another computer

1. Install [Node.js](https://nodejs.org) (LTS).
2. `git clone https://github.com/Richardnajem/ACCUBOOK.git && cd ACCUBOOK`
3. Double-click `start.bat` (Windows) or run `npm install && npm run dev:electron`.

`package-lock.json` is committed, so `npm install` reproduces the same dependency tree
everywhere. The SQLite database (`portfolio.db`) is **not** in git — a demo portfolio is
seeded on first run, and you can restore your own data via in-app Backup / Restore.

### Portable exe on another PC

`release/Stockfolio-Portable-<version>.exe` is a single self-contained file — no Node.js,
no installer, no VC++ redistributable needed (Windows 10/11, 64-bit). A few things to know:

- **SmartScreen**: the build is unsigned, so the first run may show "Windows protected your
  PC" — click *More info → Run anyway*.
- **First run is slow**: the exe unpacks itself (hundreds of MB) before the window appears.
  Later runs are faster.
- **Your data travels with the file**: it lives in a `data/` folder created next to the exe.
  Copy that folder together with the exe when moving to another PC (installed builds keep
  data next to the installation, falling back to the OS userData folder if that's
  read-only).
- **If it fails to start**: the error window shows the server output, and the same details
  are saved to `server-last-error.log` inside the app's data folder.

## Packaging

```bash
npm run dist             # build + electron-builder installer
```

## Updating

**Dev installs:** pull the repo, `npm install`, re-run — the SQLite schema and caches
migrate on the fly.

**Packaged app (auto-update):** the Electron shell ships `electron-updater` wired to
GitHub Releases, and releases come from the tag-driven workflow:

**Releasing a new version:** one command — `npm run release:patch` (or
`release:minor` / `release:major`). `scripts/cut-release.mjs` refuses a dirty or
out-of-sync tree, runs lint + typecheck + tests, bumps `package.json` and
`package-lock.json`, commits `Release X`, tags `vX`, pushes both, and waits for
the workflows. Add `-- --dry-run` to see the next number without changing
anything. The `Release` workflow then builds the installers on a Windows runner
and publishes them itself: the Setup `.exe`, the portable `.exe`, their
blockmaps and `latest.yml`. It fails rather than shipping a release whose
`latest.yml` is missing, because that is the file every install reads to see
whether an update exists.

Installed apps then check GitHub on every launch and offer whatever the newest
release holds. Offline, the whole check silently no-ops.

**Your data survives updates** (trades, watchlist, price cache, mega-history cache):
portable builds keep it in `data/` next to the `.exe` — copy that folder to move
everything to another PC — and installed builds keep it in the OS userData folder,
which an in-place update never touches. Settings → **Data & backups** takes a
snapshot and restores one, so take one before a big update.

**Updating the copy on another computer** depends on what travelled with it:

- **The project folder:** `git pull`, `npm install`, then `start.bat`. The schema
  and caches migrate on the fly and `portfolio.db` stays where it is.
- **A portable `.exe`:** `start.bat update`, Settings → **Check for Updates** and
  the release page all hand you the *installer*, which keeps its data in userData,
  not in the `data/` folder beside the portable file. To stay portable, download
  `Stockfolio-Portable-<version>.exe` yourself and swap the file, leaving `data/`
  alone. To move to an installed copy instead, install first, then restore a
  backup from the portable folder.
- **An installed copy:** Settings → **Check for Updates** installs in place; your
  data is in userData either way.

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
    dashboard/            # UI pages (dashboard, holdings, trades, watchlist, research, mega-indicator, backtest)
    api/                  # Route handlers (trades, portfolio, watchlist, research, backtest, mega-indicator, import, data)
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
    research.ts           # SEC EDGAR fundamentals, ratios, FX and valuation
```

## Database

Stored at `portfolio.db` (project root in dev; portable `data/` folder next to the app
when packaged, falling back to Electron `userData`).
Tables: `trades`, `watchlist`, `price_bars`, `price_meta`, `mega_history_cache`.
A small demo portfolio is seeded on first run so the UI isn't empty — delete the trades
to start fresh.
