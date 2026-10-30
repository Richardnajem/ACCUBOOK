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
| `market-data.ts`, `quote-sources.ts`, `live-quotes.ts` | Price fetching & caching (daily bars, live quotes) |
| `intraday-data.ts` | **Intraday history** (Alpaca, minute/hour bars) for day-trading research: key from env, paginated REST, SQLite cache in `intraday_bars`/`intraday_meta`, pure `mapAlpacaBars`/`aggregateBars` helpers |
| `price-import.ts` | Importing prices |
| `bar-resample.ts` | **Trading frequency**: resamples daily bars to weekly/monthly and derives the cadence (`barMinutes`, `periodsPerYear`, `barUnit`) every metric is annualized on |
| `ta.ts`, `strategies.ts`, `backtest-engine.ts` | Technical analysis + backtesting. `strategies.ts` holds the catalogue: the slow **Mega Score Regime** (`mega_score`, 70/25) and the opt-in **Mega Score Fast** (`mega_score_fast`: velocity entry + ATR trailing stop, defaults measured). `backtest-engine.ts` owns the simulation, the trailing-stop exit, and the metrics (incl. the 0-100 risk factor). |
| `custom-indicators.ts`, `indicator-suggestions.ts` | Indicator definitions |
| `mega-indicator.ts`, `mega-score.ts`, `mega-overrides.ts`, `mega-prefs.ts`, `mega-history.ts` | The "mega indicator" scoring system |
| `mega-calibration.ts` | **Training** the mega system: weights + buy/sell bands fitted on a chronological train window, scored on the held-out tail (coordinate descent over grouped indicators, benchmark-relative objective, trial-count/deflated-Sharpe diagnostic) |
| `backup.ts`, `export.ts` | Backup / export (`csvText` + `downloadTextFile` are the shared helpers) |
| `chart-export.ts` | **Any chart → PNG**: clones the live Recharts SVG, bakes the computed styles in, draws it to a 2× canvas. `chartSlug` / `chartFileName` are the pure, tested parts |
| `log-export.ts` | Error-log formats: CSV rows, JSON payload, timestamped filenames |
| `asset-class.ts` | **Market Circle** grouping: user-assigned asset class per symbol (localStorage) or the live quote's currency, plus cash. `groupAllocation` is pure and tested. Labels are never inferred from a ticker |
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
| The composite's default weights or BUY/SELL bands | `src/lib/mega-indicator.ts` (`DEFAULT_WEIGHTS`, `MEGA_BASELINE`) — **re-derive them**, don't hand-edit: Backtest → 🎓 Train Weights, or `npm run test:calibrate` |
| The training tab itself | `src/lib/mega-calibration.ts`, `src/app/api/mega-train/route.ts`, `src/app/dashboard/backtest/TrainingLab.tsx` |
| Price sources | `src/lib/quote-sources.ts`, `src/lib/live-quotes.ts` |
| Backtesting | `src/lib/backtest-engine.ts`, `src/app/dashboard/backtest/` |
| Intraday / day-trading research | `src/lib/intraday-data.ts` + `tests/intraday-live.test.ts` (`INTRADAY_LIVE=1`, needs `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`); day-trading mode is the engine's `flatAtSessionEnd` |
| Adding or retuning a strategy | `src/lib/strategies.ts` — every strategy carries its params, its causal signal, and (if it has one) the dated measurement behind its defaults |
| Backtest metrics (risk factor, trade stats) | `RiskMetrics` + `BacktestSummary` in `src/lib/backtest-engine.ts`, cards in `src/app/dashboard/backtest/StockBacktest.tsx` |
| The backtest **Excel export** (bars, every indicator per day, trades, equity) | `src/lib/backtest-export.ts` (rows/sheets/workbook), `runStockBacktestDetailed` in `src/lib/backtest-engine.ts`, `case 'exportWorkbook'` + `parseRunConfig` in `src/app/api/backtest/route.ts`, the button in `StockBacktest.tsx` (`tests/backtest-export.test.ts`) |
| The **full-history price + indicator Excel export** (every trading day, every indicator, no backtest window) | `src/lib/price-export.ts` (rows/sheets/workbook), `src/app/api/export/prices/route.ts` (`GET /api/export/prices?symbol=…&years=…`), the button on the Mega Indicator page (`tests/price-export.test.ts`) |
| Shared UI | `src/components/` |
| A dashboard card | `src/components/MarketCircle.tsx` (asset-class/market circle) or the panel in `src/app/dashboard/<section>/page.tsx`; add its id to that board's `ids` so drag/layout picks it up |
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

