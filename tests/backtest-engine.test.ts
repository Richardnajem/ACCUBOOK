import { describe, it, expect } from "vitest";
import {
  simulateCore,
  resolveCosts,
  applyTradeFloor,
  type BacktestConfig,
  type ResolvedCosts,
} from "../src/lib/backtest-engine";
import type { Bar } from "../src/lib/market-data";
import { defaultParams, getStrategy, megaRegimePosition, megaVelocityPosition, type StrategyDef } from "../src/lib/strategies";
import { computeMegaScoreSeries } from "../src/lib/mega-score";
import { resampleBars } from "../src/lib/bar-resample";
import { ALL_SPECS, MEGA_BASELINE, actionFor, defaultWeights } from "../src/lib/mega-indicator";
import { sma } from "../src/lib/ta";

// ─── Helpers ────────────────────────────────────────────────────
const META = { symbol: "TEST", name: "Test Corp", currency: "USD", exchange: "SYNTH" };
const STRATEGY = getStrategy("buy_hold") as StrategyDef;

function makeBars(closes: number[]): Bar[] {
  // open = prior close (flat gaps), high/low bracket open & close.
  return closes.map((c, i) => {
    const open = i === 0 ? c : closes[i - 1];
    return {
      date: `2024-01-${String(i + 1).padStart(2, "0")}`,
      open,
      high: Math.max(open, c) + 0.5,
      low: Math.min(open, c) - 0.5,
      close: c,
      volume: 1_000_000,
    };
  });
}

function baseConfig(overrides: Partial<BacktestConfig> = {}): BacktestConfig {
  return {
    symbol: "TEST",
    strategyId: "buy_hold",
    initialCapital: 10_000,
    years: 1,
    commissionBps: 0,
    slippageBps: 0,
    positionPct: 100,
    params: {},
    ...overrides,
  };
}

function run(closes: number[], overrides: Partial<BacktestConfig> = {}) {
  const config = baseConfig(overrides);
  const costs = resolveCosts(config);
  return simulateCore(makeBars(closes), META, "cache", STRATEGY, costs, config, false);
}

// ─── Buy & hold accounting (exact math) ─────────────────────────
describe("simulateCore: buy & hold accounting", () => {
  it("buys at bar 1's open and tracks equity with the close", () => {
    // closes: 100 → 110. Bar 1 open = 100 (no slippage, no commission).
    const out = run([100, 105, 110]);
    expect(out.summary.finalEquity).toBeCloseTo(10_000 * (110 / 100), 6);
    expect(out.summary.totalReturnPct).toBeCloseTo(10, 6);
    expect(out.trades).toHaveLength(1);
    expect(out.trades[0].entryPrice).toBeCloseTo(100, 6);
    expect(out.trades[0].shares).toBe(100);
    expect(out.trades[0].reason).toBe("end-of-test");
  });

  it("applies commission to both sides of the trade", () => {
    // 100 bps = 1% per side. Buy at 100: shares = floor(10000 / (100*1.01)) = 99
    // gross = 9900, cash spent = 9900*1.01 = 9999 → $1 left over.
    // Exit at 110: proceeds = 99*110 = 10890, fee 108.90 → cash 1 + 10890 - 108.90
    const out = run([100, 110], { commissionBps: 100 });
    expect(out.trades[0].shares).toBe(99);
    expect(out.summary.finalEquity).toBeCloseTo(10_782.10, 2);
  });

  it("applies slippage adversely on entry; end-of-test close is marked at market", () => {
    // 100 bps = 1% slippage: buy at 101, shares = floor(10000/101) = 99 → $1 left over.
    // The final forced exit fills at the raw close (marked to market, no slippage).
    const out = run([100, 110], { slippageBps: 100 });
    expect(out.trades[0].entryPrice).toBeCloseTo(101, 6);
    expect(out.trades[0].exitPrice).toBeCloseTo(110, 6);
    expect(out.summary.finalEquity).toBeCloseTo(1 + 99 * 110, 6);
  });

  it("respects positionPct sizing (rest stays in cash)", () => {
    // 50% deployed: 5000 at price 100 → 50 shares, final = 50*110 + 5000 cash
    const out = run([100, 105, 110], { positionPct: 50 });
    expect(out.trades[0].shares).toBe(50);
    expect(out.summary.finalEquity).toBeCloseTo(50 * 110 + 5_000, 6);
  });

  it("never buys fractional shares", () => {
    const out = run([333.33, 333.33, 333.34]); // 10000/333.33 ≈ 30.0003 → 30 shares
    expect(out.trades[0].shares).toBe(30);
  });

  it("equity curve matches final equity and benchmark is indexed to 100", () => {
    const out = run([100, 120, 90, 110]);
    const last = out.equityCurve[out.equityCurve.length - 1];
    expect(last.equity).toBeCloseTo(out.summary.finalEquity, 6);
    expect(last.benchmark).toBeCloseTo(110, 6);
    expect(out.equityCurve[0].benchmark).toBeCloseTo(120 / 100 * 100, 6);
  });
});

