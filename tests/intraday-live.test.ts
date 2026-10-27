// Intraday (day-trading) research harness — REAL market data, opt-in, needs a key.
//
//   ALPACA_API_KEY_ID=... ALPACA_API_SECRET_KEY=... INTRADAY_LIVE=1 \
//     npx vitest run tests/intraday-live.test.ts --silent=false
//
// Why it exists: every other backtest in this app runs on DAILY bars, so
// "would we make more if we day traded?" cannot be answered there at all. This
// runs the SAME rules on 5-minute bars with the SAME cost model (2 bps
// commission + 2 bps slippage per side), the SAME risk metrics, and with the
// position forced flat at each session's last bar — no overnight risk, which is
// what day trading actually means.
//
// What it compares, per ticker, over one identical window:
//   • the fast rule day-traded (flat by the bell) on 5-minute bars
//   • the SAME fast rule on daily bars (no overnight restriction)
//   • the slow 70/25 rule day-traded on the same 5-minute bars
//   • daily buy & hold as the benchmark everything is measured against
//
// Free Alpaca keys cover 7+ years of minute bars but serve only the IEX feed
// (~2-3 % of consolidated volume) — the run prints which feed it used, because
// a thin tape is optimistic for fills and pessimistic for signals. sip needs a
// paid plan; see src/lib/intraday-data.ts.
//
// Optional env: INTRADAY_TICKERS, INTRADAY_YEARS (default 2), INTRADAY_TF
// (5Min default; 1Min/15Min/1Hour), INTRADAY_FEED (iex default).

import { describe, it, expect } from "vitest";
import { getDailyBars, type Bar } from "../src/lib/market-data";
import {
  getIntradayBars,
  hasIntradayData,
  alpacaCredentials,
  TIMEFRAME_MINUTES,
  type IntradayTimeframe,
} from "../src/lib/intraday-data";
import { simulateCore, resolveCosts, type BacktestConfig, type BacktestOutput } from "../src/lib/backtest-engine";
import { getStrategy, megaRegimePosition, megaVelocityPosition, type StrategyDef } from "../src/lib/strategies";
import { computeMegaScoreSeries } from "../src/lib/mega-score";
import { sma } from "../src/lib/ta";

const LIVE = process.env.INTRADAY_LIVE === "1" && hasIntradayData();
const TICKERS = (process.env.INTRADAY_TICKERS ?? "SPY,QQQ,AAPL,NVDA,TSLA,AMD").split(/[\s,;]+/).filter(Boolean);
const YEARS = Number(process.env.INTRADAY_YEARS ?? 2);
const TF = (process.env.INTRADAY_TF ?? "5Min") as IntradayTimeframe;
const FEED = (process.env.INTRADAY_FEED === "sip" ? "sip" : "iex") as "iex" | "sip";
const META = { symbol: "X", name: "X", currency: "USD", exchange: "alpaca" };

/** The shipped fast defaults (lib/strategies.ts, measured on daily bars). */
const FAST = { entry: 65, exit: 35, smooth: 5, velWindow: 10, velMin: 20, trailAtr: 4, atrPeriod: 14 };
const SLOW = { entry: 70, exit: 25, smooth: 5 };

const stubPositions = (positions: number[]): StrategyDef => ({
  id: "zz_intraday",
  name: "zz",
  description: "",
  params: [
    { key: "trailAtr", label: "", default: 0 },
    { key: "atrPeriod", label: "", default: 14 },
  ],
  minBars: 2,
  generate: () => positions,
});

function run(
  bars: Bar[],
  positions: number[],
  trailAtr: number,
  flatAtSessionEnd = false,
  strategyId = "zz_intraday",
  strategy: StrategyDef = stubPositions(positions),
  initialCapital = 100000
): BacktestOutput {
  const config: BacktestConfig = {
    symbol: "X",
    strategyId,
    initialCapital,
    years: YEARS,
    commissionBps: 2,
    slippageBps: 2,
    positionPct: 100,
    params: { ...FAST, trailAtr, atrPeriod: FAST.atrPeriod },
    flatAtSessionEnd,
  };
  return simulateCore(bars, META, "cache", strategy, resolveCosts(config), config, false);
}