## Mega Score weights and bands are measured, not chosen

`DEFAULT_WEIGHTS` and `MEGA_BASELINE` in `src/lib/mega-indicator.ts` carry dated
comments with the run behind them (24 tickers × 15 years — the 16 index/large caps
plus a high-volatility block — 60/40 · 70/30 · 80/20 splits). Two things must stay
true when they change:

- **The objective is relative to buy & hold.** Raw Sharpe quietly rewards staying
  fully invested — the first version of the trainer "learned" to hold 95 % of the
  time and trade 1.4 times per symbol, i.e. buy & hold with extra steps.
- **Bands are judged against the score's own distribution.** The composite sits at
  p10 ≈ 50 / median ≈ 65 / p90 ≈ 75, so a 35 exit (the old value) sits below the
  10th percentile: it exited mid-range, re-entered near the top, and its re-entries
  won ~50 % of the time. That is where the loss trades came from. Measured Oct 2026
  across entry 55-85 × exit 20-50: nothing stricter than 70/25 pays — each extra
  exit point costs more return than it saves in drawdown (80/40 = 9.8 pt of
  drawdown for 0.48 Sharpe).
- **One retrain is not evidence for a new map.** The trainer's objective sees ~1.4
  trades per symbol, so it cannot separate weight maps by more than noise; a
  12-retrain stability check (2 universes × 3 splits × catalogue off/on) moved every
  axis in both directions except volume-vs-20-day. Training on the large-cap-only
  half also *loses* out of sample (−0.11 excess Sharpe vs −0.02), so a "trained" map
  from a narrow universe is a downgrade, not a fix. Change these numbers only with a
  cross-split, cross-universe measurement behind them.

## Entry filters: measured, and left off

The Mega Score rule has two optional entry gates — `confirm` (the band must hold
for N signal bars) and `trendMa` (close must be at or above its own trailing SMA).
Both default to neutral, and `npm run test:filters` is the harness that says
whether that should change: it loads the cached `portfolio.db` bars, computes the
composite once per symbol, then runs the real engine for each gate × band pair on
the full history and both held-out tails.

Measured Oct 2026 (26 tickers × 20 years, 2 bps each way): at the shipped 70/25
the rule makes ~5 decisions across the whole universe, so no gate is
distinguishable there. At 55/45, where losses are measurable (1,333 trades), the
loss rate went 58.3 % → 58.2 % (confirm-3) / 58.3 % (confirm-5) / 56.6 %
(trend-200) / 55.9 % (both), but trade count fell 1,333 → 839 and Sharpe
0.57 → 0.54; on the last-30 % window trend-200 was worse than baseline. So the
gates cut the *number* of losers mostly by trading less, not the loss rate, and
the defaults stay off. Re-run the harness before quoting a different number, and
do not describe either gate as a free improvement.

The same harness also swept risk exits over the volatile names (TSLA, AMD, NVDA,
MSTR, SMCI, COIN, FSLR, MU, GME) and the whole cache. Three results matter more
than any parameter:

- **Losers are indistinguishable from winners at entry.** On the volatile names at
  55/45 (1,016 rule exits, all `signal` exits) the loss rate was 65 %, and the
  average entry reading was 67.7 for losers vs 68.7 for winners. Losers were held
  ~31 days, winners ~135. The losses are short whipsaws, not weak entry readings —
  so no entry gate or extra indicator can filter them out.