// ─── Risk exits ─────────────────────────────────────────────────
describe("simulateCore: stop-loss and take-profit", () => {
  it("exits at the stop when price falls through it intrabar", () => {
    // Entry at open=100. Stop 10% → 90. Bar 2: low 80 touches the stop.
    const closes = [100, 100, 95];
    const bars = makeBars(closes);
    bars[2] = { ...bars[2], low: 80, close: 95, high: 96 };
    const config = baseConfig({ stopLossPct: 10 });
    const costs = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", STRATEGY, costs, config, false);
    expect(out.trades[0].reason).toBe("stop-loss");
    expect(out.trades[0].exitPrice).toBeCloseTo(90, 6);
  });

  it("fills at the (gapped) open when price gaps below the stop", () => {
    const closes = [100, 100, 70]; // bar 2 opens at 100 prior close? no: open = closes[1] = 100... 
    const bars = makeBars(closes);
    bars[2] = { ...bars[2], open: 70, high: 75, low: 65, close: 72 };
    const config = baseConfig({ stopLossPct: 10 });
    const costs = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", STRATEGY, costs, config, false);
    expect(out.trades[0].reason).toBe("stop-loss");
    expect(out.trades[0].exitPrice).toBeCloseTo(70, 6); // min(stop, open)
  });

  it("exits at the target price on take-profit", () => {
    const closes = [100, 100, 105];
    const bars = makeBars(closes);
    bars[2] = { ...bars[2], high: 120, close: 115 };
    const config = baseConfig({ takeProfitPct: 10 });
    const costs = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", STRATEGY, costs, config, false);
    expect(out.trades[0].reason).toBe("take-profit");
    expect(out.trades[0].exitPrice).toBeCloseTo(110, 6); // entry * 1.10
  });
});

// ─── Drawdown & metrics sanity ──────────────────────────────────
describe("simulateCore: metrics", () => {
  it("computes max drawdown from peak equity", () => {
    // 100 → 120 (equity 12000) → 90 (equity 9000): DD = 25%
    const out = run([100, 120, 90, 95]);
    expect(out.summary.maxDrawdownPct).toBeCloseTo(25, 6);
  });

  it("win rate & profit factor reflect the single forced exit", () => {
    const out = run([100, 110]);
    expect(out.summary.totalTrades).toBe(1);
    expect(out.summary.winRate).toBe(100);
    expect(out.summary.profitFactor).toBeGreaterThan(90); // no losses → capped at 99
  });

  it("time in market is 100% for buy & hold", () => {
    const out = run([100, 110, 120]);
    expect(out.summary.timeInMarketPct).toBeCloseTo(100, 6);
  });

  it("benchmark return matches price return", () => {
    const out = run([100, 110, 125]);
    expect(out.summary.benchmarkReturnPct).toBeCloseTo(25, 6);
  });

  it("monthly returns chain back to total return", () => {
    const bars = Array.from({ length: 70 }, (_, i) => {
      const c = 100 * (1 + i * 0.01);
      return {
        date: i < 31 ? `2024-01-${String(i + 1).padStart(2, "0")}` : `2024-03-${String(i - 30).padStart(2, "0")}`,
        open: i === 0 ? c : 100 * (1 + (i - 1) * 0.01),
        high: c + 1, low: c - 1, close: c, volume: 1e6,
      };
    });
    const config = baseConfig();
    const costs = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", STRATEGY, costs, config, false);
    expect(out.monthlyReturns.length).toBeGreaterThanOrEqual(2);
    const chained = out.monthlyReturns.reduce((acc, m) => acc * (1 + m.ret / 100), 1);
    expect(chained).toBeCloseTo(out.summary.finalEquity / 10_000, 4);
  });
});

// ─── Input validation ───────────────────────────────────────────
describe("resolveCosts", () => {
  it("clamps nonsense values into sane ranges", () => {
    const r = resolveCosts({
      ...baseConfig(),
      initialCapital: -5,
      commissionBps: 5000,
      slippageBps: -10,
      positionPct: 0,
      years: 100,
    });
    expect(r.initialCapital).toBe(1000);
    expect(r.commissionBps).toBe(100);
    expect(r.slippageBps).toBe(0);
    expect(r.positionPct).toBe(1);
    expect(r.years).toBe(30);
  });

  it("applies documented defaults", () => {
    const r = resolveCosts({ ...baseConfig(), initialCapital: 0, positionPct: undefined as unknown as number });
    expect(r.initialCapital).toBe(100000);
    expect(r.positionPct).toBe(100);
  });
});

// ─── An active strategy end-to-end ──────────────────────────────
describe("simulateCore: SMA crossover strategy", () => {
  it("produces round-trip trades with consistent accounting", () => {
    const smaCross = getStrategy("sma_cross") as StrategyDef;
    // Series engineered to cross: rally then crash
    const closes = [
      ...Array(30).fill(0).map((_, i) => 100 + i),        // up
      ...Array(30).fill(0).map((_, i) => 129 - i * 2),    // down
    ];
    const bars = makeBars(closes);
    const config = baseConfig({ strategyId: "sma_cross", params: { fast: 5, slow: 20 } });
    const costs: ResolvedCosts = resolveCosts(config);
    const out = simulateCore(bars, META, "cache", smaCross, costs, config, false);

    expect(out.summary.totalTrades).toBeGreaterThanOrEqual(1);
    // Every closed trade must have coherent math: pnl = proceeds - cost - fees
    for (const t of out.trades) {
      if (t.exitDate !== null) {
        const gross = t.shares * (t.exitPrice ?? 0);
        const cost = t.shares * t.entryPrice;
        expect(t.returnPct).toBeCloseTo(((gross - cost) / cost) * 100, 6);
      }
    }
    // Cash conservation: final equity = initial + sum of trade P&L
    const totalPnl = out.trades.reduce((s, t) => s + t.pnl, 0);
    expect(out.summary.finalEquity).toBeCloseTo(10_000 + totalPnl, 4);
  });
});