const positionsFor = (score: number[], smooth: number, kind: "fast" | "slow") => {
  const s = smooth > 1 ? sma(score, smooth) : score;
  return kind === "fast"
    ? megaVelocityPosition(s, FAST.entry, FAST.exit, FAST.velWindow, FAST.velMin)
    : megaRegimePosition(s, SLOW.entry, SLOW.exit);
};

const series = (bars: Bar[]) =>
  computeMegaScoreSeries({
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume),
  }).score;

interface Row {
  trades: number;
  years: number;
  winRate: number;
  avgTrade: number;
  avgHoldBars: number;
  excessSharpe: number;
  maxDD: number;
  riskFactor: number;
  timeInMarket: number;
}

function rowOf(out: BacktestOutput, benchSharpe: number, years: number): Row {
  const s = out.summary;
  return {
    trades: s.totalTrades,
    years,
    winRate: s.winRate,
    avgTrade: s.avgTradeReturnPct,
    avgHoldBars: s.avgBarsHeld,
    excessSharpe: s.sharpe - benchSharpe,
    maxDD: s.maxDrawdownPct,
    riskFactor: s.risk.riskFactor,
    timeInMarket: s.timeInMarketPct,
  };
}

/** Same aggregation the daily research used: trade-weighted rates, mean ratios. */
function combine(rows: Row[]): Row {
  const trades = rows.reduce((a, r) => a + r.trades, 0);
  const w = (pick: (r: Row) => number) => (trades ? rows.reduce((a, r) => a + pick(r) * r.trades, 0) / trades : 0);
  const mean = (pick: (r: Row) => number) => (rows.length ? rows.reduce((a, r) => a + pick(r), 0) / rows.length : 0);
  return {
    trades,
    years: mean((r) => r.years),
    winRate: w((r) => r.winRate),
    avgTrade: w((r) => r.avgTrade),
    avgHoldBars: w((r) => r.avgHoldBars),
    excessSharpe: mean((r) => r.excessSharpe),
    maxDD: mean((r) => r.maxDD),
    riskFactor: mean((r) => r.riskFactor),
    timeInMarket: mean((r) => r.timeInMarket),
  };
}