- **A stop-loss makes the slow rule much worse.** At 70/25 a 15 % stop turned 5
  decisions into 129 trades with 126 losses (return 6,259 % → 5,903 %, average
  trade 488 % → 27 %); adding `reentryNeedsSignal` gave 26 trades, all losers,
  Sharpe 0.64 → 0.04. The engine re-buys at the next open while the regime is
  still long, so the stop only harvests volatility. The backtest UI warns when a
  stop is set on `mega_score` — keep that warning.
- **ATR trailing stops are not a fix either.** 3×/4× ATR cut the loss rate by ~3
  points and the average loss, but cut the average win from 43 % to 14-28 % and
  Sharpe from 0.57 to 0.31-0.42.

**Training on the cached tickers did not separate losers — at any split, with or
without the catalogue.** `npm run test:trained` runs the same 26 tickers, two
passes, four maps, then scores EVERY map on the same held-out last-40 % and
last-20 % windows (so the maps are compared on identical sessions):

| Map | Bands | Trainer held-out Sharpe | Excess | Luck bar | Clears | AUC all names (last 20 %) | AUC volatile (last 20 %) |
|---|---|---|---|---|---|---|---|
| shipped default | 70/25 | **0.70** | — | — | — | 0.497 | 0.475 |
| built-in 70 % | 72.5/32.5 | 0.69 | −0.19 | 0.59 | no | 0.506 | 0.515 |
| catalogue 60 % | 77.5/32.5 | 0.74 | −0.11 | 0.64 | no | 0.479 | 0.440 |
| catalogue 70 % | 72.5/35 | 0.71 | −0.18 | 0.61 | no | 0.542 | 0.557 |
| catalogue 80 % | 75/37.5 | 0.74 | −0.22 | 0.59 | no | 0.445 | 0.430 |

AUC is the chance a random winner's entry reading beats a random loser's (0.5 = no
separation). No map cleared its own excess-Sharpe luck bar, and separation stayed at
chance with no stable sign: catalogue-80 had the LOWEST loss rate on the last 20 %
(51.5 % vs 54.8 % for the shipped map) while its AUC was 0.445 — worse than a coin
flip. The lower loss rate came from different exposure, not from identifying losers.
`DEFAULT_WEIGHTS` and 70/25 stay, and the adoption gate remains
`clearsExcessBar` — never a loss-rate improvement.

## Exit and smoothing: measured, and left at 5 / 25

`npm run test:exit` sweeps the two inputs the earlier harnesses held fixed — the
score smoothing window and the exit band — over the same 26 cached tickers and
2 bps costs, on the full history and both held-out tails. Measured Oct 2026:

- **Smoothing 5 wins on both tails.** At exit 25, last-40 % / last-30 % Sharpe by
  window: 0.75/0.74 (1 day), 0.75/0.77 (3), **0.76/0.78 (5, shipped)**, 0.73/0.74
  (10), 0.72/0.73 (20). A faster window trades ~18× more on the full history (88
  trades vs 5) for a lower Sharpe, so "sell sooner by smoothing less" is not free.
- **Every exit above 25 is worse on both tails** (30 → 0.74/0.75, 35 → 0.71/0.71,
  40 → 0.67/0.66, 45 → 0.61/0.58, 50 → 0.60/0.55). The exit is a guardrail, not
  a risk control; raising it to "fix losing trades" measured worse every time.
- **A dead exit is now impossible to miss.** At 70/25 the band was reached on
  ~0.0-0.1 % of sessions, and smoothing ≥ 10 made it unreachable (zero trades).
  `runStockBacktestDetailed` therefore warns when a band is never reached, naming
  the lowest smoothed score and the measured trade-off.
- **One smoothing predicate.** `smoothsScore()` in `backtest-engine.ts` decides
  which strategies read the smoothed composite. It replaced two hand-written
  conditions that disagreed for `mega_score_fast`, so a fast run logged the RAW
  score on each trade while its export wrote a SMOOTHED signal column.
  `tests/score-smoothing.test.ts` pins the logged reading; `tests/exit-reachability.test.ts`
  pins the reachability rule (a reading exactly on the band is a hold, not a sell).

## Optimizer axes skip research switches