// ─── Trade limits (min / max) ──────────────────────────────────
describe("simulateCore: trade limits", () => {
  // 12 bars, long on every other bar → five round trips.
  const alternating: StrategyDef = {
    id: "test_alternating",
    name: "Alternating (test)",
    description: "test-only strategy",
    params: [],
    minBars: 0,
    generate: () => [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
  };
  const bars = makeBars(Array.from({ length: 12 }, (_, i) => 100 + i));

  const runWith = (overrides: Partial<BacktestConfig> = {}) => {
    const config = baseConfig({ strategyId: "test_alternating", ...overrides });
    return simulateCore(bars, META, "cache", alternating, resolveCosts(config), config, false);
  };

  it("caps entries at maxTrades and still closes the trade already open", () => {
    const unlimited = runWith();
    expect(unlimited.trades.length).toBeGreaterThan(2);

    const capped = runWith({ maxTrades: 2 });
    expect(capped.trades).toHaveLength(2);
    expect(capped.summary.totalTrades).toBe(2);
    for (const t of capped.trades) expect(t.exitDate).not.toBeNull();
    expect(capped.warnings.some((w) => w.includes("Entry limit reached"))).toBe(true);
    // The entries that did happen are the first two the strategy signalled.
    expect(capped.trades[0].entryDate).toBe(unlimited.trades[0].entryDate);
    expect(capped.trades[1].entryDate).toBe(unlimited.trades[1].entryDate);
  });

  it("maxTrades above the signal count changes nothing", () => {
    const unlimited = runWith();
    const capped = runWith({ maxTrades: 99 });
    expect(capped.trades).toHaveLength(unlimited.trades.length);
    expect(capped.summary.totalReturnPct).toBeCloseTo(unlimited.summary.totalReturnPct, 10);
    expect(capped.warnings.some((w) => w.includes("Entry limit"))).toBe(false);
  });

  it("minTrades warns only when the run closes fewer trades than the floor", () => {
    const short = runWith({ minTrades: 10 });
    expect(short.warnings.some((w) => w.includes("below the minimum of 10"))).toBe(true);

    const met = runWith({ minTrades: 3 });
    expect(met.warnings.some((w) => w.includes("below the minimum"))).toBe(false);
  });

  it("warns when maxTrades makes minTrades impossible to satisfy", () => {
    const out = runWith({ maxTrades: 2, minTrades: 5 });
    expect(out.warnings.some((w) => w.includes("can never be met"))).toBe(true);
  });

  it("0 means unlimited and no minimum", () => {
    const out = runWith({ maxTrades: 0, minTrades: 0 });
    expect(out.trades).toHaveLength(runWith().trades.length);
    expect(out.warnings.some((w) => w.includes("Entry limit") || w.includes("minimum"))).toBe(false);
  });

  it("reports the min-trades floor and whether the run met it", () => {
    const unlimited = runWith();
    expect(unlimited.minTrades).toBeNull();
    expect(unlimited.meetsMinTrades).toBe(true);

    const met = runWith({ minTrades: 2 });
    expect(met.minTrades).toBe(2);
    expect(met.meetsMinTrades).toBe(true);

    const missed = runWith({ minTrades: 50 });
    expect(missed.minTrades).toBe(50);
    expect(missed.summary.totalTrades).toBeLessThan(50);
    expect(missed.meetsMinTrades).toBe(false);
  });
});

// ─── Min-trades floor shared by the optimizer and walk-forward ──
describe("applyTradeFloor", () => {
  const candidates = [
    { name: "two", totalTrades: 2 },
    { name: "eight", totalTrades: 8 },
    { name: "twenty", totalTrades: 20 },
  ];
  const tradesOf = (c: { totalTrades: number }) => c.totalTrades;

  it("drops every candidate below the floor from the ranking pool", () => {
    const out = applyTradeFloor(candidates, 8, tradesOf);
    expect(out.pool.map((c) => c.name)).toEqual(["eight", "twenty"]);
    expect(out.belowFloor).toBe(1);
    expect(out.usedFallback).toBe(false);
    expect(out.warning).toContain("1 of 3 candidates");
    expect(out.warning).toContain("8 trades");
  });

  it("keeps everything when no floor is set", () => {
    for (const floor of [0, undefined, null]) {
      const out = applyTradeFloor(candidates, floor, tradesOf);
      expect(out.pool).toHaveLength(3);
      expect(out.belowFloor).toBe(0);
      expect(out.usedFallback).toBe(false);
      expect(out.warning).toBeNull();
    }
  });

  it("is silent when every candidate clears the floor", () => {
    const out = applyTradeFloor(candidates, 2, tradesOf);
    expect(out.pool).toHaveLength(3);
    expect(out.warning).toBeNull();
  });

  it("falls back to all candidates, and says so, when nothing clears the floor", () => {
    const out = applyTradeFloor(candidates, 50, tradesOf);
    expect(out.pool).toHaveLength(3);
    expect(out.belowFloor).toBe(3);
    expect(out.usedFallback).toBe(true);
    expect(out.warning).toContain("ignore your minimum-trades floor");
  });
});

// ─── Mega Score strategy: configurable base buy/sell score ──────
describe("Mega Score strategy base score", () => {
  const strategy = getStrategy("mega_score") as StrategyDef;

  it("starts at the Mega Indicator baseline bands", () => {
    // Pinned to the calibrated pair (see MEGA_BASELINE): 70 / 25 since the
    // Oct 2026 training run. The strategy must never carry its own copy.
    const defaults = defaultParams(strategy);
    expect(defaults.entry).toBe(MEGA_BASELINE.entry);
    expect(defaults.exit).toBe(MEGA_BASELINE.exit);
    expect(defaults.entry).toBe(70);
    expect(defaults.exit).toBe(25);
    expect(strategy.validate!(defaults)).toBe(true);
  });

  it("rejects a buy threshold below the sell threshold", () => {
    expect(strategy.validate!({ entry: 70, exit: 30 })).toBe(true);
    expect(strategy.validate!({ entry: 40, exit: 50 })).toBe(false);
  });

  it("trades the level the user picks", () => {
    // A flat score series cannot be produced here, but the strategy's signal
    // must still be a 0/1 position array of the same length for any valid band.
    const closes = Array.from({ length: 260 }, (_, i) => 100 + Math.sin(i / 9) * 8);
    const bars = makeBars(closes);
    const high = bars.map((b) => b.high);
    const low = bars.map((b) => b.low);
    const pos = strategy.generate({
      open: bars.map((b) => b.open), high, low, close: closes,
      volume: bars.map((b) => b.volume),
      params: { entry: 65, exit: 35, smooth: 1 },
    });
    expect(pos).toHaveLength(closes.length);
    for (const p of pos) expect([0, 1]).toContain(p);
  });
});

// ─── Mega Score Regime: the thresholds really gate the signals ──
describe("Mega Score Regime signal semantics", () => {
  const strategy = getStrategy("mega_score") as StrategyDef;
  const closes = Array.from({ length: 420 }, (_, i) => 100 + i * 0.06 + Math.sin(i / 7) * 9);
  const bars = makeBars(closes);
  const ctx = {
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: closes,
    volume: bars.map((b) => b.volume),
  };
  const score = computeMegaScoreSeries(ctx).score;
  const positions = (entry: number, exit: number, smooth = 5) =>
    strategy.generate({ ...ctx, params: { entry, exit, smooth } });
  const smoothed = sma(score, 5);

  it("only enters at or above the buy level and exits strictly below the sell level", () => {
    const pos = positions(65, 35);
    let entries = 0;
    let exits = 0;
    for (let i = 0; i < pos.length; i++) {
      const prev = i === 0 ? 0 : pos[i - 1];
      if (pos[i] === 1 && prev === 0) {
        expect(smoothed[i], `entered at bar ${i} on score ${smoothed[i]}`).toBeGreaterThanOrEqual(65);
        entries++;
      }
      if (pos[i] === 0 && prev === 1) {
        expect(smoothed[i], `exited at bar ${i} on score ${smoothed[i]}`).toBeLessThan(35);
        exits++;
      }
      // Holding means the score has not reached the sell level.
      if (pos[i] === 1) expect(smoothed[i]).toBeGreaterThan(35);
    }
    expect(entries).toBeGreaterThan(0);
    expect(exits).toBeGreaterThan(0);
  });

  it("a higher buy level can only enter later, never earlier", () => {
    const loose = positions(55, 35);
    const strict = positions(80, 35);
    for (let i = 0; i < loose.length; i++) {
      expect(strict[i], `bar ${i}`).toBeLessThanOrEqual(loose[i]);
    }
    expect(strict.reduce((s, v) => s + v, 0)).toBeLessThan(loose.reduce((s, v) => s + v, 0));
  });

  it("a higher sell level can only leave earlier, never later", () => {
    const patient = positions(65, 20);
    const jumpy = positions(65, 50);
    for (let i = 0; i < patient.length; i++) {
      expect(jumpy[i], `bar ${i}`).toBeLessThanOrEqual(patient[i]);
    }
    expect(jumpy.reduce((s, v) => s + v, 0)).toBeLessThan(patient.reduce((s, v) => s + v, 0));
  });

  it("smoothing is trailing: the position on a bar never depends on later bars", () => {
    // Recompute the signal through bar k with the same prefix of the score
    // series. A trailing SMA can only use values at or before k.
    const full = positions(65, 35);
    const k = 300;
    const prefixScore = score.slice(0, k + 1);
    const prefixSmooth = sma(prefixScore, 5);
    let inPos = false;
    for (let i = 0; i <= k; i++) {
      if (Number.isFinite(prefixSmooth[i])) {
        if (!inPos && prefixSmooth[i] >= 65) inPos = true;
        else if (inPos && prefixSmooth[i] <= 35) inPos = false;
      }
      expect(full[i], `bar ${i}`).toBe(inPos ? 1 : 0);
    }
  });
});

// ─── Trade log: exact days + the Mega Score on entry/exit ───────
describe("trade log annotations", () => {
  const closes = Array.from({ length: 420 }, (_, i) => 100 + i * 0.06 + Math.sin(i / 7) * 9);
  const bars = makeBars(closes).map((b, i) => ({
    ...b,
    // makeBars reuses a January day number; keep dates unique for the lookup below.
    date: `2023-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
  const strategy = getStrategy("mega_score") as StrategyDef;
  const config = baseConfig({ strategyId: "mega_score", params: { entry: 65, exit: 35, smooth: 5 } });
  const costs = resolveCosts(config);
  const out = simulateCore(bars, META, "cache", strategy, costs, config, true);
  const dateIndex = new Map(bars.map((b, i) => [b.date, i]));
  const mega = computeMegaScoreSeries({
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: closes,
    volume: bars.map((b) => b.volume),
  }).score;
  // The strategy trades the 5-day smoothed score, so that is the reading the
  // log must report at the signal bar.
  const smooth5 = sma(mega, 5);

  it("produces trades to annotate", () => {
    expect(out.trades.length).toBeGreaterThan(0);
  });

  it("records the score that triggered each fill and the fill day's own score", () => {
    for (const t of out.trades) {
      const ei = dateIndex.get(t.entryDate);
      expect(ei, `entry date ${t.entryDate} is a real bar`).toBeTypeOf("number");
      // The trigger is the previous close (the signal bar), which is what the
      // buy band is compared against; the fill-day close is reported beside it.
      expect(t.entryScore).toBeCloseTo(Math.round(smooth5[ei! - 1] * 10) / 10, 6);
      expect(t.entryScore!).toBeGreaterThanOrEqual(65);
      expect(t.entryFillScore).toBeCloseTo(Math.round(mega[ei!] * 10) / 10, 6);

      if (t.exitDate) {
        const xi = dateIndex.get(t.exitDate);
        expect(xi, `exit date ${t.exitDate} is a real bar`).toBeTypeOf("number");
        expect(t.exitFillScore).toBeCloseTo(Math.round(mega[xi!] * 10) / 10, 6);
        if (t.reason === "signal") {
          expect(t.exitScore).toBeCloseTo(Math.round(smooth5[xi! - 1] * 10) / 10, 6);
          expect(t.exitScore!).toBeLessThanOrEqual(35);
        } else if (t.reason === "end-of-test") {
          // Nothing scored the close-out, so there is no signal reading.
          expect(t.exitScore ?? null).toBeNull();
        } else {
          // Stops/targets fire intra-bar: the exit day itself is the reading.
          expect(t.exitScore).toBeCloseTo(Math.round(mega[xi!] * 10) / 10, 6);
        }
      } else {
        expect(t.exitScore ?? null).toBeNull();
        expect(t.exitFillScore ?? null).toBeNull();
      }
    }
  });

  it("keeps the log date and the chart's score series in step", () => {
    const plotted = new Map(out.priceSeries.map((p) => [p.date, p.mega]));
    for (const t of out.trades) expect(plotted.get(t.entryDate)).toBeCloseTo(t.entryFillScore!, 6);
  });

  it("leaves the scores off when the score series is skipped (bulk runs)", () => {
    const bulk = simulateCore(bars, META, "cache", strategy, costs, config, false);
    for (const t of bulk.trades) expect(t.entryScore ?? t.entryFillScore ?? null).toBeNull();
  });
});

describe("trade log: stop-loss re-entries are flagged", () => {
  const closes = Array.from({ length: 420 }, (_, i) => 100 + i * 0.06 + Math.sin(i / 7) * 9);
  const bars = makeBars(closes).map((b, i) => ({
    ...b,
    date: `2023-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
  const strategy = getStrategy("mega_score") as StrategyDef;
  // A tight stop forces intra-bar exits while the regime is still long; the bar
  // after each one re-buys without a fresh score crossing.
  const config = baseConfig({
    strategyId: "mega_score",
    params: { entry: 65, exit: 35, smooth: 5 },
    stopLossPct: 3,
  });
  const out = simulateCore(bars, META, "cache", strategy, resolveCosts(config), config, true);

  it("marks the entry after a stop as a re-entry", () => {
    const stops = out.trades.filter((t) => t.reason === "stop-loss");
    expect(stops.length).toBeGreaterThan(0);
    const reentries = out.trades.filter((t) => t.reentry);
    expect(reentries.length).toBeGreaterThan(0);
    // Every re-entry is on the bar right after a stop, and it is not the first.
    for (const t of reentries) {
      expect(t.id).toBeGreaterThan(1);
      const prev = out.trades.find((p) => p.id === t.id - 1)!;
      expect(prev.reason).toBe("stop-loss");
    }
  });

  it("still reports a real score on each of them", () => {
    for (const t of out.trades.filter((x) => x.reentry)) {
      expect(t.entryScore == null).toBe(false);
      expect(t.entryFillScore == null).toBe(false);
    }
  });
});

// ─── Backtesting follows the Mega Indicator baseline ────────────
describe("Mega Score baseline in backtests", () => {
  const closes = Array.from({ length: 420 }, (_, i) => 100 + i * 0.06 + Math.sin(i / 7) * 9);
  const bars = makeBars(closes).map((b, i) => ({
    ...b,
    date: `2023-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
  }));
  const strategy = getStrategy("mega_score") as StrategyDef;

  it("runs with no params on the calibrated baseline", () => {
    // This is exactly what the API does when the client sends params: {}.
    const config = baseConfig({ strategyId: "mega_score" });
    const out = simulateCore(bars, META, "cache", strategy, resolveCosts(config), config, true);
    const used = defaultParams(strategy);
    expect(used.entry).toBe(MEGA_BASELINE.entry);
    expect(used.exit).toBe(MEGA_BASELINE.exit);
    // The payload reports the bands it really used, not an empty params object.
    expect(out.config.params?.entry).toBe(MEGA_BASELINE.entry);
    expect(out.config.params?.exit).toBe(MEGA_BASELINE.exit);
    // Signal readings (the number the bands check) obey those defaults; only
    // stop-loss re-entries can sit outside, and this run has no stop set.
    for (const t of out.trades) {
      if (t.id === 1) expect(t.entryScore!).toBeGreaterThanOrEqual(MEGA_BASELINE.entry);
      if (t.reason === "signal") expect(t.exitScore!).toBeLessThan(MEGA_BASELINE.exit);
    }
    expect(out.trades.length).toBeGreaterThan(0);
  });

  it("describes the default weights as the balanced baseline, not equal weights", () => {
    const config = baseConfig({ strategyId: "mega_score" });
    const out = simulateCore(bars, META, "cache", strategy, resolveCosts(config), config, true);
    expect(out.megaScoreDescription).toMatch(/Balanced baseline/);
    expect(out.megaScoreDescription).not.toMatch(/equally weighted/i);
  });

  it("names the Mega Indicator preset a run borrowed its weights from", () => {
    const balanced = defaultWeights(ALL_SPECS);
    const trend = { ...balanced, "ta-trend-50-200": 4, "ta-kernel-slope": 4 };
    const config = baseConfig({ strategyId: "mega_score", megaWeights: trend });
    const out = simulateCore(bars, META, "cache", strategy, resolveCosts(config), config, true);
    expect(out.megaScoreDescription).toMatch(/Trend preset/);
  });

  it("still names the Everything preset when the built-ins are equal-weighted", () => {
    const everything = Object.fromEntries(ALL_SPECS.map((s) => [s.id, s.optional ? 0 : 1]));
    const config = baseConfig({ strategyId: "mega_score", megaWeights: everything });
    const out = simulateCore(bars, META, "cache", strategy, resolveCosts(config), config, true);
    expect(out.megaScoreDescription).toMatch(/Everything preset/);
  });
});

// ─── Baseline strictness at the exact boundary ──────────────────
describe("Mega Score regime boundary (baseline strictness)", () => {
  it("buys at exactly the entry level, never a hair below", () => {
    expect(megaRegimePosition([64.99, 65], 65, 35)).toEqual([0, 1]);
    expect(megaRegimePosition([64.99, 64.99], 65, 35)).toEqual([0, 0]);
  });

  it("holds a position sitting exactly on the sell level, sells only below it", () => {
    // Buy at 65, drift to exactly 35 (still HOLD per the baseline badge), then
    // 34.9 closes the trade and 65 re-opens it.
    expect(megaRegimePosition([65, 50, 35, 35, 34.9, 65], 65, 35)).toEqual([1, 1, 1, 1, 0, 1]);
  });

  it("does not open a position inside the no-trade band", () => {
    expect(megaRegimePosition([35, 50, 64.9, 65], 65, 35)).toEqual([0, 0, 0, 1]);
  });

  it("stays flat until the score series is available", () => {
    expect(megaRegimePosition([NaN, NaN, 70], 65, 35)).toEqual([0, 0, 1]);
  });

  it("matches the Mega Indicator baseline badge at the calibrated bands", () => {
    // The badge itself is tested in indicator-catalog.test.ts; this ties the
    // backtest rule to it so the two can never drift apart.
    expect(actionFor(MEGA_BASELINE.entry).key).toBe("buy");
    expect(actionFor(MEGA_BASELINE.exit).key).toBe("hold");
    expect(actionFor(MEGA_BASELINE.exit - 0.1).key).toBe("sell");
    expect(megaRegimePosition([MEGA_BASELINE.entry], MEGA_BASELINE.entry, MEGA_BASELINE.exit)).toEqual([1]);
    // Not long yet and below the entry: no position is opened at the exit.
    expect(megaRegimePosition([MEGA_BASELINE.exit], MEGA_BASELINE.entry, MEGA_BASELINE.exit)).toEqual([0]);
    expect(megaRegimePosition([40, MEGA_BASELINE.exit], MEGA_BASELINE.entry, MEGA_BASELINE.exit)).toEqual([0, 0]);
  });
});

// ─── Fast Mega Score rule (velocity) ────────────────────────────
describe("megaVelocityPosition (mega_score_fast rule)", () => {
  it("does not buy a high score that is not rising", () => {
    // 80 all the way: above the entry band, but velocity is 0.
    expect(megaVelocityPosition(new Array(8).fill(80), 60, 50, 2, 1)).toEqual(new Array(8).fill(0));
  });

  it("buys on a rising score and leaves when velocity rolls over", () => {
    const s = [50, 50, 55, 60, 65, 70, 72, 72, 72, 70, 68, 66, 64, 62, 60, 58];
    const pos = megaVelocityPosition(s, 60, 50, 2, 1);
    expect(pos[3]).toBe(1); // 60, +10 over two days
    expect(pos[7]).toBe(1); // still high, velocity 0 — a stall is not a sell
    expect(pos[9]).toBe(0); // 72 -> 70 = -2 over two days
    expect(pos[15]).toBe(0);
  });

  it("stays flat until the velocity window has enough history", () => {
    const pos = megaVelocityPosition([90, 95], 60, 50, 5, 1);
    expect(pos).toEqual([0, 0]);
  });
});

// ─── ATR trailing stop ─────────────────────────────────────────
describe("ATR trailing stop (the fast rule's risk exit)", () => {
  const alwaysLong: StrategyDef = {
    id: "synthetic_trail",
    name: "Synthetic always-long",
    description: "",
    params: [
      { key: "trailAtr", label: "trail", default: 1 },
      { key: "atrPeriod", label: "atr", default: 5 },
    ],
    minBars: 2,
    generate: ({ close }) => close.map(() => 1),
  };
  const runTrail = (closes: number[], params: Record<string, number>) => {
    const config = baseConfig({ strategyId: "synthetic_trail", params });
    return simulateCore(makeBars(closes), META, "cache", alwaysLong, resolveCosts(config), config, false);
  };
  // 21 bars climbing 100 -> 120, then one bar that opens at 120 and closes at
  // 110: the trail level sits around 118 and is pierced inside the bar.
  const climbThenDrop = [...Array.from({ length: 21 }, (_, i) => 100 + i), 110];

  it("exits at a level below the highest close when price falls through the trail", () => {
    const out = runTrail(climbThenDrop, { trailAtr: 1, atrPeriod: 5 });
    const stopped = out.trades.filter((t) => t.reason === "trailing-stop");
    expect(stopped.length).toBe(1);
    expect(stopped[0].exitPrice).toBeLessThan(120); // high-water was 120
    expect(stopped[0].exitPrice).toBeGreaterThan(105);
  });

  it("does not fire on a steady climb", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const out = runTrail(closes, { trailAtr: 3, atrPeriod: 14 });
    expect(out.trades.some((t) => t.reason === "trailing-stop")).toBe(false);
  });

  it("is disabled when the multiple is 0", () => {
    const out = runTrail(climbThenDrop, { trailAtr: 0, atrPeriod: 5 });
    expect(out.trades.some((t) => t.reason === "trailing-stop")).toBe(false);
  });
});

// ─── Intraday cadence + day-trading mode ───────────────────────
/** 5-minute bars for `sessions` sessions of `barsPerSession` bars each. */
function sessionBars(sessions: string[], barsPerSession: number, stepPct = 0.1): Bar[] {
  const out: Bar[] = [];
  let price = 100;
  for (const day of sessions) {
    for (let i = 0; i < barsPerSession; i++) {
      const mins = i * 5;
      const hh = String(13 + Math.floor((30 + mins) / 60)).padStart(2, "0");
      const mm = String((30 + mins) % 60).padStart(2, "0");
      const open = price;
      const close = price * (1 + stepPct / 100);
      out.push({
        date: `${day}T${hh}:${mm}:00Z`,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 1000,
      });
      price = close;
    }
  }
  return out;
}

const alwaysLongIntraday: StrategyDef = {
  id: "synthetic_intraday",
  name: "Always long",
  description: "",
  params: [],
  minBars: 2,
  generate: ({ close }) => close.map(() => 1),
};

function runIntraday(bars: Bar[], overrides: Partial<BacktestConfig> = {}) {
  const config = baseConfig({ strategyId: "synthetic_intraday", ...overrides });
  return simulateCore(bars, META, "cache", alwaysLongIntraday, resolveCosts(config), config, false);
}

describe("intraday runs", () => {
  const bars = sessionBars(["2024-01-02", "2024-01-03", "2024-01-04"], 8);

  it("derives the bar cadence and annualizes on it, not on 252", () => {
    const out = runIntraday(bars);
    expect(out.summary.barMinutes).toBe(5);
    // 78 five-minute bars in a 6.5-hour session × 252 sessions
    expect(out.summary.periodsPerYear).toBe(252 * 78);
  });

  it("leaves daily bars on 252 periods a year", () => {
    const out = run([100, 101, 102, 103]);
    expect(out.summary.barMinutes).toBe(1440);
    expect(out.summary.periodsPerYear).toBe(252);
  });

  it("day-trading mode closes every position at the session's last bar", () => {
    const out = runIntraday(bars, { flatAtSessionEnd: true });
    expect(out.summary.totalTrades).toBe(3);
    expect(out.trades.every((t) => t.reason === "session-close")).toBe(true);
    // no trade carries a position into the next session
    for (const t of out.trades) {
      expect(t.exitDate!.slice(0, 10)).toBe(t.entryDate.slice(0, 10));
    }
    // and it is genuinely flatter than the always-in variant
    expect(out.summary.timeInMarketPct).toBeLessThan(100);
  });

  it("without day-trading mode the same bars stay invested overnight", () => {
    const out = runIntraday(bars, { flatAtSessionEnd: false });
    expect(out.summary.totalTrades).toBe(1);
    expect(out.trades[0].reason).toBe("end-of-test");
    expect(out.summary.timeInMarketPct).toBeCloseTo(100, 6);
  });

  it("ignores day-trading mode on daily bars and says so", () => {
    const out = run([100, 101, 102, 103], { flatAtSessionEnd: true });
    expect(out.warnings.some((w) => /Flat-at-session-end was ignored/.test(w))).toBe(true);
    expect(out.trades[0].reason).toBe("end-of-test");
  });
});

// ─── Very volatile prices ──────────────────────────────────────
// A deterministic GME-style series: ±25 % sessions, a doubling gap, and a
// crash. Every metric has to stay finite and correctly bounded on it — this is
// the shape that breaks naive drawdown/Sharpe/annualisation code.
describe("volatile price series", () => {
  const volatileCloses = (() => {
    const out = [10];
    let price = 10;
    for (let i = 0; i < 60; i++) {
      const step = i % 4 === 0 ? 0.25 : i % 4 === 1 ? -0.22 : i % 4 === 2 ? 6 : -0.3;
      price = Math.max(0.5, price * (1 + step));
      out.push(price);
    }
    return out;
  })();

  it("keeps equity, drawdown and the risk profile finite and in range", () => {
    const out = run(volatileCloses, { strategyId: "buy_hold" });
    expect(Number.isFinite(out.summary.finalEquity)).toBe(true);
    expect(out.equityCurve.every((p) => Number.isFinite(p.equity))).toBe(true);
    expect(out.summary.maxDrawdownPct).toBeGreaterThan(0);
    expect(out.summary.maxDrawdownPct).toBeLessThanOrEqual(100);
    expect(Number.isFinite(out.summary.sharpe)).toBe(true);
    expect(Number.isFinite(out.summary.risk.annualVolPct)).toBe(true);
    expect(out.summary.risk.riskFactor).toBeGreaterThanOrEqual(0);
    expect(out.summary.risk.riskFactor).toBeLessThanOrEqual(100);
    expect(["Low", "Moderate", "Elevated", "High"]).toContain(out.summary.risk.riskLevel);
    expect(out.summary.risk.beta).toBeCloseTo(1, 6); // its own benchmark
  });

  it("flags the volatility as a high risk level, not a calm one", () => {
    const out = run(volatileCloses, { strategyId: "buy_hold" });
    expect(out.summary.risk.annualVolPct).toBeGreaterThan(50);
    expect(["Elevated", "High"]).toContain(out.summary.risk.riskLevel);
  });

  it("fills a trailing stop at the open when the bar gaps through it", () => {
    const trailStrategy: StrategyDef = {
      id: "synthetic_gap_trail", name: "Always long", description: "",
      params: [
        { key: "trailAtr", label: "", default: 0 },
        { key: "atrPeriod", label: "", default: 14 },
      ],
      minBars: 2,
      generate: ({ close }) => close.map(() => 1),
    };
    // A steady climb sets the trail high-water near 124 (stop ~120), then the
    // final bar OPENS at 50 — an overnight gap straight through the stop.
    const bars: Bar[] = Array.from({ length: 25 }, (_, i) => {
      const close = 100 + i;
      return {
        date: `2024-02-${String(i + 1).padStart(2, "0")}`,
        open: i === 0 ? 100 : 99 + i,
        high: Math.max(close, 99 + i) + 0.5,
        low: Math.min(close, 99 + i) - 0.5,
        close,
        volume: 1_000_000,
      };
    });
    bars.push({ date: "2024-03-01", open: 50, high: 55, low: 45, close: 52, volume: 5_000_000 });

    const config = baseConfig({ strategyId: "synthetic_gap_trail", params: { trailAtr: 2, atrPeriod: 5 } });
    const out = simulateCore(bars, META, "cache", trailStrategy, resolveCosts(config), config, false);
    const stopped = out.trades.filter((t) => t.reason === "trailing-stop");
    expect(stopped.length).toBe(1);
    // filled at the gapped open (~50), not at the untouched stop level (~120)
    expect(stopped[0].exitPrice).toBeCloseTo(50, 6);
  });

  it("runs the same volatile series weekly without NaNs", () => {
    const dates = Array.from({ length: 120 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000);
      return d.toISOString().slice(0, 10);
    });
    const bars: Bar[] = volatileCloses.slice(0, 120).map((c, i) => ({
      date: dates[i], open: i === 0 ? c : volatileCloses[i - 1], high: Math.max(c, volatileCloses[i - 1] ?? c) * 1.05,
      low: Math.min(c, volatileCloses[i - 1] ?? c) * 0.95, close: c, volume: 1_000_000,
    }));
    const weekly = resampleBars(bars, "weekly");
    const config = baseConfig({ strategyId: "buy_hold", barInterval: "weekly" });
    const out = simulateCore(weekly, META, "cache", STRATEGY, resolveCosts(config), config, false);
    expect(out.summary.barUnit).toBe("week");
    expect(out.summary.periodsPerYear).toBe(52);
    expect(out.equityCurve.every((p) => Number.isFinite(p.equity))).toBe(true);
    expect(Number.isFinite(out.summary.sharpe)).toBe(true);
  });
});

// ─── Risk profile metrics ──────────────────────────────────────
describe("risk profile", () => {
  it("reports beta 1 and benchmark-matching volatility for buy & hold", () => {
    const out = run([100, 104, 101, 108, 103, 112, 118, 111, 120]);
    expect(out.summary.risk.beta).toBeCloseTo(1, 6);
    expect(out.summary.risk.annualVolPct).toBeCloseTo(out.summary.risk.benchmarkVolPct, 6);
    expect(out.summary.risk.riskFactor).toBeGreaterThanOrEqual(0);
    expect(out.summary.risk.riskFactor).toBeLessThanOrEqual(100);
    expect(["Low", "Moderate", "Elevated", "High"]).toContain(out.summary.risk.riskLevel);
    expect(out.summary.tradesPerYear).toBeGreaterThan(0);
  });

  it("a never-invested run has zero risk", () => {
    const never: StrategyDef = {
      id: "synthetic_flat",
      name: "Never long",
      description: "",
      params: [],
      minBars: 2,
      generate: ({ close }) => close.map(() => 0),
    };
    const config = baseConfig({ strategyId: "synthetic_flat" });
    const out = simulateCore(makeBars([100, 100, 100, 100, 100]), META, "cache", never, resolveCosts(config), config, false);
    expect(out.summary.risk.annualVolPct).toBe(0);
    expect(out.summary.risk.beta).toBe(0);
    expect(out.summary.risk.ulcerIndex).toBe(0);
    expect(out.summary.risk.riskFactor).toBe(0);
    expect(out.summary.risk.riskLevel).toBe("Low");
    expect(out.summary.tradesPerYear).toBe(0);
  });
});
