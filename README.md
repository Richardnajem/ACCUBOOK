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
  The default composite is **research-weighted to 93.5 points** (RSI and Bollinger
  20 each, MACD 10, the SMA/EMA family 0.5 each …); every indicator still has an
  adjustable weight and presets (Balanced / Everything / Trend / Momentum / Mean
  Reversion / Smooth Trends). The score drives a baseline decision shown beside
  the gauge — **Buy ≥ 70 · Hold 25–70 · Sell < 25** — and score-over-time
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
  breakout (Turtle), time-series momentum, buy & hold, the **Mega Score Regime**
  strategy that trades the app's own composite indicator, and **Mega Score Fast**
  (score velocity + ATR trailing stop), the opt-in higher-frequency variant
  (`src/lib/strategies.ts`).
- **Mega Score weights & base score** — the Mega Score strategy (and its price-chart
  overlay) can use the weights you tuned on the Mega Indicator page; Compare/Optimize/
  Walk-Forward apply them too. Its buy/sell score levels are editable in the backtest
  (defaults: the Mega Indicator baseline, buy ≥ 70 / sell < 25 — a reading sitting
  exactly on 25 is still held, matching the Mega Indicator badge).
- **🎓 Train Weights** — a training tab that fits the composite's per-indicator weights
  *and* its buy/sell bands on a universe of tickers, on the first 60/70/80 % of each
  history, then reports the untouched tail. See [Calibrating the Mega Score](#calibrating-the-mega-score).
- **Real market data** — daily OHLCV from Yahoo Finance (split/dividend-adjusted,
  multi-host failover) with Nasdaq and Stooq fallbacks, cached in SQLite so repeat
  backtests are instant and work offline.
- **Realistic simulation** — signals execute at next bar's open (no look-ahead bias),
  with commissions, slippage, position sizing, and optional **stop-loss / take-profit**
  exits (gap-aware fills, exit reasons per trade). Strategies that ask for one also get
  an **ATR trailing stop** (level from the previous bar's high-water close, so it never
  sees the bar it fills in; after it fires the rule waits for its own signal to go flat
  before re-buying instead of churning on the stale reading).
- **Benchmark picker** — compare against any ticker's buy & hold (e.g. NVDA vs SPY),
  not just the same symbol.
- **Full metrics** — CAGR, Sharpe, Sortino, Calmar, max drawdown, win rate, profit
  factor, time in market, expectancy, payoff ratio, max loss/win streaks, recovery
  factor, monthly returns, equity curve, per-trade P&L — plus **closed trades,
  trades per year and average hold** so trading frequency is judged, not guessed.
- **Risk profile** — annualized **volatility** (with buy & hold beside it), **beta**
  to the benchmark, **downside deviation**, the **Ulcer index**, and a 0-100 **risk
  factor** whose blend (40 % volatility vs buy & hold + 35 % Ulcer + 25 % max
  drawdown) is printed next to it. All components are measured from the same daily
  equity curve the Sharpe ratio uses; only the factor itself is a model.
- **Mega Score overlay** — the composite score is plotted under the price chart so
  entries/exits are explainable.
- **Trade log detail** — click any trade (or its Entry date) for the exact entry and
  exit sessions and the Mega Score reading that triggered each side, with the fill
  day's own score beside it. The table columns and CSV export carry the same scores;
  stop-loss re-entries are flagged (↻) because they reopen without a fresh crossing.
- **Strategy comparison** — run every strategy against the same ticker and rank them.
- **Parameter optimization** — sweep strategy parameters over a grid heatmap.
- **Frequency is a dial, not a win** — measured on 24 tickers × 15 years at 2 bps
  each way, the fast rule trades ~2.7 times per ticker per year (0.07 for 70/25),
  wins 45 % of them at +5.9 % average, cuts drawdown (42 % vs 56 %) and still ends
  **0.20 excess Sharpe behind buy & hold against +0.01 for 70/25**. More trades cost
  more time out of the market than the per-trade edge pays for; see the table below.
- **Walk-forward optimization** — repeatedly optimize on a rolling training window
  and verify on the unseen data after it; stitched out-of-sample equity curve and
  per-fold overfit flags expose parameter sets that only memorized the past.

### Which frequency to trade (daily / weekly / monthly)

The Backtest page has a **Trading frequency** chooser (and the Compare tab has the
same one), so the question is measured rather than assumed: the daily series is
resampled to weekly or monthly bars and *the same rules, costs and risk metrics* are
run on it.

Measured Oct 2026 — 24 tickers × 15 years, cached daily bars, 2 bps + 2 bps, the
shipped 70/25 rule:

| Frequency | Window | Trades / ticker / year | Win rate | Excess Sharpe | Max DD | Risk factor | Time in market |
|---|---|---|---|---|---|---|---|
| **Daily** | full | **0.07** | **96 %** | **+0.01** | 55.6 % | 70 | 100 % |
| Weekly | full | 0.07 | 96 % | −0.01 | 54.2 % | 69 | 97 % |
| Monthly | full | 0.07 | 100 % | −0.10 | 47.2 % | 63 | 80 % |
| **Daily** | last 40 % | 0.17 | 96 % | **+0.01** | 47.6 % | 68 | 99 % |
| Weekly | last 40 % | 0.17 | 100 % | −0.10 | 46.8 % | 67 | 94 % |
| Monthly | last 40 % | 0.16 | 96 % | −0.07 | 37.8 % | 56 | 76 % |
| **Daily** | last 30 % | 0.22 | 96 % | **+0.08** | 41.0 % | 63 | 97 % |
| Weekly | last 30 % | 0.22 | 96 % | −0.02 | 37.4 % | 58 | 89 % |
| Monthly | last 30 % | — | — | — | — | — | — |

Three things this settles:

- **Daily wins, weekly is a tie with less exposure, monthly is out.** Going slower
  does not rescue the signal: turnover is already ~0.07 trades per ticker per year,
  so there is no cost to save, and monthly gives up return without buying meaningful
  risk reduction.
- **Monthly is also partly undefined, not just worse.** The composite needs a 200-bar
  and a 252-bar window; 15 years of monthly bars is ~180 bars, so large parts of the
  score have no reading — that is why the last-30 % monthly run closed **0 trades**.
  Trading this score monthly needs ~20+ years of history, and its "52-week high"
  input would then mean 12 bars, not a year.
- **The bands are frequency-specific but the shipped pair still holds.** At weekly,
  60/20 and 65/35 are within noise of 70/25 (−0.01…+0.01) and 75/35 is worse (−0.11);
  at monthly every pair is negative, 60/20 least so (−0.03). Nothing beats daily 70/25.

On the **volatile subset** (TSLA, AMD, NFLX, MU, FSLR, GME, MSTR, SMCI, COIN, BAC):
daily 70/25 **+0.03**, weekly 0.00, monthly −0.10; the fast rule is negative at every
frequency (daily −0.17, weekly −0.27, monthly −0.32). The **weights check** at weekly
and monthly agrees with the daily one from the calibration section: the shipped
balanced map is the best tested (weekly 0.00 vs −0.12 for flat 1s; monthly −0.10 vs
−0.19), which is why it has not been changed by hand.

Risk level travels with the frequency: measured across the 24 tickers, daily and
weekly land at risk factor 70 / 69 (8 *Elevated*, 16 *High*), monthly at 63 (5
*Moderate*, 7 *Elevated*, 12 *High*) — lower because it sits out more of the drawdown,
not because the exposure is smaller.

### Day trading / intraday history

Every other backtest here runs on daily bars, so an intraday question ("would this
work if the position opened and closed inside one session?") cannot be answered at
all from that data. `src/lib/intraday-data.ts` adds a second, timestamped series
with the same `Bar` shape the engine already consumes.

**Data source — Alpaca Market Data** (<https://alpaca.markets/data>). The free plan
covers **7+ years of minute/hour aggregate bars** with 200 requests/min and no
per-record charge, which is enough for a real multi-year test. Two honest caveats:
the free plan serves the **IEX feed only** — real trades, but roughly 2-3 % of
consolidated volume and no auction prints — and consolidated SIP needs Algo Trader
Plus ($99/mo). Databento (usage-based, free credits on signup) is the alternative
when the tape depth matters more than the price.

Set either naming — nothing is written anywhere, and keys are never committed:

```bash
ALPACA_API_KEY_ID=... ALPACA_API_SECRET_KEY=...        # or APCA_API_KEY_ID / APCA_API_SECRET_KEY
```

Then run the measurement (skipped by `npm test` — it needs the network):

```bash
INTRADAY_LIVE=1 npx vitest run tests/intraday-live.test.ts --silent=false
# optional: INTRADAY_TICKERS, INTRADAY_YEARS (2), INTRADAY_TF (5Min/1Min/15Min/1Hour), INTRADAY_FEED (iex|sip)
```

It runs the **same rules on the same window with the same costs** (2 bps + 2 bps)
and the same risk metrics, and prints: the fast rule day-traded (flat at each
session's last bar), the same rule on daily bars, the slow 70/25 rule day-traded,
and daily buy & hold as the hurdle — plus the cost drag line
(`round trips/ticker/year × 4 bps`), which is the number day trading has to clear
before any losing trade. Bars are cached in SQLite (`intraday_bars`), so repeat runs
are offline.

In the engine, `flatAtSessionEnd` is the day-trading switch (close at the last bar
of each session, and no entry whose fill would land overnight); it is ignored with a
warning on daily bars. Runs report their own cadence: the results line says how many
bars and their length, average hold is shown in bars/minutes rather than "days", and
`summary.barMinutes` / `summary.periodsPerYear` carry the sampling — Sharpe,
Sortino and volatility are annualized with `sqrt(periodsPerYear)` derived from the
bar spacing (252 daily, 252 × 390/barMinutes intraday), never a hard-coded 252.

### Calibrating the Mega Score

Backtesting → **🎓 Train Weights** runs `src/lib/mega-calibration.ts` and
`/api/mega-train`. It is the same measurement the shipped weights came from, so
the numbers in `mega-indicator.ts` can be re-derived instead of trusted.

What a run does:

1. Builds every indicator's causal 0–100 score once per ticker (weight changes
   only re-blend; they never recompute indicators).
2. Searches ~40 **units**, not 50 free weights: the 16 SMA/EMA readings are one
   unit (the same trend counted sixteen times), Stochastic %K/%D and StochRSI
   %K/%D are each one unit, everything else is its own. A small L1 penalty keeps
   the answer near the current defaults, so a level has to earn its change.
3. Searches the entry/exit bands with the weights frozen (pairs narrower than 10
   points are rejected), then alternates weights ↔ bands.
4. Reports **prior vs equal-weight vs bands-only vs weights-only vs trained** on
   both windows, per-ticker results, the score percentiles the bands sit in, how
   many candidates were tried, and the Sharpe pure luck would produce over that
   many tries (Bailey & López de Prado's deflated-Sharpe idea).

That last number is reported on **two scales**, and the distinction decides
verdicts. The search maximizes Sharpe *in excess of buy & hold*, so the bar that
matters is the one for the excess measure — computed from the measured per-bar
correlation between the rule and its own benchmark, which is high (the rule holds
the stock most of the time) and therefore makes the excess bar lower than the raw
one. Judging a raw Sharpe against the raw bar is how a rule whose excess over
buy & hold is *negative* can look like it "cleared" a threshold. The tab prints
both and compares the held-out **excess** against the excess bar.

The same report runs headless — `npm run test:calibrate` (network required, a
minute; `MEGA_UNIVERSE=` and `MEGA_YEARS=` override the universe and history).

Rules the tab enforces: the search never reads the held-out tail; the objective is
**mean Sharpe in excess of buy & hold** (plus credit for cutting the drawdown) over
tickers that actually traded — raw Sharpe silently rewards staying fully invested.

Measured Oct 2026 — 24 tickers, 15 years, 2 bps commission + 2 bps slippage,
chronological 60/40 · 70/30 · 80/20 splits. The universe is the 16 index/large-cap
tickers **plus a volatile block** (TSLA, AMD, NFLX, MU, FSLR, GME, MSTR, SMCI, 47–99 %
annualized volatility), because a rule only ever tested on slow uptrends learns to
sit long. Every number below is a mean over three universes (the 16, the volatile
block, all 24) × three splits, taken from the held-out tail.

Weights — bands frozen at 70 / 25:

| Weights | Trades / symbol | Win rate | Excess Sharpe vs B&H |
|---|---|---|---|
| **Shipped: balanced (RSI 20 / Bollinger 20 / MACD 10)** | **1.4** | **89 %** | **−0.02** |
| Everything equal | 8.7 | 45 % | −0.15 |
| Trained on the 16 index/large caps only | 2.2 | 73 % | −0.11 |
| Trained on the volatile block | 1.2 | 93 % | −0.01 |
| Trained on all 24 | 1.4 | 89 % | −0.02 |

Bands — shipped weights:

| Entry / exit | Trades / symbol | Win rate | Excess Sharpe | Drawdown cut vs B&H |
|---|---|---|---|---|
| **70 / 25 (shipped)** | **1.4** | **89 %** | **−0.02** | −0.0 pt |
| 65 / 35 (the old pair) | 9.1 | 48 % | −0.10 | −1.1 pt |
| 75 / 35 | 7.3 | 53 % | −0.15 | +2.4 pt |
| 80 / 40 | 7.6 | 44 % | −0.48 | +9.8 pt |
| 85 / 50 | 2.7 | 38 % | −0.67 | +32.4 pt |

Three things this run settles:

- **The 65/35 pair is still the loss generator.** A 35 exit fires on ordinary
  pullbacks and the re-entries win about half the time. The composite's own
  distribution (p10 ≈ 50, median ≈ 65, p90 ≈ 75) explains it — 35 sits below the 10th
  percentile, so the rule exited mid-range and re-entered near the top. At 25 it only
  leaves on a genuine breakdown.
- **Stricter bands buy drawdown protection with return, and the exchange rate is
  poor.** Every cell above 70/25 lowers excess Sharpe; the 32-point drawdown cut at
  85/50 costs 0.67 Sharpe. 70/25 sits at the top of that trade-off curve. The band
  search does pick 75–77.5 / 27.5 on the training window (an entry a little stricter,
  an exit a little wider), and out of sample that is indistinguishable from 70/25 —
  it neither helps nor hurts. On the volatile block the band search is actively
  dangerous: it chose exits of 45–50 and lost 0.16–0.28 excess Sharpe out of sample,
  so read its "trained bands" offer with suspicion when few tickers are volatile.
- **The weights were left alone on purpose.** The shipped map survives the volatile
  universe, and 12 retrains (2 universes × 3 splits × catalogue off/on) show no
  move that is stable across runs except volume-vs-20-day drifting down on half of
  them. With ~1.4 trades per symbol the objective cannot separate two weight maps
  by more than noise, and training on the large-cap-only half now *loses* out of
  sample — the slow uptrends there reward staying long and the search trims the
  trend/momentum legs. Adopting a map from one run would be adopting luck.

**Does trading more help?** Same universe, same 15 years, same 2 bps each way,
full window and both held-out tails (a separate run, Oct 2026 — 108 parameter sets of
the **Mega Score Fast** rule: velocity entry + ATR trailing stop, opt-in, defaults
re-derived from the sweep):

| Rule | Trades / ticker / year | Win rate | Avg trade | Avg hold | Excess Sharpe | Max DD | Risk factor | Time in market |
|---|---|---|---|---|---|---|---|---|
| **Slow 70 / 25 (full window)** | **0.07** | **96 %** | +5571 % | 3459 d | **+0.01** | 55.6 % | 70 | 100 % |
| Fast 65 / 35, vel 20, trail 4 (full window) | 2.71 | 46 % | +5.9 % | 42 d | −0.20 | 42.6 % | 61 | 45 % |
| **Slow 70 / 25 (last 40 %)** | **0.17** | **96 %** | +372 % | 1428 d | **+0.01** | 47.6 % | 68 | 99 % |
| Fast (last 40 %) | 2.89 | 45 % | +4.7 % | 39 d | −0.36 | 39.3 % | 60 | 45 % |
| **Slow 70 / 25 (last 30 %)** | **0.22** | **96 %** | +262 % | 1093 d | **+0.08** | 41.0 % | 63 | 97 % |
| Fast (last 30 %) | 2.94 | 46 % | +5.7 % | 39 d | −0.24 | 35.4 % | 56 | 46 % |

Read it as: trading ~40× more often buys a real drawdown cut (56 % → 43 % on the full
window, risk factor 70 → 61) and pays for it with 20–36 points of Sharpe. The per-trade
edge is genuinely positive (+5.9 % over a 42-day hold, net of costs) — there just is not
enough of it to cover being flat 55 % of the time in a universe that went up ~10×.
Loosening the trail, lowering the velocity bar, exiting sooner or later (30 / 35 / 40)
and cutting the smoothing all moved the result further from the benchmark, never closer.

The slow rule also does far less than its bands suggest: on the full 15-year window it
closed exactly one trade on **22 of the 24 tickers** (AMD and NFLX are the exceptions),
because the score's low was 23–34 on those names — it never reached the 25 exit, so the
rule was buy & hold with a filter that never fired. That is the real reason the app
"sometimes just buys and holds", and the reason a *looser* rule is the only way to keep
it invested.

Honest caveat: excess over buy & hold is ≈ 0, not positive alpha. The composite is a
drawdown filter, not a money printer — it mostly removes the whipsaw losses, and
it can sit flat through a recovery. It also has no cross-sectional edge: pitting
the 24 tickers against each other each day, the score's rank has an information
coefficient of about zero on the held-out years (the oscillator half of it is
mildly contrarian, so a very high score is not a promise of a better next quarter).
Re-run the tab on your own universe before trusting any number here.

### Every field you can change

**🎓 Train Weights tab** (`/dashboard/backtest` → Training). All of it runs
`/api/mega-train` → `trainMegaWeights`: nothing here touches your portfolio data.

| Field | What it does |
|---|---|
| **Universe** (2–40 tickers) | The tickers the search learns from; the default list is 24 (16 index/large caps + 8 volatile names). A ticker with too little history to leave a test window is skipped and named in the warnings. Results only describe the kinds of stocks you list — a large-cap-only list trains a "stay long" rule. |
| **History** (5 / 10 / 15 / 20 Y) | Daily bars per ticker. Longer history means more bars in both windows; the split is by bar count, so a 5Y run has ~380 test bars at 70/30. |
| **Train / Test split** (60/40, 70/30, 80/20) | How much of each history the search may look at. The tail is never read while choosing anything; the Test column is the only honest one. |
| **Search passes** (1 quick / 2 standard / 3 thorough) | Coordinate-descent rounds over the weight axes. More passes = more candidates = a higher luck bar (shown as *Search trials* / *luck*), so more is not automatically better. The bar is on the excess-over-buy-&-hold scale, because that is what the search maximizes. |
| **Entry band** | Starting BUY score — also the fixed entry when band search is off. A position opens on the next bar's open once the composite reaches it. Raise it to wait for stronger readings. |
| **Exit band** | Starting SELL score. A position closes only on a score strictly below it (exactly on it = hold). Raise it to leave sooner; the research above says every raise above 25 costs more return than it saves in drawdown. |
| **Min trades** | Per-ticker floor for a ticker to count in the objective. A candidate that barely trades returns −Infinity unless at least half the universe clears the floor. |
| **Commission bps** | Per-side commission in basis points, applied to every fill. |
| **Slippage bps** | Per-side slippage in basis points, applied to every fill (worse price both ways). |
| **Search the BUY/SELL bands too** | Runs the entry × exit grid with the weights frozen, after each weight pass. Turn it off to hold the band inputs fixed and train weights only. |
| **Let catalogue indicators join the search** | The ~20 optional indicators normally sit at weight 0. When on they become searchable axes, so the run can pull e.g. SuperTrend, ADX or distance-above-52-week-low into the composite. |
| **Train weights** | Runs the whole thing. First run builds ~50 indicator series per ticker (a minute); the series are then reused, so a second run with the same universe is seconds. |
| **Apply weights + bands to the Mega Score backtest** | Saves the trained map + bands as your Mega Score settings (the Mega Indicator page and the backtest both read it). It does not change the app's shipped defaults. |
| **Download weights CSV** / **Copy weight map** | The same result as a file / as JSON for pasting into `DEFAULT_WEIGHTS`. |

**Mega Indicator page** (`/dashboard/mega-indicator`) — the score itself:

| Field | What it does |
|---|---|
| Ticker | Which symbol's score to compute and display. |
| Preset buttons | `Balanced` (the shipped map), `Everything` (all weight 1), `Trend`, `Momentum`, `Mean Reversion`, `Smooth Trends`. Picking one replaces your weight map; editing any weight switches the saved preset to `Custom`. |
| Weight slider (0–10) / box (0–20) | Per-indicator weight. Only relative shares matter — the composite divides by the weight it actually summed, so `2 / 2 / 6` scores the same as `20 / 20 / 60`. `0` excludes the indicator. |
| `%` beside each weight | That indicator's share of the composite after renormalising. |
| ＋ Add Indicator | Opens the catalogue (~20 extra indicators) with per-ticker suggestions. Catalogue indicators start at weight 0 and join only when you add them. |
| Right-click an indicator → **Direction** | `Higher is better`, `Lower is better`, or `Healthy band (peak in the middle)`. Changing it re-scores the indicator and marks it `custom`. |
| Right-click → **thresholds** | The two numbers that map the raw value to 0–100: `Bad (→0)` / `Good (→100)` for higher-is-better, the reverse for lower, or `Band low` / `Band high` for a band. Inside a band the score runs 60–100 with 100 at the middle; outside it falls to 0 at 75 % of a band-width past the edge. A reversed pair (`low > high`) is rejected and scores 50. |
| Right-click → **Reset formula** | Drops your direction/threshold override for that indicator. |
| ＋ New indicator | A custom indicator: **name**, **formula** (daily OHLCV + the listed functions; click to insert), **what scores better** (direction), **thresholds**, optional **description**. Saved on this device and scored exactly like a built-in. |
| History + overlay picker | Bars used for the chart, and which indicator's own score the overlay plots under the composite. |
| BUY/SELL bands (backtest page) | The same pair the Training tab writes, editable per run; `Reset` returns to the shipped 70 / 25. |

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
    mega-calibration.ts   # Weight + band training (train/test split, coordinate descent)
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