`StrategyParam.sweep: false` marks a parameter as a research switch. `optimizerAxes()`
excludes those before picking the widest-range axes, because a 0-400 trend filter
otherwise outranks the 10-90 bands and the optimizer silently stops optimizing the
bands. `tests/optimizer-axes.test.ts` pins this for `mega_score`; when adding a
parameter with a wide range, decide its `sweep` flag in the same commit.

## Per-indicator edits are a user layer, not a measured default

Every indicator can be edited in place (`IndicatorOverride` in `mega-indicator.ts`):
its name/unit/description, its scoring rule, and `formula` — a user expression that
**replaces** the built-in calculation, compiled by `custom-indicators.ts`'s sandbox.
`specsWithOverrides()` applies the patch list (a missing field keeps the built-in),
`computeMegaIndicator` and `computeMegaScoreSeries` both take the map, and the routes
(`mega-indicator`, `mega-history`, `backtest` → `megaOverrides`) carry it from the
browser so the live score, the history and a backtest agree. Three rules:

- **The trainer never sees them.** `mega-calibration.ts` calls
  `computeMegaScoreSeries` without the overrides on purpose: a shipped weight map
  measured against one user's ad-hoc formula would not be the map everyone else gets.
  Keep that separation — `DEFAULT_WEIGHTS`/`MEGA_BASELINE` stay measured on the
  catalogue, and an edit is per-device (localStorage) like the weights themselves.
- **A bad formula degrades, it does not lie.** One that fails `parseFormula` is
  dropped before storage; one that compiles but yields no value keeps the built-in
  series and records a readable error naming the id (surfaced as a warning).
- **The history cache key includes the edits** (`hashOverrides`). An edited formula
  changes every point, so serving the pre-edit series would be wrong, not stale.

## The backtest workbook is the run, not a re-derivation

Backtest → **Export Excel (all data)** returns one `.xlsx` built from the SAME run
that is on screen: `backtest-export.ts` only turns data into rows, and
`runStockBacktestDetailed` hands it the bars the simulator traded plus the composite
computed with the same weights and per-indicator edits. The route parses the config
once (`parseRunConfig`), so the run and its export cannot drift apart.

Rules inside the workbook:

- **A warm-up reading is a blank cell, never 0.** 0 is a real Mega Score and a real
  indicator value; a sheet full of 0s looks like data and is not.
- **Numbers stay numbers** (equity to 2 dp, drawdown to 4 dp, prices as stored) so
  Excel can sum, sort and chart them — the file is for checking the run by hand.
- **Missing message text is never blank-silent**: a column that could not be produced
  says why (see the indicator catalogue and the run warnings in Summary).
- **A later re-export can differ in the 5th decimal** from an earlier one: the price
  loader refetches when the cache does not reach the last complete session, and a
  fresh Yahoo series carries marginally different adjusted closes. That is sub-penny
  and cannot change a decision, but it is why the export re-runs rather than replaying
  a cached workbook.

## Trading frequency is chosen, and daily is the measured winner

The backtest API/config takes `barInterval` (`daily` | `weekly` | `monthly`);
`loadBars` resamples before `simulateCore`, so one chooser tests all three with
identical costs. Measured Oct 2026 on 24 tickers × 15 years (full + last 40 % +
last 30 %), shipped 70/25: daily **+0.01 / +0.01 / +0.08** excess Sharpe, weekly
−0.01 / −0.10 / −0.02, monthly −0.10 / −0.07 / **no trades at all** on the tail.
Two rules follow:

- **Monthly cannot be judged on 15 years.** The composite needs 200- and 252-bar
  windows; a 15-year monthly series is ~180 bars, so the score is partly undefined
  and a monthly run can be silent. `loadBars` therefore validates `minBars` against
  the RAW daily series and the engine warns when a resampled run is shorter than the
  strategy expects — keep that warning rather than raising the limit, and present a
  monthly result only with the bar count beside it.
- **Annualisation is per frequency, never 252 by default.** 52 weekly, 12 monthly,
  252 × 390/minutes intraday — all derived in `barCadence()`. Any new metric must
  read `summary.periodsPerYear`, not hard-code a number.