describe.runIf(LIVE)("intraday (day trading) vs daily, same rules and same costs", () => {
  it("measures both frequencies on one window and prints per-trade edge", async () => {
    const creds = alpacaCredentials();
    const w = (s: string, n: number) => s.padEnd(n);
    const num = (v: number, d = 1) => v.toFixed(d);

    console.log(
      `\nAlpaca keys via ${creds?.from} · feed=${FEED} · timeframe=${TF} (${TIMEFRAME_MINUTES[TF]} min) · ` +
        `${YEARS}y · ${TICKERS.length} tickers · 2 bps commission + 2 bps slippage per side`
    );

    const start = new Date(Date.now() - YEARS * 365.25 * 86400_000).toISOString().slice(0, 10);
    const byRow: Record<string, Row[]> = {
      "fast 5-min, flat by the bell": [],
      "fast 5-min, holds overnight": [],
      "slow 70/25, 5-min, flat by the bell": [],
      "fast daily (same signal)": [],
      "buy & hold daily (benchmark)": [],
    };

    for (const ticker of TICKERS) {
      let intra: Bar[];
      let daily: Bar[];
      try {
        const got = await getIntradayBars(ticker, { timeframe: TF, start, feed: FEED });
        intra = got.bars;
        console.log(
          `\n${ticker}: ${intra.length} ${TF} bars (${got.source === "cache" ? "local cache" : "fetched"})` +
            ` · ${intra[0]?.date.slice(0, 10)} → ${intra[intra.length - 1]?.date.slice(0, 10)}`
        );
        const d = await getDailyBars(ticker, YEARS + 1);
        daily = d.bars.filter((b) => b.date >= intra[0].date.slice(0, 10));
      } catch (e) {
        console.log(`  skip ${ticker}: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      if (intra.length < 500 || daily.length < 60) {
        console.log(`  skip ${ticker}: not enough bars (${intra.length} intraday / ${daily.length} daily)`);
        continue;
      }

      const years = intra.length / (252 * (390 / TIMEFRAME_MINUTES[TF]));
      const buyHold = run(daily, daily.map(() => 1), 0, false, "buy_hold", getStrategy("buy_hold") as StrategyDef);
      const benchSharpe = buyHold.summary.sharpe;

      const intraScore = series(intra);
      const fastIntra = run(intra, positionsFor(intraScore, FAST.smooth, "fast"), FAST.trailAtr, true);
      const fastOvernight = run(intra, positionsFor(intraScore, FAST.smooth, "fast"), FAST.trailAtr, false);
      const slowIntra = run(intra, positionsFor(intraScore, SLOW.smooth, "slow"), 0, true);

      const dailyScore = series(daily);
      const fastDaily = run(daily, positionsFor(dailyScore, FAST.smooth, "fast"), FAST.trailAtr, false);

      byRow["fast 5-min, flat by the bell"].push(rowOf(fastIntra, benchSharpe, years));
      byRow["fast 5-min, holds overnight"].push(rowOf(fastOvernight, benchSharpe, years));
      byRow["slow 70/25, 5-min, flat by the bell"].push(rowOf(slowIntra, benchSharpe, years));
      byRow["fast daily (same signal)"].push(rowOf(fastDaily, benchSharpe, daily.length / 252));
      byRow["buy & hold daily (benchmark)"].push(rowOf(buyHold, benchSharpe, daily.length / 252));

      console.log(
        `  buy&hold Sharpe ${num(benchSharpe, 2)} · day trade: ${fastIntra.summary.totalTrades} trades, ` +
          `win ${num(fastIntra.summary.winRate, 0)}%, avg ${num(fastIntra.summary.avgTradeReturnPct, 3)}%, ` +
          `hold ${num(fastIntra.summary.avgBarsHeld, 0)} bars, xSharpe ${num(fastIntra.summary.sharpe - benchSharpe, 2)}`
      );
    }

    console.log("\n=== aggregate (mean over tickers; rates trade-weighted) ===");
    console.log(w("rule", 36) + "trades  tr/tkr-yr  win%   avgTr     hold      xSharpe  ret%     maxDD%  riskF  inMkt%");
    for (const [label, rows] of Object.entries(byRow)) {
      const c = combine(rows);
      if (!rows.length) continue;
      const perTickerYear = c.trades / (c.years * rows.length);
      console.log(
        w(label, 36) +
          String(c.trades).padStart(6) +
          num(perTickerYear, 2).padStart(11) +
          num(c.winRate, 0).padStart(6) +
          `${num(c.avgTrade, 3)}%`.padStart(9) +
          `${num(c.avgHoldBars, 0)} bars`.padStart(11) +
          num(c.excessSharpe, 2).padStart(8) +
          num(c.maxDD, 1).padStart(8) +
          num(c.riskFactor, 0).padStart(7) +
          num(c.timeInMarket, 0).padStart(8)
      );
    }

    // The number that decides it: what the trading itself costs per year, at the
    // app's own 2+2 bps, before any losing trade.
    const dayRows = combine(byRow["fast 5-min, flat by the bell"]);
    const roundTripsPerYear = dayRows.trades / (dayRows.years * Math.max(1, TICKERS.length));
    console.log(
      `\ncost drag: ${num(roundTripsPerYear, 0)} round trips/ticker/year × 4 bps = ` +
        `${num(roundTripsPerYear * 0.04, 1)} % of notional per year at 2+2 bps (real spreads and impact are worse).`
    );
    console.log(
      "Read the xSharpe column against 0: buy & hold is the hurdle. Anything negative did not pay for its own costs.\n"
    );

    expect(byRow["fast 5-min, flat by the bell"].length).toBeGreaterThan(0);
  }, 1_800_000);
});