The weights were re-checked at weekly and monthly on the volatile subset and the
shipped balanced map still wins (weekly 0.00 vs −0.12 flat; monthly −0.10 vs −0.19),
so it stays as measured — do not hand-tune it from a single frequency's result.

## Intraday runs must not borrow daily assumptions

`Bar[]` carries daily and intraday series through the same engine, so two things are
derived from the data instead of assumed:

- **Annualisation.** Sharpe/Sortino/volatility use `sqrt(periodsPerYear)`, where
  `periodsPerYear` comes from the median bar spacing (252 daily, 252 × 390/minutes
  intraday). Re-hardcoding 252 would inflate an intraday Sharpe by ~8.8× at 5-minute
  bars. `summary.barMinutes` and `summary.periodsPerYear` are printed with every run.
- **Sessions.** Day-trading mode (`config.flatAtSessionEnd`) closes at each session's
  last bar and refuses entries whose fill would land overnight; it is ignored, with a
  warning, when the series is daily. Session identity is the UTC date prefix of the
  timestamp, so an intraday test is always flat across the overnight gap.

The Alpaca free tier is IEX-only (~2-3 % of consolidated volume): a result on it is
"what this does on a thin tape", and the harness prints the feed it used. Never
present an intraday measurement without that caveat, and never present one from a
single ticker or a single month.

## Trading frequency is measured, and more of it lost

`mega_score_fast` exists so "trade more often?" can be answered with numbers instead
of intuition. Same harness, 24 tickers × 15 years, 2 bps each way, full window plus
both held-out tails (108 parameter sets): the slow 70/25 rule makes 0.07 trades per
ticker per year (+0.01 / +0.01 / +0.08 excess Sharpe) and the best fast cell makes
2.71 (46 % win rate, +5.9 % per trade, −0.20 / −0.36 / −0.24). More trades bought a
real drawdown cut (56 % → 43 %) and paid 20-36 points of Sharpe for it. Two rules
follow from that:

- **Do not raise the bands to trade more.** Every stricter cell of the 55-85 × 20-50
  grid was measured; looser is the only direction that keeps the rule invested.
- **Do not ship a fast variant without its measurement.** If the defaults are ever
  changed, re-run the sweep (temporary harness on cached bars — the numbers are in
  the comment above `megaScoreFast`) and update the comment and README table with it.

Also measured: on the full window 70/25 closed one trade on 22 of 24 tickers — the
score never reached 25 on them (floor 23-34), so that rule is buy & hold plus a
never-fired guardrail. Do not describe it as an active strategy.

The Training tab also reports **entry-reading separation** for the prior and the
trained map on the held-out window, at the bands the run would apply: mean entry
reading of winners vs losers, their gap, and AUC (chance a random winner's reading
beats a random loser's — 0.5 is none). It exists because a trained map can post a
lower loss rate purely by trading a different set of names; measured Oct 2026 the
AUC stayed 0.43-0.60 across 60/70/80 splits with the catalogue, with no stable
sign, so treat it as a warning metric, not a pass mark. `collectEntryOutcomes`
replays the calibration fill model and excludes a position still open at the end
of the window (its close was not a decision).

**Per-symbol breakdown.** `CalibrationResult.separation.perSymbol` carries the
same metric for the trained map per ticker, sorted worst AUC first; the card
expands into that table. Checked on the 26 cached tickers, last 20 % window, five
maps (default + built-in 70 % + catalogue 60/70/80): per-symbol AUC ≥ 0.55 was
held by 7/26, 11/26, 8/24, 14/26 and 6/25 tickers respectively — near the ~30 % a
0.55 cut gives by chance. Only **GME, GOOGL, QQQ and WMT** cleared 0.55 under every
map that could judge them, and those maps are near-identical, so that is one
measurement replicated, not four independent ones.

**Leave one ticker out entirely** (`npm run test:leaveout`): train on 25 cached
tickers, then test the excluded volatile name cold on its last 30 %. Of the 8 names
with a usable tail (COIN's history is shorter than the shared split, so it is
skipped), the trained map beat the prior's excess Sharpe on **3/8** (median −0.04)
with pooled AUC **0.435** and a −0.5 point entry gap; trained weights alone beat
the prior on **0/8**. A map fitted to the excluded ticker's own first 70 % beat the
prior on just **1/8** — so the failure is the composite, not the training protocol,
and out-of-universe names are no better than out-of-time windows.

The training run is deterministic (no RNG), so re-running it on the same universe
and window must reproduce the same weights. `tests/mega-calibration.test.ts` pins
the engine's rules on synthetic data; `tests/mega-calibration-live.test.ts` is the
opt-in real-data harness (`npm run test:calibrate`, network required) that prints
the side-by-side comparison a human then decides on. Run it through the script,
not raw vitest: without `--disableConsoleIntercept` Vitest captures console and the
whole report is invisible, so the run looks like it passed with nothing to show.

## Error logging

`src/lib/errorLogger.ts` installs global handlers (`window.onerror`, unhandled
rejections, `console.error/warn`), de-duplicates and caps entries, and persists
them to `localStorage['stockfolio-error-log']` — read it with
`JSON.parse(localStorage.getItem('stockfolio-error-log'))`. Server/render crashes
hit `src/app/global-error.tsx`, which logs to the same store and shows a retry UI.
`<ErrorLoggerInit />` is mounted once in `src/app/layout.tsx`.

**Exporting it:** Settings → **Logs** shows the entries and downloads them as CSV
(`errorLogsToCSV`) or JSON (`errorLogsToJSON`) with stack traces. Every write fires
`stockfolio:error-log` on `window`, so an open Logs panel refreshes itself.

**Exporting graphs:** every Recharts chart gets a PNG button from `<ChartExporter />`
(mounted in `src/app/dashboard/layout.tsx`, so `/strategies` inherits it). It covers
line/area/bar/scatter **and the circular allocation donut**; charts that mount later
are picked up by a debounced MutationObserver. Put `data-chart-title="…"` on a
container when the nearest heading is not the filename you want.

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

## Price basis is replaced, never blended

`basisMismatch()` in `src/lib/market-data.ts` decides whether a cached series may
be extended by an incoming fetch. Sources do not share a basis (Yahoo is
dividend-adjusted, Nasdaq/Stooq raw), so any change of provider — **and an
unknown cached basis (`price_meta.source` NULL, i.e. a pre-migration cache)** —
replaces the symbol's history instead of appending to it. The replacement also
refetches the NEW source's own full history (`BASIS_REPLACEMENT_YEARS`) before
deleting, because deleting first and storing only the requested window let a
1-year request shrink a 10-year cache. `tests/basis-guard.test.ts` pins all four
cases. A seam of mixed bases is invisible in the UI and corrupts every indicator
and backtest that reads the cache, so do not relax this to "same source only".

## Losing-trade evidence and its report

`docs/lost-trades-report.docx` is generated, not hand-written:
`node scripts/make-lost-trades-report.mjs` (no dependency — it writes a real
OOXML zip). It states the universe, windows and costs behind every figure. The
numbers come from `npm run test:filters`, `npm run test:trained` and
`npm run test:leaveout`; if you re-run those, regenerate the report rather than
editing the document. The measured rules it protects: losses are short whipsaws
(entry readings of winners and losers differ by ~1 point, AUC ≈ 0.5), stops turn
one hold into many losses, and no trained weight map has cleared its own
held-out luck bar — so do not adopt a map because its loss rate fell.

## Gotchas

- **Native module.** `better-sqlite3` is a compiled dependency; if `npm install`
  leaves `node_modules` incomplete (missing `next`, empty `.bin/`), re-run
  `npm install` — a partial install breaks both `npm test` and `npm run build`.
- `/api/data` and `/api/verify-data` are the integrity endpoints — keep the UI in
  step with them when changing the DB shape.
- Keep market data honest: if a quote source fails, surface it rather than
  substituting a stale/estimated price silently.
